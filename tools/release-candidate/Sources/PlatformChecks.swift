import Foundation

private func runSystem(_ executable: String, _ arguments: [String]) throws -> String {
  let process = Process()
  let pipe = Pipe()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = arguments
  process.currentDirectoryURL = URL(fileURLWithPath: "/")
  process.environment = [:]
  process.standardOutput = pipe
  process.standardError = pipe
  do {
    try process.run()
  } catch {
    try fail("RC_PLATFORM_CHECK_FAILED")
  }
  let output = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  guard output.count <= 1024 * 1024, process.terminationReason == .exit,
    process.terminationStatus == 0
  else { try fail("RC_PLATFORM_CHECK_FAILED") }
  return String(data: output, encoding: .utf8) ?? ""
}

private func bundleMetadata(_ appPath: String) throws -> (String, String) {
  let path = appPath + "/Contents/Info.plist"
  let bytes = try readRealFile(path, maximum: 1024 * 1024)
  let value: Any
  do {
    value = try PropertyListSerialization.propertyList(from: bytes, options: [], format: nil)
  } catch {
    try fail("RC_APP_IDENTITY_INVALID")
  }
  guard let object = value as? [String: Any],
    let identifier = object["CFBundleIdentifier"] as? String,
    let version = object["CFBundleShortVersionString"] as? String,
    matches(identifier, "[A-Za-z0-9][A-Za-z0-9.-]{0,127}"),
    matches(version, semverPattern)
  else { try fail("RC_APP_IDENTITY_INVALID") }
  return (identifier, version)
}

private func teamIdentifier(_ output: String) throws -> String {
  let values = output.split(whereSeparator: \.isNewline).compactMap { line -> String? in
    let prefix = "TeamIdentifier="
    return line.hasPrefix(prefix) ? String(line.dropFirst(prefix.count)) : nil
  }
  guard values.count == 1, let team = values.first, matches(team, teamPattern) else {
    try fail("RC_APP_IDENTITY_INVALID")
  }
  return team
}

private func verifyApplication(
  _ path: String,
  identifier: String,
  version: String,
  team: String?
) throws -> String {
  _ = try canonicalPath(path, "RC_APP_PATH_INVALID")
  _ = try runSystem("/usr/bin/codesign", ["--verify", "--deep", "--strict", path])
  _ = try runSystem("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", path])
  _ = try runSystem("/usr/bin/xcrun", ["stapler", "validate", path])
  let displayed = try runSystem(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", "--requirements", "-", path]
  )
  let metadata = try bundleMetadata(path)
  let actualTeam = try teamIdentifier(displayed)
  guard metadata.0 == identifier, metadata.1 == version, team == nil || team == actualTeam else {
    try fail("RC_APP_IDENTITY_INVALID")
  }
  return actualTeam
}

private func verifyDiskImage(_ path: String) throws {
  _ = try runSystem("/usr/bin/xcrun", ["stapler", "validate", path])
  _ = try runSystem(
    "/usr/sbin/spctl",
    ["--assess", "--type", "open", "--context", "context:primary-signature", path]
  )
}

private func ownApplicationPath() throws -> String {
  let executable = try canonicalPath(CommandLine.arguments[0], "RC_SELF_PATH_INVALID")
  let macOS = (executable as NSString).deletingLastPathComponent
  guard (macOS as NSString).lastPathComponent == "MacOS" else {
    try fail("RC_SELF_PATH_INVALID")
  }
  let contents = (macOS as NSString).deletingLastPathComponent
  guard (contents as NSString).lastPathComponent == "Contents" else {
    try fail("RC_SELF_PATH_INVALID")
  }
  let app = (contents as NSString).deletingLastPathComponent
  guard app.hasSuffix(".app") else { try fail("RC_SELF_PATH_INVALID") }
  return app
}

func verifyPlatform(root: String, release: ReleaseAuthority) throws {
  #if RUNTIME_TESTING
    _ = root
    _ = release
  #else
    let ownPath = try ownApplicationPath()
    let expectedOwnPath = try packageFile(root, release.verifier.app.path)
    guard ownPath == expectedOwnPath else { try fail("RC_SELF_PATH_MISMATCH") }
    let ownTeam = try verifyApplication(
      ownPath,
      identifier: release.verifier.bundleIdentifier,
      version: release.productVersion,
      team: release.verifier.teamIdentifier
    )
    let architectures = try runSystem(
      "/usr/bin/lipo",
      ["-archs", ownPath + "/Contents/MacOS/Laundry Desk Release Candidate Verifier"]
    ).split(whereSeparator: \.isWhitespace).map(String.init).sorted()
    guard architectures == ["arm64", "x86_64"] else { try fail("RC_VERIFIER_NOT_UNIVERSAL") }
    let counterTeam = try verifyApplication(
      try packageFile(root, release.counter.app.path),
      identifier: release.counter.bundleIdentifier,
      version: release.productVersion,
      team: ownTeam
    )
    let runtimeTeam = try verifyApplication(
      try packageFile(root, release.runtime.app.path),
      identifier: release.runtime.bundleIdentifier,
      version: release.productVersion,
      team: ownTeam
    )
    guard counterTeam == ownTeam, runtimeTeam == ownTeam else {
      try fail("RC_TEAM_IDENTIFIER_MISMATCH")
    }
    try verifyDiskImage(packageFile(root, release.counter.dmg.path))
    try verifyDiskImage(packageFile(root, release.runtime.dmg.path))
  #endif
}
