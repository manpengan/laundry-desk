import Darwin
import Foundation

extension NativeRuntimeController {
  var backupsRoot: URL {
    paths.root.appendingPathComponent("backups", isDirectory: true)
  }

  func backupDirectory(_ backupID: String) throws -> URL {
    guard RuntimeBackupCodec.validBackupID(backupID) else {
      try runtimeFail("RUNTIME_BACKUP_ID_INVALID")
    }
    return backupsRoot.appendingPathComponent(backupID, isDirectory: true)
  }

  func stream(
    _ spec: RuntimeCommandSpec, input: RuntimeStreamInput? = nil,
    output: RuntimeStreamOutput? = nil, discardOutput: Bool = false
  ) throws {
    _ = try runner.runStreaming(
      spec,
      stream: RuntimeStreamSpec(
        input: input, output: output, discardOutput: discardOutput,
        timeoutSeconds: 3_600), accepting: [0])
  }

  func streamInput(_ file: RuntimeBackupFile, from directory: URL) -> RuntimeStreamInput {
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

  func verifyBackupDirectory(
    backupID: String, state: RuntimeState, payload: RuntimeManifestPayload,
    inspectArtifacts: Bool, directory: URL? = nil,
    preservingValidationRoot preserved: URL? = nil
  ) throws -> RuntimeBackupSummary {
    let directory = try directory ?? backupDirectory(backupID)
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
      let validated = try RuntimeTransferPayloadValidation.validateBeforeRestore(
        controller: self, directory: directory,
        database: manifest.database, photos: manifest.photos,
        postgresImage: payload.postgresImage,
        migrationsSHA256: payload.migrationsSHA256,
        preservingValidationRoot: preserved)
      try RuntimePayloadValidationStaging.remove(validated.root)
    }
    return try RuntimeBackupCodec.summary(
      manifest: manifest, manifestSHA256: RuntimeManifestVerifier.sha256(manifestData))
  }

  func createManagedBackup(
    kind: RuntimeBackupKind, state: RuntimeState, payload: RuntimeManifestPayload,
    restartAfter: Bool, preservingValidationRoot preserved: URL? = nil
  ) throws -> RuntimeBackupSummary {
    try assertVolumes(state)
    try assertImage(payload)
    try RuntimeStorage.ensureDirectory(backupsRoot)
    try RuntimeMaintenanceRetention.resumeStaging(paths)
    try assertBackupSlotAvailable(kind: kind, state: state, payload: payload)
    try ensureBackupCapacity()
    let now = Date()
    let backupID = try makeBackupID(kind: kind, now: now)
    let stagingRoot = paths.root.appendingPathComponent("backup-staging", isDirectory: true)
    try RuntimeStorage.ensureDirectory(stagingRoot)
    let directory = stagingRoot.appendingPathComponent(backupID, isDirectory: true)
    let destination = try backupDirectory(backupID)
    try RuntimeStorage.createExclusiveDirectory(directory)
    let env = environment(state, payload)
    var serverStopped = false
    var published = false
    do {
      try run(compose(["stop", "server"], environment: env))
      serverStopped = true
      try run(compose(["up", "-d", "--wait", "postgres"], environment: env))
      try run(
        RuntimeBackupCommands.validatePhotos(controller: self, image: payload.serverImage.index))
      try validatePhotoConsistency(state: state, payload: payload)
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
        backupID: backupID, state: state, payload: payload, inspectArtifacts: true,
        directory: directory, preservingValidationRoot: preserved)
      guard Darwin.renamex_np(directory.path, destination.path, UInt32(RENAME_EXCL)) == 0 else {
        try runtimeFail("RUNTIME_BACKUP_PUBLISH_FAILED")
      }
      published = true
      try RuntimeStorage.syncParent(of: directory)
      try RuntimeStorage.syncParent(of: destination)
      if restartAfter { try gates(state, payload, bootstrap: false) }
      return summary
    } catch {
      var failure = error
      if !published {
        do { try RuntimeMaintenanceRetention.removeStagingDirectory(directory) } catch {
          failure = error
        }
      }
      if restartAfter && serverStopped {
        do { try gates(state, payload, bootstrap: false) } catch {
          try runtimeFail("RUNTIME_BACKUP_SERVER_RESTART_FAILED")
        }
      }
      throw failure
    }
  }

  func createBackup() throws -> RuntimeBackupSummary {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      let (state, payload) = try load()
      let restoreLan = releaseLanIntent()
      try emergencyStopLanGateway()
      let summary: RuntimeBackupSummary
      do {
        summary = try createManagedBackup(
          kind: .manual, state: state, payload: payload, restartAfter: true)
      } catch {
        let failure = error
        let outcome = settleLanAfterFailedRelease(
          restore: restoreLan, state: state, payload: payload)
        try requireKnownLanMaintenanceOutcome(outcome)
        throw failure
      }
      let outcome = releaseLanOutcome(restore: restoreLan, state: state, payload: payload)
      try requireKnownLanMaintenanceOutcome(outcome)
      return summary.withLanOutcome(status: outcome.status, faultCode: outcome.faultCode)
    }
  }

  func listBackupsUnlocked(
    state: RuntimeState, payload: RuntimeManifestPayload
  ) throws -> [RuntimeBackupSummary] {
    try RuntimeStorage.ensureDirectory(backupsRoot)
    let entries = try FileManager.default.contentsOfDirectory(atPath: backupsRoot.path)
    guard entries.count <= RuntimeBackupCodec.maximumBackups + 1,
      entries.allSatisfy(RuntimeBackupCodec.validBackupID)
    else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    let summaries = entries.sorted(by: >).map { backupID in
      do {
        return try verifyBackupDirectory(
          backupID: backupID, state: state, payload: payload, inspectArtifacts: false)
      } catch {
        return RuntimeBackupCodec.invalidSummary(backupID: backupID, error: error)
      }
    }
    guard
      entries.count <= RuntimeBackupCodec.maximumBackups
        || RuntimeMaintenanceRetention.canRecoverOverflow(summaries)
    else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    return summaries
  }

  func listBackups() throws -> [RuntimeBackupSummary] {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      let (state, payload) = try load()
      return try listBackupsUnlocked(state: state, payload: payload)
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

  func verifiedBackupForTransfer(
    _ backupID: String, state: RuntimeState, payload: RuntimeManifestPayload
  ) throws -> RuntimeVerifiedBackup {
    let summary = try verifyBackupDirectory(
      backupID: backupID, state: state, payload: payload, inspectArtifacts: true)
    guard summary.verified else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    let directory = try backupDirectory(backupID)
    let manifestData = try RuntimeStorage.readPrivate(
      directory.appendingPathComponent(RuntimeBackupCodec.manifestName), maximum: 65_536)
    let manifest = try RuntimeBackupCodec.decode(manifestData, expectedBackupID: backupID)
    return RuntimeVerifiedBackup(
      directory: directory, manifestData: manifestData, manifest: manifest, summary: summary)
  }

  func createReleaseSafetyBackup(
    kind: RuntimeBackupKind, state: RuntimeState, payload: RuntimeManifestPayload
  ) throws -> RuntimeBackupSummary {
    guard [.preUpgrade, .preRollback].contains(kind) else {
      try runtimeFail("RUNTIME_BACKUP_INVALID")
    }
    runner.setManifest(payload)
    try emergencyStopLanGateway()
    return try createManagedBackup(
      kind: kind, state: state, payload: payload, restartAfter: false)
  }

  func createTransferSafetyBackup(
    state: RuntimeState, payload: RuntimeManifestPayload,
    preservingValidationRoot preserved: URL
  ) throws -> RuntimeBackupSummary {
    runner.setManifest(payload)
    try emergencyStopLanGateway()
    return try createManagedBackup(
      kind: .preTransfer, state: state, payload: payload, restartAfter: false,
      preservingValidationRoot: preserved)
  }

  func restoreReleaseSafetyBackup(
    _ backupID: String, state: RuntimeState, payload: RuntimeManifestPayload
  ) throws {
    runner.setManifest(payload)
    try emergencyStopLanGateway()
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
    let validated = try RuntimeTransferPayloadValidation.validateBeforeRestore(
      controller: self, directory: directory, database: manifest.database,
      photos: manifest.photos, postgresImage: payload.postgresImage,
      migrationsSHA256: payload.migrationsSHA256)
    do {
      try importSanitizedDatabase(
        from: validated.sanitizedDatabase, state: state, payload: payload)
      try RuntimePayloadValidationStaging.remove(validated.root)
      try run(
        RuntimeBackupCommands.clearPhotos(controller: self, image: payload.serverImage.index))
      try stream(
        RuntimeBackupCommands.restorePhotos(controller: self, image: payload.serverImage.index),
        input: streamInput(manifest.photos, from: directory), discardOutput: true)
      try run(
        RuntimeBackupCommands.validatePhotos(controller: self, image: payload.serverImage.index))
      try validatePhotoConsistency(state: state, payload: payload)
      try gates(state, payload, bootstrap: false)
    } catch {
      let failure = error
      try? RuntimePayloadValidationStaging.remove(validated.root)
      try stopServerAfterUnsafeMaintenance(state: state, payload: payload)
      throw failure
    }
  }
}
