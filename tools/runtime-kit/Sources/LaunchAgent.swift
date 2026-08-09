import Darwin
import Foundation

enum RuntimeLaunchAgent {
  private static let label = "com.laundry-desk.runtime"
  private static let maintenanceLabel = "com.laundry-desk.runtime.maintenance"
  private static let transactionName = "com.laundry-desk.runtime.transaction.json"

  private static func xml(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&apos;")
  }

  private static func plist(executable: String, log: String) -> Data {
    Data(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>Label</key><string>\(label)</string>
        <key>ProgramArguments</key><array>
          <string>\(xml(executable))</string><string>start</string>
        </array>
        <key>RunAtLoad</key><true/>
        <key>StandardOutPath</key><string>\(xml(log))</string>
        <key>StandardErrorPath</key><string>\(xml(log))</string>
      </dict></plist>
      """.utf8)
  }

  private static func maintenancePlist(executable: String) -> Data {
    Data(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>Label</key><string>\(maintenanceLabel)</string>
        <key>ProgramArguments</key><array>
          <string>\(xml(executable))</string><string>maintenance</string>
        </array>
        <key>StartCalendarInterval</key><dict>
          <key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer>
        </dict>
        <key>StandardOutPath</key><string>/dev/null</string>
        <key>StandardErrorPath</key><string>/dev/null</string>
      </dict></plist>
      """.utf8)
  }

  private static func locations() throws -> (URL, URL, URL, String) {
    #if RUNTIME_TESTING
      let home =
        ProcessInfo.processInfo.environment["HOME"].map {
          URL(fileURLWithPath: $0, isDirectory: true)
        } ?? FileManager.default.homeDirectoryForCurrentUser
    #else
      let home = FileManager.default.homeDirectoryForCurrentUser
    #endif
    let agents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    try FileManager.default.createDirectory(
      at: agents, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o755])
    return (
      agents.appendingPathComponent("\(label).plist"),
      agents.appendingPathComponent("\(maintenanceLabel).plist"),
      agents.appendingPathComponent(transactionName), "gui/\(getuid())"
    )
  }

  private static func writePhase(_ phase: String, to transaction: URL) throws {
    let data = try JSONSerialization.data(
      withJSONObject: ["phase": phase, "version": 1], options: [.sortedKeys])
    try RuntimeStorage.atomicWrite(data, to: transaction)
  }

  private static func bootout(
    _ item: URL, domain: String, runner: RuntimeRunner
  ) throws {
    _ = try runner.run(
      RuntimeCommandSpec(
        executable: "/bin/launchctl",
        arguments: ["bootout", domain, item.path], environment: [:]),
      accepting: [0, 3, 5])
  }

  private static func cleanTransaction(
    paths: [URL], transaction: URL, domain: String, runner: RuntimeRunner
  ) throws {
    var failure: Error?
    for item in paths.reversed() {
      do { try bootout(item, domain: domain, runner: runner) } catch {
        failure = failure ?? error
      }
      do { try RuntimeStorage.removePrivateFile(item) } catch {
        failure = failure ?? error
      }
    }
    if failure != nil { try runtimeFail("RUNTIME_LAUNCHD_RECOVERY_REQUIRED") }
    try RuntimeStorage.removePrivateFile(transaction)
  }

  private static func recoverTransaction(
    paths: [URL], transaction: URL, domain: String, runner: RuntimeRunner
  ) throws {
    guard RuntimeStorage.pathExists(transaction) else { return }
    let data = try RuntimeStorage.readPrivate(transaction, maximum: 1_024)
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["phase", "version"], object["version"] as? Int == 1,
      let phase = object["phase"] as? String,
      ["installing", "files_written", "primary_bootstrapped", "uninstalling"].contains(phase)
    else { try runtimeFail("RUNTIME_LAUNCHD_RECOVERY_REQUIRED") }
    try cleanTransaction(
      paths: paths, transaction: transaction, domain: domain, runner: runner)
  }

  static func install(executable: String, runner: RuntimeRunner) throws -> String {
    let standardized = URL(fileURLWithPath: executable).standardizedFileURL
    let canonical = standardized.resolvingSymlinksInPath()
    var metadata = stat()
    #if RUNTIME_TESTING
      let acceptedBundleSuffixes = [
        "/Laundry Desk Runtime.app/Contents/MacOS/Laundry Desk Runtime",
        "/Laundry Desk Runtime Test.app/Contents/MacOS/Laundry Desk Runtime",
      ]
    #else
      let acceptedBundleSuffixes = [
        "/Laundry Desk Runtime.app/Contents/MacOS/Laundry Desk Runtime"
      ]
    #endif
    guard executable.hasPrefix("/"), !executable.contains("\0"),
      standardized.path == canonical.path,
      acceptedBundleSuffixes.contains(where: canonical.path.hasSuffix),
      Darwin.lstat(canonical.path, &metadata) == 0,
      (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_nlink == 1,
      FileManager.default.isExecutableFile(atPath: canonical.path)
    else { try runtimeFail("RUNTIME_LAUNCHD_PATH_INVALID") }
    let (path, maintenancePath, transaction, domain) = try locations()
    let items = [path, maintenancePath]
    try recoverTransaction(
      paths: items, transaction: transaction, domain: domain, runner: runner)
    do {
      try writePhase("installing", to: transaction)
      try RuntimeStorage.atomicWrite(
        plist(executable: canonical.path, log: "/dev/null"), to: path)
      try RuntimeStorage.atomicWrite(
        maintenancePlist(executable: canonical.path), to: maintenancePath)
      try writePhase("files_written", to: transaction)
      for (index, item) in items.enumerated() {
        try bootout(item, domain: domain, runner: runner)
        _ = try runner.run(
          RuntimeCommandSpec(
            executable: "/bin/launchctl",
            arguments: ["bootstrap", domain, item.path], environment: [:]), accepting: [0])
        if index == 0 { try writePhase("primary_bootstrapped", to: transaction) }
      }
      try RuntimeStorage.removePrivateFile(transaction)
    } catch {
      let failure = error
      do {
        try cleanTransaction(
          paths: items, transaction: transaction, domain: domain, runner: runner)
      } catch { throw error }
      throw failure
    }
    return path.path
  }

  static func uninstall(runner: RuntimeRunner) throws -> String {
    let (path, maintenancePath, transaction, domain) = try locations()
    let items = [path, maintenancePath]
    try recoverTransaction(
      paths: items, transaction: transaction, domain: domain, runner: runner)
    try writePhase("uninstalling", to: transaction)
    try cleanTransaction(
      paths: items, transaction: transaction, domain: domain, runner: runner)
    return path.path
  }
}
