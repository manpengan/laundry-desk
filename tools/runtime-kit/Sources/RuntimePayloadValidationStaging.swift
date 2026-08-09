import Darwin
import Foundation

struct RuntimeValidatedPayload {
  let root: URL
  let sanitizedDatabase: URL
}

extension RuntimePaths {
  var payloadValidationStaging: URL {
    root.appendingPathComponent("payload-validation-staging", isDirectory: true)
  }
}

enum RuntimePayloadValidationStaging {
  static let reserveBytes: Int64 = 536_870_912
  static let sanitizerOverheadBytes: Int64 = 1_048_576
  static let listName = ".database-list.txt"

  static func create(
    _ paths: RuntimePaths, preservingValidationRoot preserved: URL? = nil
  ) throws -> URL {
    try resume(paths, preservingValidationRoot: preserved)
    let root = paths.payloadValidationStaging
    let directory = root.appendingPathComponent(
      try RuntimeStorage.randomToken(bytes: 18), isDirectory: true)
    try RuntimeStorage.createExclusiveDirectory(directory)
    return directory
  }

  static func resume(
    _ paths: RuntimePaths, preservingValidationRoot preserved: URL? = nil
  ) throws {
    try RuntimeStorage.ensureDirectory(paths.payloadValidationStaging)
    let entries = try FileManager.default.contentsOfDirectory(
      atPath: paths.payloadValidationStaging.path)
    guard entries.count <= 32,
      entries.allSatisfy({
        $0.range(of: "^[A-Za-z0-9_-]{24}$", options: .regularExpression) != nil
      })
    else { try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID") }
    let preservedName: String?
    if let preserved {
      let name = preserved.lastPathComponent
      let expected = paths.payloadValidationStaging.appendingPathComponent(
        name, isDirectory: true)
      guard name.range(of: "^[A-Za-z0-9_-]{24}$", options: .regularExpression) != nil,
        preserved.standardizedFileURL.path == expected.standardizedFileURL.path
      else { try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID") }
      try RuntimeStorage.validateDirectory(preserved)
      preservedName = name
    } else {
      preservedName = nil
    }
    for entry in entries {
      if entry == preservedName { continue }
      try remove(
        paths.payloadValidationStaging.appendingPathComponent(entry, isDirectory: true))
    }
  }

  static func remove(_ directory: URL) throws {
    try RuntimeStorage.validateDirectory(directory)
    let limits: [String: Int64] = [
      listName: 1_048_576,
      RuntimeDatabaseSanitizer.rawName: RuntimeBackupCodec.maximumArtifactBytes,
      RuntimeDatabaseSanitizer.sanitizedName:
        RuntimeBackupCodec.maximumArtifactBytes + sanitizerOverheadBytes,
    ]
    let entries = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    guard entries.count <= limits.count, entries.allSatisfy({ limits[$0] != nil }) else {
      try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID")
    }
    for name in entries {
      let path = directory.appendingPathComponent(name)
      var metadata = stat()
      guard let maximum = limits[name], Darwin.lstat(path.path, &metadata) == 0,
        (metadata.st_mode & S_IFMT) == S_IFREG, (metadata.st_mode & 0o777) == 0o600,
        metadata.st_nlink == 1, metadata.st_size >= 0, metadata.st_size <= maximum
      else { try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID") }
      try RuntimeStorage.removePrivateFile(path)
    }
    guard Darwin.rmdir(directory.path) == 0 else {
      try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID")
    }
    try RuntimeStorage.syncParent(of: directory)
  }

  static func rawOutputLimit(_ paths: RuntimePaths) throws -> Int64 {
    let available = try availableCapacity(paths.root)
    guard available > reserveBytes + sanitizerOverheadBytes else {
      try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW")
    }
    return min(
      RuntimeBackupCodec.maximumArtifactBytes,
      available - reserveBytes - sanitizerOverheadBytes)
  }

  static func assertSanitizerCapacity(_ paths: RuntimePaths, rawBytes: Int64) throws {
    guard rawBytes > 0, rawBytes <= RuntimeBackupCodec.maximumArtifactBytes,
      rawBytes <= Int64.max - reserveBytes - sanitizerOverheadBytes,
      try availableCapacity(paths.root) >= rawBytes + reserveBytes + sanitizerOverheadBytes
    else { try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW") }
  }

  static func assertSanitizedSize(_ path: URL, rawBytes: Int64) throws {
    guard rawBytes <= Int64.max - sanitizerOverheadBytes else {
      try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID")
    }
    _ = try RuntimeStorage.privateFileDigest(
      path, maximum: rawBytes + sanitizerOverheadBytes)
  }

  private static func availableCapacity(_ root: URL) throws -> Int64 {
    #if RUNTIME_TESTING
      if let raw = ProcessInfo.processInfo.environment[
        RuntimeExternalPath.CapacityDomain.runtime.testingEnvironmentKey
      ], let available = Int64(raw) {
        return available
      }
    #endif
    let values = try root.resourceValues(forKeys: [
      .volumeAvailableCapacityForImportantUsageKey
    ])
    guard let available = values.volumeAvailableCapacityForImportantUsage, available > 0 else {
      try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW")
    }
    return available
  }
}
