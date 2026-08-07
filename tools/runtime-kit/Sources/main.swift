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
  let runner: RuntimeRunner
  #if RUNTIME_TESTING
    if arguments.count >= 4, arguments[0] == "--test-config-root",
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
    runner: runner, appVersion: version)
  if arguments.isEmpty {
    RuntimeGUI.launch(controller: controller, runner: runner, executable: absoluteExecutable())
    return
  }
  let input: Data
  if arguments.first == "install" {
    input = try FileHandle.standardInput.read(upToCount: 4_097) ?? Data()
    guard input.count <= 4_096 else { try runtimeFail("RUNTIME_SETUP_STDIN_INVALID") }
  } else if arguments.count == 2, arguments[0] == "backup",
    ["verify", "restore"].contains(arguments[1])
  {
    input = try FileHandle.standardInput.read(upToCount: 513) ?? Data()
    guard input.count <= 512 else { try runtimeFail("RUNTIME_BACKUP_STDIN_INVALID") }
  } else {
    input = Data()
  }
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
