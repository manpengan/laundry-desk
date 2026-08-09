#if RUNTIME_TESTING
  import Foundation

  final class FakeRuntimeRunner: RuntimeRunner {
    private struct FailNthControl: Codable {
      let token: String
      let occurrence: Int
    }

    let dockerPath = "/Applications/Docker.app/Contents/Resources/bin/docker"
    let logURL: URL
    let volumesURL: URL
    let commissionRequiredURL: URL
    let lanRunningURL: URL
    private var manifest: RuntimeManifestPayload?

    init(logURL: URL) {
      self.logURL = logURL
      self.volumesURL = URL(fileURLWithPath: logURL.path + ".volumes.json")
      self.commissionRequiredURL = URL(
        fileURLWithPath: logURL.path + ".commission-required")
      self.lanRunningURL = URL(fileURLWithPath: logURL.path + ".lan-running")
    }

    func setManifest(_ payload: RuntimeManifestPayload) { manifest = payload }

    func appendLog(_ spec: RuntimeCommandSpec) throws {
      let body: [String: Any] = [
        "executable": spec.executable,
        "arguments": spec.arguments,
        "environment": spec.environment,
      ]
      let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
      if !FileManager.default.fileExists(atPath: logURL.path) {
        FileManager.default.createFile(
          atPath: logURL.path, contents: nil,
          attributes: [.posixPermissions: 0o600])
      }
      let handle = try FileHandle(forWritingTo: logURL)
      try handle.seekToEnd()
      try handle.write(contentsOf: data + Data([0x0a]))
      try handle.synchronize()
      try handle.close()
    }

    func failOnce(_ spec: RuntimeCommandSpec) -> Bool {
      let control = URL(fileURLWithPath: logURL.path + ".fail-once")
      guard
        let value = try? String(contentsOf: control, encoding: .utf8)
          .trimmingCharacters(in: .whitespacesAndNewlines),
        spec.arguments.contains(value)
      else { return false }
      try? FileManager.default.removeItem(at: control)
      return true
    }

    func failNth(_ spec: RuntimeCommandSpec) -> Bool {
      let control = URL(fileURLWithPath: logURL.path + ".fail-nth.json")
      guard let data = try? Data(contentsOf: control),
        let value = try? JSONDecoder().decode(FailNthControl.self, from: data),
        !value.token.isEmpty, value.occurrence > 0, spec.arguments.contains(value.token)
      else { return false }
      if value.occurrence == 1 {
        try? FileManager.default.removeItem(at: control)
        return true
      }
      let next = FailNthControl(token: value.token, occurrence: value.occurrence - 1)
      if let nextData = try? JSONEncoder().encode(next) {
        try? nextData.write(to: control, options: .atomic)
      }
      return false
    }

    func pauseOnce(_ spec: RuntimeCommandSpec) throws {
      let control = URL(fileURLWithPath: logURL.path + ".pause-once")
      guard
        let value = try? String(contentsOf: control, encoding: .utf8)
          .trimmingCharacters(in: .whitespacesAndNewlines),
        spec.arguments.contains(value)
      else { return }
      try FileManager.default.removeItem(at: control)
      let paused = URL(fileURLWithPath: logURL.path + ".paused")
      let resumed = URL(fileURLWithPath: logURL.path + ".continue")
      try Data("paused\n".utf8).write(to: paused, options: .atomic)
      for _ in 0..<1_000 {
        if FileManager.default.fileExists(atPath: resumed.path) {
          try? FileManager.default.removeItem(at: resumed)
          try? FileManager.default.removeItem(at: paused)
          return
        }
        Thread.sleep(forTimeInterval: 0.01)
      }
      try runtimeFail("RUNTIME_COMMAND_TIMEOUT")
    }

    private func volumes() -> [String: [String: String]] {
      guard let data = try? Data(contentsOf: volumesURL),
        let value = try? JSONDecoder().decode([String: [String: String]].self, from: data)
      else { return [:] }
      return value
    }

    private func createVolume(_ spec: RuntimeCommandSpec) throws -> String {
      guard let name = spec.arguments.last else { try runtimeFail("RUNTIME_COMMAND_FAILED") }
      var labels: [String: String] = [:]
      var index = 2
      while index < spec.arguments.count - 1 {
        if spec.arguments[index] == "--label" {
          let pair = spec.arguments[index + 1].split(separator: "=", maxSplits: 1).map(String.init)
          guard pair.count == 2 else { try runtimeFail("RUNTIME_COMMAND_FAILED") }
          labels = labels.merging([pair[0]: pair[1]]) { _, value in value }
          index += 2
        } else {
          index += 1
        }
      }
      let current = volumes()
      let next =
        current[name] == nil ? current.merging([name: labels]) { value, _ in value } : current
      let data = try JSONEncoder().encode(next)
      try data.write(to: volumesURL, options: .atomic)
      return name
    }

    private func repoDigests(_ payload: RuntimeManifestPayload) -> [String] {
      let control = URL(fileURLWithPath: logURL.path + ".repo-digests.json")
      guard let data = try? Data(contentsOf: control),
        let value = try? JSONDecoder().decode([String].self, from: data)
      else { return [payload.serverImage.index] }
      return value
    }

    private func filteredContainers(_ spec: RuntimeCommandSpec) -> RuntimeCommandResult? {
      guard spec.arguments.starts(with: ["ps", "--all", "--quiet"]),
        spec.arguments.contains("label=com.docker.compose.project=laundry-desk-runtime"),
        spec.arguments.contains("label=com.docker.compose.service=lan-gateway")
      else { return nil }
      let control = URL(fileURLWithPath: logURL.path + ".ps-output")
      let output =
        (try? String(contentsOf: control, encoding: .utf8))
        ?? (try? String(contentsOf: lanRunningURL, encoding: .utf8)) ?? ""
      return .init(code: 0, stdout: output, stderr: "")
    }

    private func lanGatewayStatus(_ spec: RuntimeCommandSpec) -> RuntimeCommandResult? {
      guard spec.arguments.contains("ps"), spec.arguments.contains("lan-gateway") else {
        return nil
      }
      let output = (try? String(contentsOf: lanRunningURL, encoding: .utf8)) ?? ""
      return .init(code: 0, stdout: output, stderr: "")
    }

    private func updateLanLifecycle(_ spec: RuntimeCommandSpec) {
      if spec.arguments.contains("lan-gateway"), spec.arguments.contains("up") {
        try? Data("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n".utf8)
          .write(to: lanRunningURL, options: .atomic)
      }
      if (spec.arguments.contains("lan-gateway") && spec.arguments.contains("rm"))
        || spec.arguments.starts(with: ["rm", "-f"])
      {
        try? FileManager.default.removeItem(at: lanRunningURL)
        try? FileManager.default.removeItem(
          at: URL(fileURLWithPath: logURL.path + ".ps-output"))
      }
    }

    private func commissioningResult(_ spec: RuntimeCommandSpec) -> RuntimeCommandResult? {
      let required = FileManager.default.fileExists(atPath: commissionRequiredURL.path)
      if spec.arguments.contains("commission-status") {
        return .init(
          code: 0,
          stdout: required
            ? #"{"commission_required":true}"# : #"{"commission_required":false}"#,
          stderr: "")
      }
      if spec.arguments.contains("verify-commissioned"), required {
        return .init(code: 1, stdout: "", stderr: "RUNTIME_COMMISSION_REQUIRED")
      }
      if spec.arguments.contains("bootstrap") {
        try? FileManager.default.removeItem(at: commissionRequiredURL)
      }
      if spec.arguments.contains("commission") {
        if !required {
          return .init(code: 1, stdout: "", stderr: "RUNTIME_COMMISSION_CLOSED")
        }
        try? FileManager.default.removeItem(at: commissionRequiredURL)
      }
      return nil
    }

    func run(_ spec: RuntimeCommandSpec, accepting: Set<Int32>) throws -> RuntimeCommandResult {
      try appendLog(spec)
      if failOnce(spec) || failNth(spec) { try runtimeFail("RUNTIME_COMMAND_FAILED") }
      try pauseOnce(spec)
      var result = RuntimeCommandResult(code: 0, stdout: "", stderr: "")
      if let filtered = filteredContainers(spec) {
        result = filtered
      } else if let gateway = lanGatewayStatus(spec) {
        result = gateway
      } else if let commissioning = commissioningResult(spec) {
        result = commissioning
      } else if spec.arguments.starts(with: ["volume", "inspect"]) {
        if let name = spec.arguments.last, let labels = volumes()[name] {
          let data = try JSONEncoder().encode(labels)
          result = .init(code: 0, stdout: String(decoding: data, as: UTF8.self), stderr: "")
        } else {
          result = .init(code: 1, stdout: "", stderr: "")
        }
      } else if spec.arguments.starts(with: ["volume", "create"]) {
        result = .init(code: 0, stdout: try createVolume(spec), stderr: "")
      } else if spec.arguments.starts(with: ["image", "inspect"]),
        spec.arguments.contains("{{json .Architecture}}")
      {
        result = .init(code: 0, stdout: #""arm64""#, stderr: "")
      } else if spec.arguments.starts(with: ["image", "inspect"]),
        spec.arguments.contains("{{json .RepoDigests}}"), let payload = manifest
      {
        let data = try JSONEncoder().encode(repoDigests(payload))
        result = .init(code: 0, stdout: String(decoding: data, as: UTF8.self), stderr: "")
      } else if spec.arguments.starts(with: ["image", "inspect"]), let payload = manifest {
        let labels: [String: Any] = [
          "com.laundry-desk.runtime.release": payload.release,
          "com.laundry-desk.runtime.contracts-major": String(payload.contractsMajor),
          "com.laundry-desk.runtime.contracts-sha256": payload.contractsSHA256,
          "com.laundry-desk.runtime.server-version": payload.serverVersion,
          "com.laundry-desk.runtime.web-bundle-sha256": payload.webBundleSHA256,
          "com.laundry-desk.runtime.schema-sha256": payload.databaseSchemaSHA256,
          "com.laundry-desk.runtime.migrations-sha256": payload.migrationsSHA256,
          "com.laundry-desk.runtime.migration-head": payload.migrationHead,
        ]
        let data = try JSONSerialization.data(withJSONObject: labels, options: [.sortedKeys])
        result = .init(code: 0, stdout: String(decoding: data, as: UTF8.self), stderr: "")
      } else if spec.executable == "/usr/bin/curl" {
        result = .init(code: 0, stdout: #"{"ok":true,"data":{"status":"ready"}}"#, stderr: "")
      } else if spec.arguments.contains("/bin/df") {
        result = .init(
          code: 0,
          stdout:
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 2147483648 0 1073741824 0% /var/lib/postgresql/data\n",
          stderr: "")
      } else if spec.arguments.contains("ps") {
        result = .init(code: 0, stdout: "[]", stderr: "")
      }
      guard accepting.contains(result.code) else { try runtimeFail("RUNTIME_COMMAND_FAILED") }
      updateLanLifecycle(spec)
      return result
    }
  }
#endif
