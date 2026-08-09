import Darwin
import Foundation

private func defaultRoot() -> URL {
  FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(
      "Library/Application Support/Laundry Desk Runtime",
      isDirectory: true)
}

private func absoluteExecutable() -> String {
  URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
}

private func run() throws {
  guard let resources = Bundle.main.resourceURL else {
    try runtimeFail("RUNTIME_RESOURCES_MISSING")
  }
  var arguments = Array(CommandLine.arguments.dropFirst())
  var root = defaultRoot()
  var testIsolationID: String?
  var testLocalServerImage: String?
  let runner: RuntimeRunner
  #if RUNTIME_TESTING
    if arguments.count >= 4, arguments[0] == "--test-system-config-root",
      arguments[1].hasPrefix("/"), !arguments[1].contains("\0"),
      arguments[2] == "--test-runtime-id",
      arguments[3].range(
        of: "^[a-z0-9]{8,20}$", options: .regularExpression) != nil
    {
      root = URL(fileURLWithPath: arguments[1], isDirectory: true)
      testIsolationID = arguments[3]
      runner = try SystemRuntimeRunner()
      arguments.removeFirst(4)
      if arguments.count >= 2, arguments[0] == "--test-local-server-image",
        arguments[1] == "laundry-runtime-data-test-\(testIsolationID ?? ""):local"
      {
        testLocalServerImage = arguments[1]
        arguments.removeFirst(2)
      }
    } else if arguments.count >= 4, arguments[0] == "--test-config-root",
      arguments[1].hasPrefix("/"), arguments[2] == "--test-runner-log",
      arguments[3].hasPrefix("/")
    {
      root = URL(fileURLWithPath: arguments[1], isDirectory: true)
      runner = FakeRuntimeRunner(logURL: URL(fileURLWithPath: arguments[3]))
      arguments.removeFirst(4)
    } else {
      runner = try SystemRuntimeRunner()
    }
  #else
    runner = try SystemRuntimeRunner()
  #endif
  let version =
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    ?? "0.0.0"
  let controller = NativeRuntimeController(
    paths: .resolve(root: root, resources: resources),
    runner: runner, appVersion: version, testIsolationID: testIsolationID,
    testLocalServerImage: testLocalServerImage)
  if arguments.isEmpty {
    RuntimeGUI.launch(controller: controller, runner: runner, executable: absoluteExecutable())
    return
  }
  var input: Data
  if arguments.first == "install" {
    input = try FileHandle.standardInput.read(upToCount: 4_097) ?? Data()
    guard input.count <= 4_096 else { try runtimeFail("RUNTIME_SETUP_STDIN_INVALID") }
  } else if arguments == ["commission"] {
    input = try FileHandle.standardInput.read(upToCount: 2_049) ?? Data()
    guard input.count <= 2_048 else { try runtimeFail("RUNTIME_COMMISSION_STDIN_INVALID") }
  } else if arguments == ["lan", "configure"] {
    input = try FileHandle.standardInput.read(upToCount: 32_769) ?? Data()
    guard input.count <= 32_768 else { try runtimeFail("RUNTIME_LAN_STDIN_INVALID") }
  } else if arguments.count == 2, arguments[0] == "backup",
    ["verify", "restore"].contains(arguments[1])
  {
    input = try FileHandle.standardInput.read(upToCount: 513) ?? Data()
    guard input.count <= 512 else { try runtimeFail("RUNTIME_BACKUP_STDIN_INVALID") }
  } else if arguments == ["rollback"] {
    input = try FileHandle.standardInput.read(upToCount: 257) ?? Data()
    guard input.count <= 256 else { try runtimeFail("RUNTIME_ROLLBACK_STDIN_INVALID") }
  } else if arguments.count == 2, arguments[0] == "transfer",
    ["export", "inspect", "import"].contains(arguments[1])
  {
    input = try FileHandle.standardInput.read(upToCount: 4_097) ?? Data()
    guard input.count <= 4_096 else { try runtimeFail("RUNTIME_TRANSFER_STDIN_INVALID") }
  } else {
    input =
      Darwin.isatty(STDIN_FILENO) == 1
      ? Data() : (try FileHandle.standardInput.read(upToCount: 1) ?? Data())
    guard input.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
  }
  defer { input.resetBytes(in: input.indices) }
  let output = try RuntimeCLI.run(
    arguments: arguments, stdin: input, controller: controller,
    runner: runner, executable: absoluteExecutable())
  FileHandle.standardOutput.write(Data("\(output)\n".utf8))
}

do { try run() } catch {
  let code = (error as? RuntimeKitError)?.description ?? "RUNTIME_FAILED"
  FileHandle.standardError.write(Data("\(code)\n".utf8))
  exit(1)
}
