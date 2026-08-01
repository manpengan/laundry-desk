import Foundation

enum RuntimeCLI {
  private static func manifestURL(_ arguments: [String], command: String) throws -> URL {
    guard arguments.count == 3, arguments[0] == command, arguments[1] == "--manifest",
      arguments[2].hasPrefix("/"), !arguments[2].contains("\0")
    else { try runtimeFail("RUNTIME_ARGS_INVALID") }
    return URL(fileURLWithPath: arguments[2]).standardizedFileURL
  }

  private static func setup(_ data: Data) throws -> RuntimeSetup {
    guard !data.isEmpty, data.count <= 4_096,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["adminUsername", "adminDisplayName", "adminPassword", "adminPin"],
      let value = try? JSONDecoder().decode(RuntimeSetup.self, from: data)
    else { try runtimeFail("RUNTIME_SETUP_STDIN_INVALID") }
    return value
  }

  private static func output(
    _ status: String, release: String? = nil,
    path: String? = nil
  ) throws -> String {
    var value: [String: String] = ["status": status]
    if let release { value["release"] = release }
    if let path { value["path"] = path }
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
  }

  static func run(
    arguments: [String], stdin: Data, controller: NativeRuntimeController,
    runner: RuntimeRunner, executable: String
  ) throws -> String {
    guard let command = arguments.first else { try runtimeFail("RUNTIME_ARGS_INVALID") }
    if command == "install" {
      let release = try controller.install(
        manifestURL: manifestURL(arguments, command: command),
        setup: setup(stdin))
      return try output("ready", release: release)
    }
    if command == "recover" {
      let release = try controller.recover(manifestURL: manifestURL(arguments, command: command))
      return try output("ready", release: release)
    }
    if ["start", "stop", "restart", "status", "diagnose"].contains(command) {
      guard arguments.count == 1, stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      if command == "start" { return try output("ready", release: controller.start()) }
      if command == "stop" { return try output("stopped", release: controller.stop()) }
      if command == "restart" { return try output("ready", release: controller.restart()) }
      let data = try JSONEncoder().encode(controller.diagnose())
      return String(decoding: data, as: UTF8.self)
    }
    if command == "launchd" {
      guard arguments.count == 2, stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      if arguments[1] == "install" {
        return try output(
          "installed",
          path: RuntimeLaunchAgent.install(
            executable: executable,
            runner: runner))
      }
      if arguments[1] == "uninstall" {
        return try output("uninstalled", path: RuntimeLaunchAgent.uninstall(runner: runner))
      }
    }
    try runtimeFail("RUNTIME_ARGS_INVALID")
  }
}
