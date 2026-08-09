import Foundation

extension NativeRuntimeController {
  func installLaunchAgent(executable: String) throws -> String {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      return try RuntimeLaunchAgent.install(executable: executable, runner: runner)
    }
  }

  func uninstallLaunchAgent() throws -> String {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      return try RuntimeLaunchAgent.uninstall(runner: runner)
    }
  }
}
