import Darwin
import Foundation
import Security

struct RuntimePaths {
  let root: URL
  let secrets: URL
  let state: URL
  let manifest: URL
  let compose: URL
  let trustedKey: URL

  static func resolve(root: URL, resources: URL) -> RuntimePaths {
    RuntimePaths(
      root: root,
      secrets: root.appendingPathComponent("secrets", isDirectory: true),
      state: root.appendingPathComponent("state.json"),
      manifest: root.appendingPathComponent("runtime-manifest.json"),
      compose: resources.appendingPathComponent("docker-compose.runtime.yml"),
      trustedKey: resources.appendingPathComponent("trusted-manifest-public-key.txt")
    )
  }
}

enum RuntimeStorage {
  static let longLivedSecrets = [
    "postgres-password", "app-password", "access-token-secret", "csrf-proof-secret",
    "database-url", "database-admin-url",
  ]
  static let bootstrapSecrets = [
    "bootstrap-admin-username", "bootstrap-admin-display-name",
    "bootstrap-admin-password", "bootstrap-admin-pin",
  ]
  static let allSecrets = longLivedSecrets + bootstrapSecrets

  private static func metadata(_ path: String) -> stat? {
    var value = stat()
    return Darwin.lstat(path, &value) == 0 ? value : nil
  }

  private static func isMode(_ value: stat, type: mode_t, permissions: mode_t) -> Bool {
    (value.st_mode & S_IFMT) == type && (value.st_mode & 0o777) == permissions
  }

  private static func fsyncDirectory(_ url: URL) throws {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
  }

  static func ensureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(
      at: url, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    guard let value = metadata(url.path), isMode(value, type: S_IFDIR, permissions: 0o700)
    else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
    try fsyncDirectory(url)
  }

  static func validateDirectory(_ url: URL) throws {
    guard let value = metadata(url.path), isMode(value, type: S_IFDIR, permissions: 0o700)
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
  }

  static func readPrivate(_ url: URL, maximum: Int = 65_536) throws -> Data {
    guard let pathBefore = metadata(url.path) else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    defer { Darwin.close(descriptor) }
    var before = stat()
    guard Darwin.fstat(descriptor, &before) == 0,
      isMode(before, type: S_IFREG, permissions: 0o600), before.st_nlink == 1,
      before.st_dev == pathBefore.st_dev, before.st_ino == pathBefore.st_ino,
      before.st_size > 0, before.st_size <= maximum
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    guard let data = try handle.readToEnd(), data.count == Int(before.st_size)
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    var after = stat()
    guard Darwin.fstat(descriptor, &after) == 0,
      let pathAfter = metadata(url.path), after.st_nlink == 1,
      before.st_dev == after.st_dev, before.st_ino == after.st_ino,
      before.st_size == after.st_size,
      before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
      before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
      after.st_dev == pathAfter.st_dev, after.st_ino == pathAfter.st_ino
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    return data
  }

  static func readBounded(_ url: URL, maximum: Int = 65_536) throws -> Data {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    defer { Darwin.close(descriptor) }
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0, (value.st_mode & S_IFMT) == S_IFREG,
      value.st_nlink == 1, value.st_size > 0, value.st_size <= maximum
    else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    guard let data = try handle.readToEnd(), data.count == Int(value.st_size)
    else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    return data
  }

  static func writeExclusive(_ data: Data, to url: URL) throws {
    let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
    var offset = 0
    let result = data.withUnsafeBytes { bytes -> Bool in
      guard let base = bytes.baseAddress else { return data.isEmpty }
      while offset < data.count {
        let count = Darwin.write(descriptor, base.advanced(by: offset), data.count - offset)
        if count <= 0 { return false }
        offset += count
      }
      return Darwin.fsync(descriptor) == 0
    }
    Darwin.close(descriptor)
    guard result else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
    try fsyncDirectory(url.deletingLastPathComponent())
  }

  static func atomicWrite(_ data: Data, to url: URL) throws {
    let temporary = url.deletingLastPathComponent()
      .appendingPathComponent(".\(url.lastPathComponent).\(try randomToken()).tmp")
    try writeExclusive(data, to: temporary)
    guard Darwin.rename(temporary.path, url.path) == 0 else {
      Darwin.unlink(temporary.path)
      try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
    }
    try fsyncDirectory(url.deletingLastPathComponent())
  }

  static func randomToken(bytes: Int = 32) throws -> String {
    var buffer = [UInt8](repeating: 0, count: bytes)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes, &buffer) == errSecSuccess
    else { try runtimeFail("RUNTIME_RANDOM_FAILED") }
    return Data(buffer).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func validateSecrets(_ root: URL, phase: String) throws {
    let entries = try FileManager.default.contentsOfDirectory(atPath: root.path)
    let required = phase == "prepared" ? allSecrets : longLivedSecrets
    let allowed = phase == "finalizing" ? allSecrets : required
    guard required.allSatisfy(entries.contains), entries.allSatisfy(allowed.contains),
      phase == "finalizing" || entries.count == required.count
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    for name in entries {
      _ = try readPrivate(root.appendingPathComponent(name), maximum: 16_384)
    }
  }

  static func removeBootstrapSecrets(_ root: URL) throws {
    for name in bootstrapSecrets {
      let path = root.appendingPathComponent(name).path
      if Darwin.unlink(path) != 0 && errno != ENOENT {
        try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
      }
    }
    try fsyncDirectory(root)
  }

  static func buildSecrets(_ setup: RuntimeSetup) throws -> [String: String] {
    let postgres = try randomToken()
    let app = try randomToken()
    return [
      "postgres-password": postgres,
      "app-password": app,
      "access-token-secret": try randomToken(),
      "csrf-proof-secret": try randomToken(),
      "database-url": "postgresql://laundry_app:\(app)@postgres:5432/laundry_v2",
      "database-admin-url": "postgresql://postgres:\(postgres)@postgres:5432/laundry_v2",
      "bootstrap-admin-username": setup.adminUsername,
      "bootstrap-admin-display-name": setup.adminDisplayName,
      "bootstrap-admin-password": setup.adminPassword,
      "bootstrap-admin-pin": setup.adminPin,
    ]
  }
}
