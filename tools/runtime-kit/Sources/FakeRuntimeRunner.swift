#if RUNTIME_TESTING
  import Foundation

  final class FakeRuntimeRunner: RuntimeRunner {
    let dockerPath = "/Applications/Docker.app/Contents/Resources/bin/docker"
    private let logURL: URL
    private let volumesURL: URL
    private var manifest: RuntimeManifestPayload?

    init(logURL: URL) {
      self.logURL = logURL
      self.volumesURL = URL(fileURLWithPath: logURL.path + ".volumes.json")
    }

    func setManifest(_ payload: RuntimeManifestPayload) { manifest = payload }

    private func appendLog(_ spec: RuntimeCommandSpec) throws {
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

    private func failOnce(_ spec: RuntimeCommandSpec) -> Bool {
      let control = URL(fileURLWithPath: logURL.path + ".fail-once")
      guard
        let value = try? String(contentsOf: control, encoding: .utf8)
          .trimmingCharacters(in: .whitespacesAndNewlines),
        spec.arguments.contains(value)
      else { return false }
      try? FileManager.default.removeItem(at: control)
      return true
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

    func run(_ spec: RuntimeCommandSpec, accepting: Set<Int32>) throws -> RuntimeCommandResult {
      try appendLog(spec)
      if failOnce(spec) { try runtimeFail("RUNTIME_COMMAND_FAILED") }
      var result = RuntimeCommandResult(code: 0, stdout: "", stderr: "")
      if spec.arguments.starts(with: ["volume", "inspect"]) {
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
      } else if spec.arguments.contains("ps") {
        result = .init(code: 0, stdout: "[]", stderr: "")
      }
      guard accepting.contains(result.code) else { try runtimeFail("RUNTIME_COMMAND_FAILED") }
      return result
    }
  }
#endif
