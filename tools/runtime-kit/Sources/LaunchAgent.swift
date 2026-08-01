import Darwin
import Foundation

enum RuntimeLaunchAgent {
  private static let label = "com.laundry-desk.runtime"

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

  private static func locations() throws -> (URL, String) {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let agents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    try FileManager.default.createDirectory(
      at: agents, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o755])
    return (agents.appendingPathComponent("\(label).plist"), "gui/\(getuid())")
  }

  static func install(executable: String, runner: RuntimeRunner) throws -> String {
    let standardized = URL(fileURLWithPath: executable).standardizedFileURL
    let canonical = standardized.resolvingSymlinksInPath()
    var metadata = stat()
    guard executable.hasPrefix("/"), !executable.contains("\0"),
      standardized.path == canonical.path,
      canonical.path.hasSuffix("/Laundry Desk Runtime.app/Contents/MacOS/Laundry Desk Runtime"),
      Darwin.lstat(canonical.path, &metadata) == 0,
      (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_nlink == 1,
      FileManager.default.isExecutableFile(atPath: canonical.path)
    else { try runtimeFail("RUNTIME_LAUNCHD_PATH_INVALID") }
    let (path, domain) = try locations()
    try RuntimeStorage.atomicWrite(plist(executable: canonical.path, log: "/dev/null"), to: path)
    _ = try runner.run(
      RuntimeCommandSpec(
        executable: "/bin/launchctl",
        arguments: ["bootout", domain, path.path], environment: [:]), accepting: [0, 3, 5])
    _ = try runner.run(
      RuntimeCommandSpec(
        executable: "/bin/launchctl",
        arguments: ["bootstrap", domain, path.path], environment: [:]), accepting: [0])
    return path.path
  }

  static func uninstall(runner: RuntimeRunner) throws -> String {
    let (path, domain) = try locations()
    _ = try runner.run(
      RuntimeCommandSpec(
        executable: "/bin/launchctl",
        arguments: ["bootout", domain, path.path], environment: [:]), accepting: [0, 3, 5])
    if FileManager.default.fileExists(atPath: path.path) {
      try FileManager.default.removeItem(at: path)
    }
    return path.path
  }
}
