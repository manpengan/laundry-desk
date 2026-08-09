import Darwin
import Foundation

extension RuntimePaths {
  var transferStaging: URL {
    root.appendingPathComponent("transfer-staging", isDirectory: true)
  }
  var transferState: URL { root.appendingPathComponent("transfer-state.json") }
}
extension NativeRuntimeController {
  private func transferTimestamp(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }
  private func encodeTransferState(_ value: RuntimeTransferRecoveryState) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }

  func writeTransferState(_ value: RuntimeTransferRecoveryState) throws {
    do {
      try RuntimeStorage.atomicWrite(try encodeTransferState(value), to: paths.transferState)
    } catch { try runtimeFail("RUNTIME_TRANSFER_STATE_COMMIT_FAILED") }
  }

  func readTransferState() throws -> RuntimeTransferRecoveryState? {
    guard RuntimeStorage.pathExists(paths.transferState) else { return nil }
    let data = try RuntimeStorage.readPrivate(paths.transferState, maximum: 16_384)
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys).isSubset(of: [
        "version", "phase", "started_at", "export_id", "source_instance_id",
        "backup_id", "safety_backup_id", "fault_code",
      ]),
      Set(object.keys).isSuperset(of: [
        "version", "phase", "started_at", "export_id", "source_instance_id", "backup_id",
      ]),
      let value = try? JSONDecoder().decode(RuntimeTransferRecoveryState.self, from: data),
      value.version == 1,
      [
        "preflight_complete", "safety_ready", "restoring_database", "restoring_photos",
        "verifying", "starting", "failed",
      ].contains(value.phase)
    else { try runtimeFail("RUNTIME_TRANSFER_STATE_INVALID") }
    return value
  }

  func transferDiagnosis() -> (phase: String?, faultCode: String?) {
    do {
      guard let value = try readTransferState() else { return (nil, nil) }
      return (value.phase, value.faultCode ?? "RUNTIME_TRANSFER_RECOVERY_REQUIRED")
    } catch { return ("invalid", "RUNTIME_TRANSFER_STATE_INVALID") }
  }

  private func removeTransferDirectory(_ root: URL) throws {
    try RuntimeStorage.validateDirectory(root)
    let allowed: Set<String> = [
      "transfer-manifest.json", RuntimeBackupCodec.databaseName, RuntimeBackupCodec.photosName,
      RuntimeDatabaseSanitizer.rawName, RuntimeDatabaseSanitizer.sanitizedName,
    ]
    let entries = try FileManager.default.contentsOfDirectory(atPath: root.path)
    let temporary = entries.filter {
      $0.range(
        of: "^\\.database-list-[A-Za-z0-9_-]{24}$", options: .regularExpression) != nil
    }
    guard temporary.count <= 1, entries.count <= allowed.count + temporary.count,
      entries.allSatisfy({ allowed.contains($0) || temporary.contains($0) })
    else { try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID") }
    for name in entries {
      let path = root.appendingPathComponent(name)
      var metadata = stat()
      guard Darwin.lstat(path.path, &metadata) == 0,
        (metadata.st_mode & S_IFMT) == S_IFREG, (metadata.st_mode & 0o777) == 0o600,
        metadata.st_nlink == 1,
        !temporary.contains(name) || metadata.st_size <= 1_048_576,
        ![RuntimeDatabaseSanitizer.rawName, RuntimeDatabaseSanitizer.sanitizedName].contains(name)
          || metadata.st_size <= RuntimeBackupCodec.maximumArtifactBytes
      else { try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID") }
      try RuntimeStorage.removePrivateFile(path)
    }
    guard Darwin.rmdir(root.path) == 0 else {
      try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID")
    }
    try RuntimeStorage.syncParent(of: root)
  }
  func resumeTransferStaging() throws {
    try RuntimeStorage.ensureDirectory(paths.transferStaging)
    let entries = try FileManager.default.contentsOfDirectory(atPath: paths.transferStaging.path)
    guard entries.count <= 32,
      entries.allSatisfy({
        $0.range(of: "^[A-Za-z0-9_-]{24}$", options: .regularExpression) != nil
      })
    else { try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID") }
    for name in entries {
      try removeTransferDirectory(paths.transferStaging.appendingPathComponent(name))
    }
  }
  private func transferManifest(
    backup: RuntimeVerifiedBackup, state: RuntimeState
  ) throws -> RuntimeTransferManifest {
    RuntimeTransferManifest(
      version: 1, sourceInstanceID: state.instanceID,
      exportID: try RuntimeStorage.randomToken(bytes: 16), exportedAt: transferTimestamp(),
      backupManifest: backup.manifest,
      backupManifestSHA256: RuntimeManifestVerifier.sha256(backup.manifestData),
      database: backup.manifest.database, photos: backup.manifest.photos,
      release: backup.manifest.release, migrationHead: backup.manifest.migrationHead,
      schemaSHA256: backup.manifest.schemaSHA256,
      serverImage: backup.manifest.serverImage, postgresImage: backup.manifest.postgresImage)
  }

  private func transferCompatible(
    _ manifest: RuntimeTransferManifest, payload: RuntimeManifestPayload
  ) -> Bool {
    manifest.release == payload.release && manifest.migrationHead == payload.migrationHead
      && manifest.schemaSHA256 == payload.databaseSchemaSHA256
      && manifest.serverImage == payload.serverImage.index
      && manifest.postgresImage == payload.postgresImage
  }

  func exportTransfer(_ request: RuntimeTransferExportRequest) throws
    -> RuntimeTransferExportResult
  {
    try RuntimePasswordKDF.validatePassword(request.password)
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      let (state, payload) = try load()
      let backup = try verifiedBackupForTransfer(request.backupID, state: state, payload: payload)
      let manifest = try transferManifest(backup: backup, state: state)
      let manifestData = try RuntimeTransferController.encodeManifest(manifest)
      let plaintextBytes = try RuntimeTransferController.plaintextBytes(
        backup: backup, manifestData: manifestData)
      let archiveBytes = try RuntimePortableArchive.archiveBytes(forPlaintext: plaintextBytes)
      guard archiveBytes <= Int64.max - RuntimeExternalPath.capacityReserveBytes else {
        try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW")
      }
      let output = try RuntimeExternalPath.createOutput(
        request.path,
        requiredBytes: archiveBytes + RuntimeExternalPath.capacityReserveBytes)
      let metadata = try RuntimeTransferController.encrypt(
        backup: backup, manifestData: manifestData, password: request.password,
        output: output.handle)
      guard let archiveSHA256 = metadata.archiveSHA256 else {
        try runtimeFail("RUNTIME_TRANSFER_INVALID")
      }
      let bytes = try output.publish()
      guard bytes == metadata.archiveBytes else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
      return RuntimeTransferExportResult(
        status: "exported", exportID: manifest.exportID,
        backupID: backup.manifest.backupID, release: manifest.release, bytes: bytes,
        sha256: archiveSHA256,
        confirmation: RuntimeTransferController.confirmation(manifestData))
    }
  }

  private func stagedTransfer(
    path: String, password: String, payload: RuntimeManifestPayload,
    capacityReserve: Int64
  ) throws -> (RuntimeStagedTransfer, Bool) {
    guard !RuntimeStorage.pathExists(paths.transferState) else {
      try runtimeFail("RUNTIME_TRANSFER_RECOVERY_REQUIRED")
    }
    try resumeTransferStaging()
    let staged = try RuntimeTransferController.stage(
      path: path, password: password, paths: paths, capacityReserve: capacityReserve)
    return (staged, transferCompatible(staged.manifest, payload: payload))
  }

  func inspectTransfer(_ request: RuntimeTransferInspectRequest) throws
    -> RuntimeTransferInspectResult
  {
    try RuntimePasswordKDF.validatePassword(request.password)
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      let (_, payload) = try load()
      let (staged, compatible) = try stagedTransfer(
        path: request.path, password: request.password, payload: payload,
        capacityReserve: RuntimeExternalPath.capacityReserveBytes)
      let result = RuntimeTransferInspectResult(
        status: "valid", exportID: staged.manifest.exportID,
        sourceInstanceID: staged.manifest.sourceInstanceID,
        backupID: staged.manifest.backupManifest.backupID,
        release: staged.manifest.release, migrationHead: staged.manifest.migrationHead,
        bytes: staged.metadata.archiveBytes, compatible: compatible,
        confirmation: RuntimeTransferController.confirmation(staged.manifestData))
      try removeTransferDirectory(staged.root)
      return result
    }
  }

  private func assertTransferCapacity(_ manifest: RuntimeTransferManifest) throws {
    guard manifest.photos.size <= Int64.max - RuntimePayloadValidationStaging.reserveBytes else {
      try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW")
    }
    let required = manifest.photos.size + RuntimePayloadValidationStaging.reserveBytes
    try RuntimeExternalPath.assertCapacity(
      at: paths.root, requiredBytes: required, domain: .runtime)
  }

  private func prepareTransferImport(
    staged: RuntimeStagedTransfer, compatible: Bool,
    request: RuntimeTransferImportRequest, state: RuntimeState,
    payload: RuntimeManifestPayload
  ) throws -> (RuntimeTransferRecoveryState, RuntimeValidatedPayload) {
    var validated: RuntimeValidatedPayload?
    do {
      guard compatible else { try runtimeFail("RUNTIME_TRANSFER_INCOMPATIBLE") }
      guard request.confirmation == RuntimeTransferController.confirmation(staged.manifestData)
      else { try runtimeFail("RUNTIME_TRANSFER_CONFIRMATION_INVALID") }
      try assertTransferCapacity(staged.manifest)
      validated = try RuntimeTransferPayloadValidation.validateBeforeRestore(
        controller: self, directory: staged.root,
        database: staged.manifest.database, photos: staged.manifest.photos,
        postgresImage: payload.postgresImage,
        migrationsSHA256: payload.migrationsSHA256)
      let recovery = RuntimeTransferRecoveryState(
        version: 1, phase: "preflight_complete", startedAt: transferTimestamp(),
        exportID: staged.manifest.exportID,
        sourceInstanceID: staged.manifest.sourceInstanceID,
        backupID: staged.manifest.backupManifest.backupID,
        safetyBackupID: nil, faultCode: nil)
      try writeTransferState(recovery)
      guard let validated else { try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID") }
      return (recovery, validated)
    } catch {
      var failure = error
      if let validated {
        do { try RuntimePayloadValidationStaging.remove(validated.root) } catch {
          failure = error
        }
      }
      do { try removeTransferDirectory(staged.root) } catch { failure = error }
      throw failure
    }
  }

  private func restoreTransfer(
    _ staged: RuntimeStagedTransfer, state: RuntimeState,
    payload: RuntimeManifestPayload, recovery: inout RuntimeTransferRecoveryState,
    mutationStarted: inout Bool, validated: RuntimeValidatedPayload
  ) throws {
    recovery = recovery.withPhase("restoring_database")
    try writeTransferState(recovery)
    mutationStarted = true
    try importSanitizedDatabase(
      from: validated.sanitizedDatabase,
      state: state, payload: payload)
    try RuntimePayloadValidationStaging.remove(validated.root)
    recovery = recovery.withPhase("restoring_photos")
    try writeTransferState(recovery)
    try run(RuntimeBackupCommands.clearPhotos(controller: self, image: payload.serverImage.index))
    try stream(
      RuntimeBackupCommands.restorePhotos(controller: self, image: payload.serverImage.index),
      input: streamInput(staged.manifest.photos, from: staged.root), discardOutput: true)
    try run(
      RuntimeBackupCommands.validatePhotos(controller: self, image: payload.serverImage.index))
    try validatePhotoConsistency(state: state, payload: payload)
    recovery = recovery.withPhase("verifying")
    try writeTransferState(recovery)
  }

  func importTransfer(_ request: RuntimeTransferImportRequest) throws
    -> RuntimeTransferImportResult
  {
    try RuntimePasswordKDF.validatePassword(request.password)
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      let (state, payload) = try load()
      let (staged, compatible) = try stagedTransfer(
        path: request.path, password: request.password, payload: payload,
        capacityReserve: 536_870_912)
      var (recovery, validated) = try prepareTransferImport(
        staged: staged, compatible: compatible, request: request,
        state: state, payload: payload)
      let restoreLan = releaseLanIntent()
      var mutationStarted = false
      do {
        try emergencyStopLanGateway()
        let safety = try createTransferSafetyBackup(
          state: state, payload: payload,
          preservingValidationRoot: validated.root)
        recovery = recovery.withPhase("safety_ready", safetyBackupID: safety.backupID)
        try writeTransferState(recovery)
        try restoreTransfer(
          staged, state: state, payload: payload,
          recovery: &recovery, mutationStarted: &mutationStarted, validated: validated)
        recovery = recovery.withPhase("starting")
        try writeTransferState(recovery)
        try gates(state, payload, bootstrap: false)
        let lan = releaseLanOutcome(restore: restoreLan, state: state, payload: payload)
        try requireKnownLanMaintenanceOutcome(lan)
        try removeTransferDirectory(staged.root)
        try RuntimeStorage.removePrivateFile(paths.transferState)
        return RuntimeTransferImportResult(
          status: "ready", release: payload.release, exportID: staged.manifest.exportID,
          sourceInstanceID: staged.manifest.sourceInstanceID,
          safetyBackupID: safety.backupID, lanStatus: lan.status,
          lanFaultCode: lan.faultCode)
      } catch {
        var failure = error
        if mutationStarted {
          try? RuntimePayloadValidationStaging.remove(validated.root)
          do { try stopServerAfterUnsafeMaintenance(state: state, payload: payload) } catch {
            failure = error
          }
          do {
            try writeTransferState(
              recovery.withPhase(
                "failed",
                faultCode: (failure as? RuntimeKitError)?.description
                  ?? "RUNTIME_TRANSFER_IMPORT_FAILED"))
          } catch { failure = error }
          let lan = failClosedLanAfterReleaseRecovery(restore: restoreLan, error: failure)
          do { try requireKnownLanMaintenanceOutcome(lan) } catch { failure = error }
        } else {
          let lan = settleLanAfterFailedRelease(
            restore: restoreLan, state: state, payload: payload)
          do { try requireKnownLanMaintenanceOutcome(lan) } catch { failure = error }
          do { try removeTransferDirectory(staged.root) } catch { failure = error }
          do { try RuntimePayloadValidationStaging.remove(validated.root) } catch {
            failure = error
          }
          do { try RuntimeStorage.removePrivateFile(paths.transferState) } catch {
            failure = error
          }
        }
        throw failure
      }
    }
  }
}
