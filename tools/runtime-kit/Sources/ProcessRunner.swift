import Darwin
import Foundation

struct RuntimeCommandSpec {
  let executable: String
  let arguments: [String]
  let environment: [String: String]
}

struct RuntimeCommandResult {
  let code: Int32
  let stdout: String
  let stderr: String
}

struct RuntimeStreamInput {
  let url: URL
  let size: Int64
  let sha256: String
}

struct RuntimeStreamOutput {
  let url: URL
  let maximumBytes: Int64
}

struct RuntimeStreamSpec {
  let input: RuntimeStreamInput?
  let output: RuntimeStreamOutput?
  let discardOutput: Bool
  let timeoutSeconds: Int
}

protocol RuntimeRunner: AnyObject {
  var dockerPath: String { get }
  func setManifest(_ payload: RuntimeManifestPayload)
  func run(_ spec: RuntimeCommandSpec, accepting: Set<Int32>) throws -> RuntimeCommandResult
  func runStreaming(
    _ spec: RuntimeCommandSpec, stream: RuntimeStreamSpec, accepting: Set<Int32>
  ) throws -> RuntimeCommandResult
}

final class CaptureBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var bytes = Data()
  private var exceeded = false
  private let maximum: Int

  init(maximum: Int) { self.maximum = maximum }

  func consume(_ handle: FileHandle) {
    while true {
      let chunk = handle.availableData
      if chunk.isEmpty { break }
      lock.lock()
      if bytes.count + chunk.count <= maximum { bytes.append(chunk) } else { exceeded = true }
      lock.unlock()
    }
  }

  func result() throws -> String {
    lock.lock()
    defer { lock.unlock() }
    guard !exceeded, let text = String(data: bytes, encoding: .utf8)
    else { try runtimeFail("RUNTIME_COMMAND_OUTPUT_INVALID") }
    return text
  }
}

final class SystemRuntimeRunner: RuntimeRunner {
  let dockerPath: String
  let dockerHost: String
  let allowedExecutables: Set<String>
  static let maximumCapture = 16_384
  static let timeoutSeconds = 120
  static let environmentKeys: Set<String> = [
    "LAUNDRY_RUNTIME_CONFIG_ROOT", "LAUNDRY_RUNTIME_INSTANCE_ID",
    "LAUNDRY_RUNTIME_PGDATA_VOLUME", "LAUNDRY_RUNTIME_PHOTOS_VOLUME",
    "LAUNDRY_RUNTIME_SERVER_IMAGE", "LAUNDRY_RUNTIME_POSTGRES_IMAGE",
    "LAUNDRY_RUNTIME_RELEASE", "LAUNDRY_RUNTIME_CONTRACTS_SHA256",
    "LAUNDRY_RUNTIME_SCHEMA_SHA256", "LAUNDRY_RUNTIME_MIGRATIONS_SHA256",
    "LAUNDRY_RUNTIME_MIGRATION_HEAD",
  ]

  init() throws {
    let candidates = [
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/usr/local/bin/docker", "/opt/homebrew/bin/docker",
    ]
    let manager = FileManager.default
    guard let selected = candidates.first(where: { manager.isExecutableFile(atPath: $0) })
    else { try runtimeFail("RUNTIME_DOCKER_UNAVAILABLE") }
    dockerPath = selected
    dockerHost = try Self.resolveLocalDockerHost()
    allowedExecutables = [selected, "/usr/bin/curl", "/bin/launchctl"]
  }

  #if RUNTIME_TESTING
    init(testDockerPath: String, testSocketCandidates: [String]) throws {
      guard FileManager.default.isExecutableFile(atPath: testDockerPath) else {
        try runtimeFail("RUNTIME_DOCKER_UNAVAILABLE")
      }
      dockerPath = testDockerPath
      dockerHost = try Self.resolveLocalDockerHost(candidates: testSocketCandidates)
      allowedExecutables = [testDockerPath, "/usr/bin/curl", "/bin/launchctl"]
    }
  #endif

  static func resolveLocalDockerHost(candidates: [String]? = nil) throws -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
    let socketCandidates =
      candidates
      ?? [
        URL(fileURLWithPath: home, isDirectory: true)
          .appendingPathComponent(".docker/run/docker.sock").path,
        "/var/run/docker.sock",
      ]
    guard !socketCandidates.isEmpty else { try runtimeFail("RUNTIME_DOCKER_ENDPOINT_INVALID") }
    for candidate in socketCandidates {
      guard candidate.hasPrefix("/"), !candidate.contains("\0"),
        URL(fileURLWithPath: candidate).standardizedFileURL.path == candidate
      else { try runtimeFail("RUNTIME_DOCKER_ENDPOINT_INVALID") }
      var metadata = stat()
      if Darwin.lstat(candidate, &metadata) == 0 {
        if metadata.st_mode & S_IFMT == S_IFSOCK { return "unix://\(candidate)" }
        continue
      }
      if errno != ENOENT { try runtimeFail("RUNTIME_DOCKER_ENDPOINT_INVALID") }
    }
    try runtimeFail("RUNTIME_DOCKER_ENDPOINT_INVALID")
  }

  func setManifest(_ payload: RuntimeManifestPayload) { _ = payload }

  func validate(_ spec: RuntimeCommandSpec) throws {
    guard allowedExecutables.contains(spec.executable), spec.arguments.count <= 64,
      spec.arguments.allSatisfy({ !$0.contains("\0") }),
      Set(spec.environment.keys).isSubset(of: Self.environmentKeys),
      spec.executable != dockerPath
        || spec.arguments.allSatisfy({
          $0 != "--host" && $0 != "-H" && $0 != "--context"
            && !$0.hasPrefix("-H") && !$0.hasPrefix("--host=")
            && !$0.hasPrefix("--context=")
        })
    else { try runtimeFail("RUNTIME_COMMAND_FORBIDDEN") }
  }

  func configuredProcess(_ spec: RuntimeCommandSpec) -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: spec.executable)
    process.arguments =
      spec.executable == dockerPath ? ["--host", dockerHost] + spec.arguments : spec.arguments
    let fixedPath = [
      URL(fileURLWithPath: dockerPath).deletingLastPathComponent().path,
      "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin",
      "/usr/sbin", "/sbin",
    ].joined(separator: ":")
    process.environment = spec.environment.merging([
      "PATH": fixedPath,
      "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
    ]) { current, _ in current }
    return process
  }

  func terminate(_ process: Process, completed: DispatchSemaphore) {
    process.terminate()
    if completed.wait(timeout: .now() + .seconds(5)) == .timedOut {
      Darwin.kill(process.processIdentifier, SIGKILL)
      _ = completed.wait(timeout: .now() + .seconds(5))
    }
  }

  func run(_ spec: RuntimeCommandSpec, accepting: Set<Int32>) throws -> RuntimeCommandResult {
    try validate(spec)
    let process = configuredProcess(spec)
    let output = Pipe()
    let error = Pipe()
    process.standardOutput = output
    process.standardError = error
    let stdout = CaptureBuffer(maximum: Self.maximumCapture)
    let stderr = CaptureBuffer(maximum: Self.maximumCapture)
    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global().async {
      stdout.consume(output.fileHandleForReading)
      group.leave()
    }
    group.enter()
    DispatchQueue.global().async {
      stderr.consume(error.fileHandleForReading)
      group.leave()
    }
    let completed = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in completed.signal() }
    do { try process.run() } catch { try runtimeFail("RUNTIME_COMMAND_FAILED") }
    if completed.wait(timeout: .now() + .seconds(Self.timeoutSeconds)) == .timedOut {
      terminate(process, completed: completed)
      group.wait()
      try runtimeFail("RUNTIME_COMMAND_TIMEOUT")
    }
    group.wait()
    let result = RuntimeCommandResult(
      code: process.terminationStatus,
      stdout: try stdout.result(), stderr: try stderr.result())
    guard accepting.contains(result.code) else { try runtimeFail("RUNTIME_COMMAND_FAILED") }
    return result
  }
}
