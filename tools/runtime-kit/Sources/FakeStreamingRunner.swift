#if RUNTIME_TESTING
  import Darwin
  import Foundation

  extension FakeRuntimeRunner {
    private func mutateStreamInputIfRequested(_ input: RuntimeStreamInput, data: Data) throws {
      let control = URL(fileURLWithPath: logURL.path + ".mutate-stream-input-once")
      guard
        let mode = try? String(contentsOf: control, encoding: .utf8)
          .trimmingCharacters(in: .whitespacesAndNewlines)
      else { return }
      try FileManager.default.removeItem(at: control)
      if mode == "rewrite", !data.isEmpty {
        var changed = data
        changed[changed.startIndex] ^= 0xff
        let writer = try FileHandle(forWritingTo: input.url)
        try writer.write(contentsOf: changed)
        try writer.synchronize()
        try writer.close()
      } else if mode == "replace" {
        let replacement = input.url.deletingLastPathComponent()
          .appendingPathComponent(".stream-replacement")
        try RuntimeStorage.writeExclusive(data, to: replacement)
        guard Darwin.rename(replacement.path, input.url.path) == 0 else {
          try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID")
        }
      } else {
        try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID")
      }
    }

    private func controlledData(_ suffix: String, fallback: String) -> Data {
      (try? Data(contentsOf: URL(fileURLWithPath: logURL.path + suffix))) ?? Data(fallback.utf8)
    }

    private func readInput(_ input: RuntimeStreamInput?) throws -> Data? {
      guard let input else { return nil }
      let handle = try RuntimeStorage.openVerifiedPrivateFile(
        input.url, expectedSize: input.size, expectedSHA256: input.sha256)
      let version = try RuntimeTransferFileVersion(handle: handle, url: input.url)
      guard let data = try handle.readToEnd() else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
      try mutateStreamInputIfRequested(input, data: data)
      do {
        try version.verify(handle: handle, url: input.url)
        try handle.close()
      } catch {
        try? handle.close()
        try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID")
      }
      return data
    }

    func runStreaming(
      _ spec: RuntimeCommandSpec, stream: RuntimeStreamSpec, accepting: Set<Int32>
    ) throws -> RuntimeCommandResult {
      try appendLog(spec)
      if failOnce(spec) { try runtimeFail("RUNTIME_COMMAND_FAILED") }
      try pauseOnce(spec)
      guard (stream.output != nil) != stream.discardOutput,
        (1...3_600).contains(stream.timeoutSeconds)
      else { try runtimeFail("RUNTIME_STREAM_INVALID") }
      let input = try readInput(stream.input)
      if let output = stream.output {
        let data: Data
        if spec.arguments.contains(where: { $0.contains("FROM public.garment_photos") }) {
          data = controlledData(".fake-database-photo-inventory", fallback: "[]")
        } else if spec.arguments.contains(where: { $0.contains("crypto.createHash('sha256')") }) {
          data = controlledData(".fake-volume-photo-inventory", fallback: "[]")
        } else if spec.arguments.contains("pg_dump") {
          data = controlledData(".fake-database", fallback: "fake-postgres-custom-dump-v1")
        } else if spec.arguments.contains("/usr/bin/pg_restore"),
          spec.arguments.contains("--list")
        {
          data = controlledData(
            ".fake-database-list", fallback: "RUNTIME_FAKE_DATABASE_LIST_V1\n")
        } else if spec.arguments.contains("/usr/bin/pg_restore"),
          spec.arguments.contains("--data-only")
        {
          data = controlledData(
            ".fake-database-data", fallback: "RUNTIME_FAKE_DATABASE_DATA_V1\n")
        } else if spec.arguments.contains("--create") {
          data = controlledData(".fake-photos", fallback: "fake-photo-tar-v1")
        } else {
          try runtimeFail("RUNTIME_STREAM_INVALID")
        }
        guard !data.isEmpty, Int64(data.count) <= output.maximumBytes else {
          try runtimeFail("RUNTIME_STREAM_TOO_LARGE")
        }
        try RuntimeStorage.writeExclusive(data, to: output.url)
      } else if spec.arguments.contains("psql"),
        spec.arguments.contains("--username=laundry_restore")
      {
        guard let input else { try runtimeFail("RUNTIME_STREAM_INVALID") }
        try RuntimeStorage.atomicWrite(
          input, to: URL(fileURLWithPath: logURL.path + ".restored-database"))
      } else if spec.arguments.contains("--extract") {
        guard let input else { try runtimeFail("RUNTIME_STREAM_INVALID") }
        try RuntimeStorage.atomicWrite(
          input, to: URL(fileURLWithPath: logURL.path + ".restored-photos"))
      }
      let result = RuntimeCommandResult(code: 0, stdout: "", stderr: "")
      guard accepting.contains(result.code) else { try runtimeFail("RUNTIME_COMMAND_FAILED") }
      return result
    }
  }
#endif
