import Foundation

extension NativeRuntimeController {
  private var backupsRoot: URL {
    paths.root.appendingPathComponent("backups", isDirectory: true)
  }

  private func backupDirectory(_ backupID: String) throws -> URL {
    guard RuntimeBackupCodec.validBackupID(backupID) else {
      try runtimeFail("RUNTIME_BACKUP_ID_INVALID")
    }
    return backupsRoot.appendingPathComponent(backupID, isDirectory: true)
  }

  private func ensureBackupCapacity() throws {
    let values = try backupsRoot.resourceValues(forKeys: [
      .volumeAvailableCapacityForImportantUsageKey
    ])
    guard let available = values.volumeAvailableCapacityForImportantUsage,
      available >= 536_870_912
    else { try runtimeFail("RUNTIME_BACKUP_CAPACITY_LOW") }
  }

  private func backupTimestamp(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    return formatter.string(from: date)
  }

  private func manifestTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  private func makeBackupID(kind: RuntimeBackupKind, now: Date) throws -> String {
    let prefix = kind == .manual ? "manual" : "safety"
    return "\(prefix)-\(backupTimestamp(now))-\(try RuntimeStorage.randomToken(bytes: 16))"
  }

  private func stream(
    _ spec: RuntimeCommandSpec, input: RuntimeStreamInput? = nil,
    output: RuntimeStreamOutput? = nil, discardOutput: Bool = false
  ) throws {
    _ = try runner.runStreaming(
      spec,
      stream: RuntimeStreamSpec(
        input: input, output: output, discardOutput: discardOutput,
        timeoutSeconds: 3_600), accepting: [0])
  }

  private func streamInput(_ file: RuntimeBackupFile, from directory: URL) -> RuntimeStreamInput {
    RuntimeStreamInput(
      url: directory.appendingPathComponent(file.name), size: file.size, sha256: file.sha256)
  }

  private func assertBackupCompatibility(
    _ manifest: RuntimeBackupManifest, state: RuntimeState,
    payload: RuntimeManifestPayload
  ) throws {
    guard manifest.instanceID == state.instanceID,
      manifest.release == payload.release,
      manifest.serverVersion == payload.serverVersion,
      manifest.serverImage == payload.serverImage.index,
      manifest.postgresImage == payload.postgresImage,
      manifest.migrationHead == payload.migrationHead,
      manifest.schemaSHA256 == payload.databaseSchemaSHA256
    else { try runtimeFail("RUNTIME_BACKUP_INCOMPATIBLE") }
  }

  private func verifyBackupDirectory(
    backupID: String, state: RuntimeState, payload: RuntimeManifestPayload,
    inspectArtifacts: Bool
  ) throws -> RuntimeBackupSummary {
    let directory = try backupDirectory(backupID)
    do { try RuntimeStorage.validateDirectory(directory) } catch {
      try runtimeFail("RUNTIME_BACKUP_INVALID")
    }
    let entries = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    guard
      entries == [
        RuntimeBackupCodec.databaseName, RuntimeBackupCodec.manifestName,
        RuntimeBackupCodec.photosName,
      ]
    else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    let manifestURL = directory.appendingPathComponent(RuntimeBackupCodec.manifestName)
    let manifestData: Data
    do { manifestData = try RuntimeStorage.readPrivate(manifestURL) } catch {
      try runtimeFail("RUNTIME_BACKUP_INVALID")
    }
    let manifest = try RuntimeBackupCodec.decode(manifestData, expectedBackupID: backupID)
    try assertBackupCompatibility(manifest, state: state, payload: payload)
    let database = try RuntimeStorage.privateFileDigest(
      directory.appendingPathComponent(RuntimeBackupCodec.databaseName),
      maximum: RuntimeBackupCodec.maximumArtifactBytes)
    let photos = try RuntimeStorage.privateFileDigest(
      directory.appendingPathComponent(RuntimeBackupCodec.photosName),
      maximum: RuntimeBackupCodec.maximumArtifactBytes)
    guard database.size == manifest.database.size, database.sha256 == manifest.database.sha256,
      photos.size == manifest.photos.size, photos.sha256 == manifest.photos.sha256
    else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    if inspectArtifacts {
      let env = environment(state, payload)
      try run(compose(["up", "-d", "--wait", "postgres"], environment: env))
      try stream(
        RuntimeBackupCommands.inspectDatabaseDump(controller: self, environment: env),
        input: streamInput(manifest.database, from: directory), discardOutput: true)
      try stream(
        RuntimeBackupCommands.inspectPhotoArchive(
          controller: self, image: payload.serverImage.index),
        input: streamInput(manifest.photos, from: directory), discardOutput: true)
    }
    return try RuntimeBackupCodec.summary(
      manifest: manifest, manifestSHA256: RuntimeManifestVerifier.sha256(manifestData))
  }

  private func createManagedBackup(
    kind: RuntimeBackupKind, state: RuntimeState, payload: RuntimeManifestPayload,
    restartAfter: Bool
  ) throws -> RuntimeBackupSummary {
    try assertVolumes(state)
    try assertImage(payload)
    try RuntimeStorage.ensureDirectory(backupsRoot)
    let entries = try FileManager.default.contentsOfDirectory(atPath: backupsRoot.path)
    guard entries.count < RuntimeBackupCodec.maximumBackups else {
      try runtimeFail("RUNTIME_BACKUP_LIMIT_REACHED")
    }
    try ensureBackupCapacity()
    let now = Date()
    let backupID = try makeBackupID(kind: kind, now: now)
    let directory = try backupDirectory(backupID)
    try RuntimeStorage.createExclusiveDirectory(directory)
    let env = environment(state, payload)
    var serverStopped = false
    do {
      try run(compose(["stop", "server"], environment: env))
      serverStopped = true
      try run(compose(["up", "-d", "--wait", "postgres"], environment: env))
      try run(
        RuntimeBackupCommands.validatePhotos(controller: self, image: payload.serverImage.index))
      let databaseURL = directory.appendingPathComponent(RuntimeBackupCodec.databaseName)
      try stream(
        RuntimeBackupCommands.dumpDatabase(controller: self, environment: env),
        output: RuntimeStreamOutput(
          url: databaseURL, maximumBytes: RuntimeBackupCodec.maximumArtifactBytes))
      try ensureBackupCapacity()
      let photosURL = directory.appendingPathComponent(RuntimeBackupCodec.photosName)
      try stream(
        RuntimeBackupCommands.archivePhotos(controller: self, image: payload.serverImage.index),
        output: RuntimeStreamOutput(
          url: photosURL, maximumBytes: RuntimeBackupCodec.maximumArtifactBytes))
      let database = try RuntimeStorage.privateFileDigest(databaseURL)
      let photos = try RuntimeStorage.privateFileDigest(photosURL)
      let manifest = RuntimeBackupManifest(
        version: 1, backupID: backupID, kind: kind, createdAt: manifestTimestamp(now),
        instanceID: state.instanceID, release: payload.release,
        serverVersion: payload.serverVersion, serverImage: payload.serverImage.index,
        postgresImage: payload.postgresImage, migrationHead: payload.migrationHead,
        schemaSHA256: payload.databaseSchemaSHA256,
        database: RuntimeBackupFile(
          name: RuntimeBackupCodec.databaseName, size: database.size, sha256: database.sha256),
        photos: RuntimeBackupFile(
          name: RuntimeBackupCodec.photosName, size: photos.size, sha256: photos.sha256))
      try RuntimeStorage.writeExclusive(
        try RuntimeBackupCodec.encode(manifest),
        to: directory.appendingPathComponent(RuntimeBackupCodec.manifestName))
      let summary = try verifyBackupDirectory(
        backupID: backupID, state: state, payload: payload, inspectArtifacts: true)
      if restartAfter { try gates(state, payload, bootstrap: false) }
      return summary
    } catch {
      if restartAfter && serverStopped {
        do { try gates(state, payload, bootstrap: false) } catch {
          try runtimeFail("RUNTIME_BACKUP_SERVER_RESTART_FAILED")
        }
      }
      throw error
    }
  }

  func createBackup() throws -> RuntimeBackupSummary {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      let (state, payload) = try load()
      return try createManagedBackup(
        kind: .manual, state: state, payload: payload, restartAfter: true)
    }
  }

  func listBackups() throws -> [RuntimeBackupSummary] {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      let (state, payload) = try load()
      try RuntimeStorage.ensureDirectory(backupsRoot)
      let entries = try FileManager.default.contentsOfDirectory(atPath: backupsRoot.path)
      guard entries.count <= RuntimeBackupCodec.maximumBackups,
        entries.allSatisfy(RuntimeBackupCodec.validBackupID)
      else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
      return entries.sorted(by: >).map { backupID in
        do {
          return try verifyBackupDirectory(
            backupID: backupID, state: state, payload: payload, inspectArtifacts: false)
        } catch {
          return RuntimeBackupCodec.invalidSummary(backupID: backupID, error: error)
        }
      }
    }
  }

  func verifyBackup(_ backupID: String) throws -> RuntimeBackupSummary {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      let (state, payload) = try load()
      return try verifyBackupDirectory(
        backupID: backupID, state: state, payload: payload, inspectArtifacts: true)
    }
  }

  func restoreBackup(_ request: RuntimeRestoreRequest) throws -> RuntimeRestoreResult {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      let (state, payload) = try load()
      let selected = try verifyBackupDirectory(
        backupID: request.backupID, state: state, payload: payload, inspectArtifacts: true)
      guard selected.confirmation == request.confirmation else {
        try runtimeFail("RUNTIME_RESTORE_CONFIRMATION_INVALID")
      }
      try assertVolumes(state)
      try assertImage(payload)
      let env = environment(state, payload)
      try run(compose(["stop", "server"], environment: env))
      let safety = try createManagedBackup(
        kind: .preRestore, state: state, payload: payload, restartAfter: false)
      _ = try verifyBackupDirectory(
        backupID: safety.backupID, state: state, payload: payload, inspectArtifacts: true)
      _ = try verifyBackupDirectory(
        backupID: request.backupID, state: state, payload: payload, inspectArtifacts: true)
      let directory = try backupDirectory(request.backupID)
      let manifestData = try RuntimeStorage.readPrivate(
        directory.appendingPathComponent(RuntimeBackupCodec.manifestName))
      let manifest = try RuntimeBackupCodec.decode(
        manifestData, expectedBackupID: request.backupID)
      try stream(
        RuntimeBackupCommands.restoreDatabase(controller: self, environment: env),
        input: streamInput(manifest.database, from: directory), discardOutput: true)
      try run(compose(["run", "--rm", "roles"], environment: env))
      try run(compose(["run", "--rm", "migrate"], environment: env))
      try run(compose(["run", "--rm", "verify"], environment: env))
      try run(RuntimeBackupCommands.clearPhotos(controller: self, image: payload.serverImage.index))
      try stream(
        RuntimeBackupCommands.restorePhotos(controller: self, image: payload.serverImage.index),
        input: streamInput(manifest.photos, from: directory), discardOutput: true)
      try run(
        RuntimeBackupCommands.validatePhotos(controller: self, image: payload.serverImage.index))
      try gates(state, payload, bootstrap: false)
      return RuntimeRestoreResult(
        status: "ready", release: payload.release, backupID: request.backupID,
        safetyBackupID: safety.backupID)
    }
  }

  func createReleaseSafetyBackup(
    kind: RuntimeBackupKind, state: RuntimeState, payload: RuntimeManifestPayload
  ) throws -> RuntimeBackupSummary {
    guard [.preUpgrade, .preRollback].contains(kind) else {
      try runtimeFail("RUNTIME_BACKUP_INVALID")
    }
    runner.setManifest(payload)
    return try createManagedBackup(
      kind: kind, state: state, payload: payload, restartAfter: false)
  }

  func restoreReleaseSafetyBackup(
    _ backupID: String, state: RuntimeState, payload: RuntimeManifestPayload
  ) throws {
    runner.setManifest(payload)
    try assertVolumes(state)
    try assertImage(payload)
    let env = environment(state, payload)
    try run(compose(["stop", "server"], environment: env))
    _ = try verifyBackupDirectory(
      backupID: backupID, state: state, payload: payload, inspectArtifacts: true)
    let directory = try backupDirectory(backupID)
    let manifestData = try RuntimeStorage.readPrivate(
      directory.appendingPathComponent(RuntimeBackupCodec.manifestName))
    let manifest = try RuntimeBackupCodec.decode(manifestData, expectedBackupID: backupID)
    try stream(
      RuntimeBackupCommands.restoreDatabase(controller: self, environment: env),
      input: streamInput(manifest.database, from: directory), discardOutput: true)
    try run(compose(["run", "--rm", "roles"], environment: env))
    try run(compose(["run", "--rm", "migrate"], environment: env))
    try run(compose(["run", "--rm", "verify"], environment: env))
    try run(RuntimeBackupCommands.clearPhotos(controller: self, image: payload.serverImage.index))
    try stream(
      RuntimeBackupCommands.restorePhotos(controller: self, image: payload.serverImage.index),
      input: streamInput(manifest.photos, from: directory), discardOutput: true)
    try run(
      RuntimeBackupCommands.validatePhotos(controller: self, image: payload.serverImage.index))
    try gates(state, payload, bootstrap: false)
  }
}
