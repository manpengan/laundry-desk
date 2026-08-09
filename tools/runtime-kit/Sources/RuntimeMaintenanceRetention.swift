import Darwin
import Foundation

extension RuntimePaths {
  var backupStaging: URL {
    root.appendingPathComponent("backup-staging", isDirectory: true)
  }
  var backupTrash: URL {
    root.appendingPathComponent("backup-trash", isDirectory: true)
  }
  var maintenanceState: URL { root.appendingPathComponent("maintenance-state.json") }
}

enum RuntimeMaintenanceRetention {
  private static let maximumScheduled = 30
  private static let maximumAge: TimeInterval = 30 * 24 * 60 * 60
  private static let artifactNames: Set<String> = [
    RuntimeBackupCodec.databaseName, RuntimeBackupCodec.manifestName,
    RuntimeBackupCodec.photosName,
  ]

  private static func validateRemovalFile(
    _ url: URL, maximum: Int64 = RuntimeBackupCodec.maximumArtifactBytes
  ) throws {
    var value = stat()
    guard Darwin.lstat(url.path, &value) == 0,
      (value.st_mode & S_IFMT) == S_IFREG, (value.st_mode & 0o777) == 0o600,
      value.st_nlink == 1, value.st_size >= 0,
      value.st_size <= maximum
    else { try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED") }
  }

  private static func removePrivateBackupDirectory(_ directory: URL) throws {
    try RuntimeStorage.validateDirectory(directory)
    let entries = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    let fixed = artifactNames.union([
      RuntimeDatabaseSanitizer.rawName, RuntimeDatabaseSanitizer.sanitizedName,
    ])
    let listFiles = entries.filter {
      $0.range(
        of: "^\\.database-list-[A-Za-z0-9_-]{24}$", options: .regularExpression) != nil
    }
    guard listFiles.count <= 1, entries.count <= fixed.count + listFiles.count,
      entries.allSatisfy({ fixed.contains($0) || listFiles.contains($0) })
    else { try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED") }
    for name in entries {
      let file = directory.appendingPathComponent(name)
      try validateRemovalFile(
        file,
        maximum: listFiles.contains(name) ? 1_048_576 : RuntimeBackupCodec.maximumArtifactBytes)
      try RuntimeStorage.removePrivateFile(file)
    }
    guard Darwin.rmdir(directory.path) == 0 else {
      try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
    }
    try RuntimeStorage.syncParent(of: directory)
  }

  private static func sameDirectory(_ left: stat, _ right: stat) -> Bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
      && left.st_mode == right.st_mode && left.st_nlink == right.st_nlink
  }

  private static func removeScheduledTrash(
    _ directory: URL, backupID: String, expectedManifestSHA256: String? = nil
  ) throws {
    try RuntimeStorage.validateDirectory(directory)
    var before = stat()
    guard Darwin.lstat(directory.path, &before) == 0 else {
      try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
    }
    let entries = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    guard entries.count <= artifactNames.count, entries.allSatisfy(artifactNames.contains) else {
      try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
    }
    if entries.isEmpty {
      guard Darwin.rmdir(directory.path) == 0 else {
        try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
      }
      try RuntimeStorage.syncParent(of: directory)
      return
    }
    guard entries.contains(RuntimeBackupCodec.manifestName) else {
      try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
    }
    let manifestData = try RuntimeStorage.readPrivate(
      directory.appendingPathComponent(RuntimeBackupCodec.manifestName), maximum: 65_536)
    let manifest = try RuntimeBackupCodec.decode(manifestData, expectedBackupID: backupID)
    let manifestSHA256 = RuntimeManifestVerifier.sha256(manifestData)
    guard manifest.kind == .scheduled,
      expectedManifestSHA256 == nil || expectedManifestSHA256 == manifestSHA256
    else {
      try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
    }
    for file in [manifest.database, manifest.photos]
    where entries.contains(file.name) {
      let digest = try RuntimeStorage.privateFileDigest(
        directory.appendingPathComponent(file.name),
        maximum: RuntimeBackupCodec.maximumArtifactBytes)
      guard digest.size == file.size, digest.sha256 == file.sha256
      else { try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED") }
    }
    var after = stat()
    guard Darwin.lstat(directory.path, &after) == 0, sameDirectory(before, after) else {
      try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
    }
    for name in [RuntimeBackupCodec.databaseName, RuntimeBackupCodec.photosName]
    where entries.contains(name) {
      try RuntimeStorage.removePrivateFile(directory.appendingPathComponent(name))
    }
    try RuntimeStorage.removePrivateFile(
      directory.appendingPathComponent(RuntimeBackupCodec.manifestName))
    guard Darwin.rmdir(directory.path) == 0 else {
      try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
    }
    try RuntimeStorage.syncParent(of: directory)
  }

  static func removeStagingDirectory(_ directory: URL) throws {
    try removePrivateBackupDirectory(directory)
  }

  static func canRecoverOverflow(_ summaries: [RuntimeBackupSummary]) -> Bool {
    summaries.contains { $0.verified && $0.kind == .scheduled }
  }

  static func resumeTrash(_ paths: RuntimePaths) throws -> Int {
    try RuntimeStorage.ensureDirectory(paths.backupTrash)
    let entries = try FileManager.default.contentsOfDirectory(atPath: paths.backupTrash.path)
    guard entries.count <= RuntimeBackupCodec.maximumBackups + 1,
      entries.allSatisfy(RuntimeBackupCodec.validBackupID)
    else { try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED") }
    for name in entries.sorted() {
      try removeScheduledTrash(
        paths.backupTrash.appendingPathComponent(name, isDirectory: true), backupID: name)
    }
    return entries.count
  }

  static func resumeStaging(_ paths: RuntimePaths) throws {
    try RuntimeStorage.ensureDirectory(paths.backupStaging)
    let entries = try FileManager.default.contentsOfDirectory(atPath: paths.backupStaging.path)
    guard entries.count <= RuntimeBackupCodec.maximumBackups,
      entries.allSatisfy(RuntimeBackupCodec.validBackupID)
    else { try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED") }
    for name in entries.sorted() {
      try removePrivateBackupDirectory(
        paths.backupStaging.appendingPathComponent(name, isDirectory: true))
    }
  }

  private static func selectedForDeletion(
    _ summaries: [RuntimeBackupSummary], now: Date
  ) -> [RuntimeBackupSummary] {
    let scheduled = summaries.compactMap { summary -> (RuntimeBackupSummary, Date)? in
      guard summary.verified, summary.kind == .scheduled, let text = summary.createdAt,
        let date = ISO8601DateFormatter().date(from: text)
      else { return nil }
      return (summary, date)
    }.sorted { $0.1 > $1.1 }
    guard scheduled.count > 1 else { return [] }
    let overflow = max(0, summaries.count - RuntimeBackupCodec.maximumBackups)
    let overflowStart = max(1, scheduled.count - overflow)
    return scheduled.enumerated().compactMap { index, entry in
      guard index > 0,
        index >= maximumScheduled || index >= overflowStart
          || now.timeIntervalSince(entry.1) > maximumAge
      else { return nil }
      return entry.0
    }
  }

  static func apply(
    paths: RuntimePaths, summaries: [RuntimeBackupSummary], now: Date
  ) throws -> Int {
    try RuntimeStorage.ensureDirectory(paths.backupTrash)
    var deleted = try resumeTrash(paths)
    for summary in selectedForDeletion(summaries, now: now) {
      let source = paths.root.appendingPathComponent("backups", isDirectory: true)
        .appendingPathComponent(summary.backupID, isDirectory: true)
      let destination = paths.backupTrash.appendingPathComponent(
        summary.backupID, isDirectory: true)
      var sourceMetadata = stat()
      var sourceAfterRead = stat()
      guard let expectedManifestSHA256 = summary.manifestSHA256,
        Darwin.lstat(source.path, &sourceMetadata) == 0,
        (sourceMetadata.st_mode & S_IFMT) == S_IFDIR,
        (sourceMetadata.st_mode & 0o777) == 0o700,
        RuntimeManifestVerifier.sha256(
          try RuntimeStorage.readPrivate(
            source.appendingPathComponent(RuntimeBackupCodec.manifestName), maximum: 65_536))
          == expectedManifestSHA256,
        Darwin.lstat(source.path, &sourceAfterRead) == 0,
        sameDirectory(sourceMetadata, sourceAfterRead),
        Darwin.renamex_np(source.path, destination.path, UInt32(RENAME_EXCL)) == 0
      else {
        try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED")
      }
      var destinationMetadata = stat()
      guard Darwin.lstat(destination.path, &destinationMetadata) == 0,
        sameDirectory(sourceMetadata, destinationMetadata)
      else { try runtimeFail("RUNTIME_MAINTENANCE_RETENTION_FAILED") }
      try RuntimeStorage.syncParent(of: source)
      try RuntimeStorage.syncParent(of: destination)
      try removeScheduledTrash(
        destination, backupID: summary.backupID,
        expectedManifestSHA256: expectedManifestSHA256)
      deleted += 1
    }
    return deleted
  }
}
