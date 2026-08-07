#if RUNTIME_TESTING
  import Foundation

  extension FakeRuntimeRunner {
    private func controlledData(_ suffix: String, fallback: String) -> Data {
      (try? Data(contentsOf: URL(fileURLWithPath: logURL.path + suffix))) ?? Data(fallback.utf8)
    }

    private func readInput(_ input: RuntimeStreamInput?) throws -> Data? {
      guard let input else { return nil }
      let handle = try RuntimeStorage.openVerifiedPrivateFile(
        input.url, expectedSize: input.size, expectedSHA256: input.sha256)
      defer { try? handle.close() }
      guard let data = try handle.readToEnd() else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
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
        if spec.arguments.contains("pg_dump") {
          data = controlledData(".fake-database", fallback: "fake-postgres-custom-dump-v1")
        } else if spec.arguments.contains("--create") {
          data = controlledData(".fake-photos", fallback: "fake-photo-tar-v1")
        } else {
          try runtimeFail("RUNTIME_STREAM_INVALID")
        }
        guard !data.isEmpty, Int64(data.count) <= output.maximumBytes else {
          try runtimeFail("RUNTIME_STREAM_TOO_LARGE")
        }
        try RuntimeStorage.writeExclusive(data, to: output.url)
      } else if spec.arguments.contains("pg_restore"), spec.arguments.contains("--clean") {
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
