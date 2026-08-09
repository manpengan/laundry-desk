import Foundation

private final class BoundedFileSink: @unchecked Sendable {
  private let lock = NSLock()
  private let handle: FileHandle
  private let maximum: Int64
  private var total: Int64 = 0
  private var failed = false

  init(handle: FileHandle, maximum: Int64) {
    self.handle = handle
    self.maximum = maximum
  }

  func consume(_ source: FileHandle) {
    while true {
      let chunk = source.availableData
      if chunk.isEmpty { break }
      lock.lock()
      total += Int64(chunk.count)
      if total <= maximum && !failed {
        do { try handle.write(contentsOf: chunk) } catch { failed = true }
      }
      lock.unlock()
    }
  }

  var invalid: Bool {
    lock.lock()
    defer { lock.unlock() }
    return failed || total > maximum
  }

  func finish() throws {
    lock.lock()
    defer { lock.unlock() }
    guard !failed, total > 0, total <= maximum else {
      try? handle.close()
      try runtimeFail(total > maximum ? "RUNTIME_STREAM_TOO_LARGE" : "RUNTIME_STREAM_INVALID")
    }
    do {
      try handle.synchronize()
      try handle.close()
    } catch {
      try runtimeFail("RUNTIME_STREAM_INVALID")
    }
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    try? handle.close()
  }
}

extension SystemRuntimeRunner {
  func runStreaming(
    _ spec: RuntimeCommandSpec, stream: RuntimeStreamSpec, accepting: Set<Int32>
  ) throws -> RuntimeCommandResult {
    try validate(spec)
    guard (stream.output != nil) != stream.discardOutput,
      (1...3_600).contains(stream.timeoutSeconds),
      stream.output.map({ $0.maximumBytes > 0 && $0.maximumBytes <= 137_438_953_472 }) ?? true
    else { try runtimeFail("RUNTIME_STREAM_INVALID") }

    let process = configuredProcess(spec)
    let inputHandle = try stream.input.map {
      try RuntimeStorage.openVerifiedPrivateFile(
        $0.url, expectedSize: $0.size, expectedSHA256: $0.sha256)
    }
    let inputVersion = try inputHandle.map {
      guard let input = stream.input else { try runtimeFail("RUNTIME_STREAM_INVALID") }
      return try RuntimeTransferFileVersion(handle: $0, url: input.url)
    }
    process.standardInput = inputHandle ?? FileHandle.nullDevice

    let outputPipe: Pipe?
    let sink: BoundedFileSink?
    if let output = stream.output {
      let handle = try RuntimeStorage.createPrivateStreamFile(output.url)
      let pipe = Pipe()
      outputPipe = pipe
      sink = BoundedFileSink(handle: handle, maximum: output.maximumBytes)
      process.standardOutput = pipe
    } else {
      outputPipe = nil
      sink = nil
      process.standardOutput = FileHandle.nullDevice
    }

    let errorPipe = Pipe()
    process.standardError = errorPipe
    let stderr = CaptureBuffer(maximum: Self.maximumCapture)
    let group = DispatchGroup()
    if let outputPipe, let sink {
      group.enter()
      DispatchQueue.global().async {
        sink.consume(outputPipe.fileHandleForReading)
        group.leave()
      }
    }
    group.enter()
    DispatchQueue.global().async {
      stderr.consume(errorPipe.fileHandleForReading)
      group.leave()
    }

    let completed = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in completed.signal() }
    do { try process.run() } catch {
      try? outputPipe?.fileHandleForWriting.close()
      try? errorPipe.fileHandleForWriting.close()
      group.wait()
      sink?.cancel()
      try? inputHandle?.close()
      try runtimeFail("RUNTIME_COMMAND_FAILED")
    }
    let deadline = DispatchTime.now() + .seconds(stream.timeoutSeconds)
    var stoppedForOutput = false
    while completed.wait(timeout: .now() + .milliseconds(100)) == .timedOut {
      if sink?.invalid == true {
        stoppedForOutput = true
        terminate(process, completed: completed)
        break
      }
      if DispatchTime.now() >= deadline {
        terminate(process, completed: completed)
        group.wait()
        sink?.cancel()
        try? inputHandle?.close()
        try runtimeFail("RUNTIME_COMMAND_TIMEOUT")
      }
    }
    group.wait()
    if let inputHandle, let input = stream.input, let inputVersion {
      do {
        try inputVersion.verify(handle: inputHandle, url: input.url)
        try inputHandle.close()
      } catch {
        try? inputHandle.close()
        sink?.cancel()
        try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID")
      }
    }
    if stoppedForOutput {
      sink?.cancel()
      try runtimeFail("RUNTIME_STREAM_TOO_LARGE")
    }
    try sink?.finish()
    let result = RuntimeCommandResult(
      code: process.terminationStatus, stdout: "", stderr: try stderr.result())
    guard accepting.contains(result.code) else { try runtimeFail("RUNTIME_COMMAND_FAILED") }
    if let output = stream.output {
      try RuntimeStorage.syncParent(of: output.url)
    }
    return result
  }
}
