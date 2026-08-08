import CryptoKit
import Darwin
import Foundation
import Security

struct RuntimePrivateFileDigest {
  let size: Int64
  let sha256: String
}

struct RuntimePaths {
  let root: URL
  let secrets: URL
  let state: URL
  let manifest: URL
  let releaseHistory: URL
  let previousManifest: URL
  let pendingManifest: URL
  let transition: URL
  let compose: URL
  let trustedKey: URL

  static func resolve(root: URL, resources: URL) -> RuntimePaths {
    RuntimePaths(
      root: root,
      secrets: root.appendingPathComponent("secrets", isDirectory: true),
      state: root.appendingPathComponent("state.json"),
      manifest: root.appendingPathComponent("runtime-manifest.json"),
      releaseHistory: root.appendingPathComponent("release-history.json"),
      previousManifest: root.appendingPathComponent("previous-runtime-manifest.json"),
      pendingManifest: root.appendingPathComponent("pending-runtime-manifest.json"),
      transition: root.appendingPathComponent("release-transition.json"),
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

  #if RUNTIME_TESTING
    private static var testingAtomicWriteCounts: [String: Int] = [:]
    private static var testingRemoveCounts: [String: Int] = [:]

    private static func crashAfterAtomicWriteIfRequested(_ url: URL) {
      let name = url.lastPathComponent
      let count = (testingAtomicWriteCounts[name] ?? 0) + 1
      testingAtomicWriteCounts[name] = count
      guard
        ProcessInfo.processInfo.environment["LAUNDRY_RUNTIME_TEST_CRASH_AFTER_ATOMIC_WRITE"]
          == "\(name):\(count)"
      else { return }
      Darwin._exit(86)
    }

    private static func crashAfterRemoveIfRequested(_ url: URL) {
      let name = url.lastPathComponent
      let count = (testingRemoveCounts[name] ?? 0) + 1
      testingRemoveCounts[name] = count
      guard
        ProcessInfo.processInfo.environment["LAUNDRY_RUNTIME_TEST_CRASH_AFTER_PRIVATE_REMOVE"]
          == "\(name):\(count)"
      else { return }
      Darwin._exit(86)
    }
  #endif

  private static func metadata(_ path: String) -> stat? {
    var value = stat()
    return Darwin.lstat(path, &value) == 0 ? value : nil
  }

  static func pathExists(_ url: URL) -> Bool { metadata(url.path) != nil }

  private static func isMode(_ value: stat, type: mode_t, permissions: mode_t) -> Bool {
    (value.st_mode & S_IFMT) == type && (value.st_mode & 0o777) == permissions
  }

  private static func sameFileVersion(_ left: stat, _ right: stat) -> Bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
      && left.st_mode == right.st_mode && left.st_nlink == right.st_nlink
      && left.st_size == right.st_size
      && left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec
      && left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec
      && left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec
      && left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec
  }

  private static func fsyncDirectory(_ url: URL) throws {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
  }

  static func syncParent(of url: URL) throws {
    try fsyncDirectory(url.deletingLastPathComponent())
  }

  static func ensureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(
      at: url, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    guard let value = metadata(url.path), isMode(value, type: S_IFDIR, permissions: 0o700)
    else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
    try fsyncDirectory(url)
  }

  static func createExclusiveDirectory(_ url: URL) throws {
    guard Darwin.mkdir(url.path, 0o700) == 0 else {
      try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
    }
    guard let value = metadata(url.path), isMode(value, type: S_IFDIR, permissions: 0o700)
    else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
    try fsyncDirectory(url.deletingLastPathComponent())
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
      sameFileVersion(before, pathBefore),
      before.st_size > 0, before.st_size <= maximum
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    guard let data = try handle.readToEnd(), data.count == Int(before.st_size)
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    var after = stat()
    guard Darwin.fstat(descriptor, &after) == 0,
      let pathAfter = metadata(url.path), isMode(after, type: S_IFREG, permissions: 0o600),
      after.st_nlink == 1, sameFileVersion(before, after), sameFileVersion(after, pathAfter)
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    return data
  }

  static func readBounded(_ url: URL, maximum: Int = 65_536) throws -> Data {
    guard let pathBefore = metadata(url.path) else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    defer { Darwin.close(descriptor) }
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0, (value.st_mode & S_IFMT) == S_IFREG,
      value.st_nlink == 1, sameFileVersion(value, pathBefore),
      value.st_size > 0, value.st_size <= maximum
    else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    guard let data = try handle.readToEnd(), data.count == Int(value.st_size)
    else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    var after = stat()
    guard Darwin.fstat(descriptor, &after) == 0, let pathAfter = metadata(url.path),
      (after.st_mode & S_IFMT) == S_IFREG, after.st_nlink == 1,
      sameFileVersion(value, after), sameFileVersion(after, pathAfter)
    else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    return data
  }

  static func privateFileDigest(
    _ url: URL, maximum: Int64 = 137_438_953_472
  ) throws -> RuntimePrivateFileDigest {
    guard let pathBefore = metadata(url.path) else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    defer { Darwin.close(descriptor) }
    var before = stat()
    guard Darwin.fstat(descriptor, &before) == 0,
      isMode(before, type: S_IFREG, permissions: 0o600), before.st_nlink == 1,
      sameFileVersion(before, pathBefore),
      before.st_size > 0, before.st_size <= maximum
    else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    var hasher = SHA256()
    var readBytes: Int64 = 0
    while true {
      let chunk: Data
      do { chunk = try handle.read(upToCount: 1_048_576) ?? Data() } catch {
        try runtimeFail("RUNTIME_BACKUP_INVALID")
      }
      guard !chunk.isEmpty else { break }
      hasher.update(data: chunk)
      readBytes += Int64(chunk.count)
    }
    var after = stat()
    guard readBytes == before.st_size, Darwin.fstat(descriptor, &after) == 0,
      let pathAfter = metadata(url.path), isMode(after, type: S_IFREG, permissions: 0o600),
      after.st_nlink == 1, sameFileVersion(before, after), sameFileVersion(after, pathAfter)
    else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    return RuntimePrivateFileDigest(
      size: readBytes, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined())
  }

  static func openVerifiedPrivateFile(
    _ url: URL, expectedSize: Int64, expectedSHA256: String
  ) throws -> FileHandle {
    guard let pathBefore = metadata(url.path) else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0,
      isMode(value, type: S_IFREG, permissions: 0o600), value.st_nlink == 1,
      sameFileVersion(value, pathBefore),
      value.st_size == expectedSize, expectedSize > 0
    else {
      try? handle.close()
      try runtimeFail("RUNTIME_BACKUP_INVALID")
    }
    var hasher = SHA256()
    var count: Int64 = 0
    while true {
      let chunk: Data
      do { chunk = try handle.read(upToCount: 1_048_576) ?? Data() } catch {
        try? handle.close()
        try runtimeFail("RUNTIME_BACKUP_INVALID")
      }
      guard !chunk.isEmpty else { break }
      hasher.update(data: chunk)
      count += Int64(chunk.count)
    }
    let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    var after = stat()
    guard count == expectedSize, digest == expectedSHA256,
      Darwin.fstat(descriptor, &after) == 0, let pathAfter = metadata(url.path),
      isMode(after, type: S_IFREG, permissions: 0o600), after.st_nlink == 1,
      sameFileVersion(value, after), sameFileVersion(after, pathAfter)
    else {
      try? handle.close()
      try runtimeFail("RUNTIME_BACKUP_INVALID")
    }
    do { try handle.seek(toOffset: 0) } catch {
      try? handle.close()
      try runtimeFail("RUNTIME_BACKUP_INVALID")
    }
    return handle
  }

  static func createPrivateStreamFile(_ url: URL) throws -> FileHandle {
    let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID") }
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0,
      isMode(value, type: S_IFREG, permissions: 0o600), value.st_nlink == 1
    else {
      Darwin.close(descriptor)
      try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
    }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  }

  static func withMaintenanceLock<T>(_ root: URL, _ body: () throws -> T) throws -> T {
    let url = root.appendingPathComponent(".maintenance.lock")
    let descriptor = Darwin.open(url.path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_MAINTENANCE_BUSY") }
    defer { Darwin.close(descriptor) }
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0,
      isMode(value, type: S_IFREG, permissions: 0o600), value.st_nlink == 1,
      Darwin.lockf(descriptor, F_TLOCK, 0) == 0
    else { try runtimeFail("RUNTIME_MAINTENANCE_BUSY") }
    defer { _ = Darwin.lockf(descriptor, F_ULOCK, 0) }
    return try body()
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
    #if RUNTIME_TESTING
      crashAfterAtomicWriteIfRequested(url)
    #endif
  }

  static func removePrivateFile(_ url: URL) throws {
    let result = Darwin.unlink(url.path)
    if result != 0 && errno != ENOENT {
      try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
    }
    try fsyncDirectory(url.deletingLastPathComponent())
    #if RUNTIME_TESTING
      if result == 0 { crashAfterRemoveIfRequested(url) }
    #endif
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
