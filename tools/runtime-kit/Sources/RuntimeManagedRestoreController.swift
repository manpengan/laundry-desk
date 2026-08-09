import Foundation

let runtimeManagedRestoreExportID = "managed-restore-v1"

extension NativeRuntimeController {
  private func managedRestoreState(
    state: RuntimeState, selectedBackupID: String, safetyBackupID: String
  ) -> RuntimeTransferRecoveryState {
    RuntimeTransferRecoveryState(
      version: 1, phase: "safety_ready", startedAt: manifestTimestamp(Date()),
      exportID: runtimeManagedRestoreExportID, sourceInstanceID: state.instanceID,
      backupID: selectedBackupID, safetyBackupID: safetyBackupID, faultCode: nil)
  }

  private func completeManagedRestore(_ expected: RuntimeTransferRecoveryState) throws {
    guard let current = try readTransferState(),
      current.exportID == runtimeManagedRestoreExportID,
      current.sourceInstanceID == expected.sourceInstanceID,
      current.backupID == expected.backupID,
      current.safetyBackupID == expected.safetyBackupID
    else { try runtimeFail("RUNTIME_TRANSFER_STATE_INVALID") }
    try RuntimeStorage.removePrivateFile(paths.transferState)
  }

  func restoreBackup(_ request: RuntimeRestoreRequest) throws -> RuntimeRestoreResult {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      let (state, payload) = try load()
      let existingRecovery = try prepareForBackupRestore(request.backupID, state: state)
      let managedRecovery = existingRecovery?.exportID == runtimeManagedRestoreExportID
      let alreadyUnsafe =
        existingRecovery.map {
          !["preflight_complete", "safety_ready"].contains($0.phase)
        } ?? false
      let restoreLan = releaseLanIntent()
      if alreadyUnsafe {
        do {
          try emergencyStopLanGateway()
          try stopServerAfterUnsafeMaintenance(state: state, payload: payload)
        } catch {
          if let existingRecovery {
            try? writeTransferState(
              existingRecovery.withPhase(
                "failed", faultCode: "RUNTIME_TRANSFER_RECOVERY_REQUIRED"))
          }
          _ = failClosedLanAfterReleaseRecovery(restore: restoreLan, error: error)
          throw error
        }
      }
      let selected = try verifyBackupDirectory(
        backupID: request.backupID, state: state, payload: payload, inspectArtifacts: false)
      if existingRecovery != nil {
        let expectedKind: RuntimeBackupKind = managedRecovery ? .preRestore : .preTransfer
        guard selected.kind == expectedKind else {
          try runtimeFail("RUNTIME_TRANSFER_RECOVERY_REQUIRED")
        }
      }
      guard selected.confirmation == request.confirmation else {
        try runtimeFail("RUNTIME_RESTORE_CONFIRMATION_INVALID")
      }
      let directory = try backupDirectory(request.backupID)
      let manifestData = try RuntimeStorage.readPrivate(
        directory.appendingPathComponent(RuntimeBackupCodec.manifestName))
      guard selected.manifestSHA256 == RuntimeManifestVerifier.sha256(manifestData) else {
        try runtimeFail("RUNTIME_BACKUP_INVALID")
      }
      let manifest = try RuntimeBackupCodec.decode(
        manifestData, expectedBackupID: request.backupID)
      let env = environment(state, payload)
      var mutationStarted = false
      var createdManagedState = false
      var recovery = existingRecovery
      var validated: RuntimeValidatedPayload?
      do {
        try assertVolumes(state)
        try assertImage(payload)
        try emergencyStopLanGateway()
        try run(compose(["stop", "server"], environment: env))
        validated = try RuntimeTransferPayloadValidation.validateBeforeRestore(
          controller: self, directory: directory, database: manifest.database,
          photos: manifest.photos, postgresImage: payload.postgresImage,
          migrationsSHA256: payload.migrationsSHA256)
        guard let validated else { try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID") }
        let safety: RuntimeBackupSummary
        if existingRecovery != nil {
          safety = selected
        } else {
          safety = try createManagedBackup(
            kind: .preRestore, state: state, payload: payload, restartAfter: false,
            preservingValidationRoot: validated.root)
          recovery = managedRestoreState(
            state: state, selectedBackupID: request.backupID,
            safetyBackupID: safety.backupID)
          guard let recovery else { try runtimeFail("RUNTIME_TRANSFER_STATE_INVALID") }
          try writeTransferState(recovery)
          createdManagedState = true
        }
        guard var activeRecovery = recovery else {
          try runtimeFail("RUNTIME_TRANSFER_STATE_INVALID")
        }
        activeRecovery = activeRecovery.withPhase("restoring_database")
        try writeTransferState(activeRecovery)
        mutationStarted = true
        try importSanitizedDatabase(
          from: validated.sanitizedDatabase, state: state, payload: payload)
        try RuntimePayloadValidationStaging.remove(validated.root)
        activeRecovery = activeRecovery.withPhase("restoring_photos")
        try writeTransferState(activeRecovery)
        try run(
          RuntimeBackupCommands.clearPhotos(
            controller: self, image: payload.serverImage.index))
        try stream(
          RuntimeBackupCommands.restorePhotos(
            controller: self, image: payload.serverImage.index),
          input: streamInput(manifest.photos, from: directory), discardOutput: true)
        try run(
          RuntimeBackupCommands.validatePhotos(
            controller: self, image: payload.serverImage.index))
        try validatePhotoConsistency(state: state, payload: payload)
        activeRecovery = activeRecovery.withPhase("starting")
        try writeTransferState(activeRecovery)
        try gates(state, payload, bootstrap: false)
        let outcome = releaseLanOutcome(restore: restoreLan, state: state, payload: payload)
        try requireKnownLanMaintenanceOutcome(outcome)
        if activeRecovery.exportID == runtimeManagedRestoreExportID {
          try completeManagedRestore(activeRecovery)
        } else {
          try completeTransferRecoveryIfMatched(request.backupID)
        }
        return RuntimeRestoreResult(
          status: "ready", release: payload.release, backupID: request.backupID,
          safetyBackupID: safety.backupID, lanStatus: outcome.status,
          lanFaultCode: outcome.faultCode)
      } catch {
        var failure = error
        if let validated { try? RuntimePayloadValidationStaging.remove(validated.root) }
        if alreadyUnsafe || mutationStarted, let recovery {
          do { try stopServerAfterUnsafeMaintenance(state: state, payload: payload) } catch {
            failure = error
          }
          do {
            try writeTransferState(
              recovery.withPhase(
                "failed",
                faultCode: (failure as? RuntimeKitError)?.description
                  ?? "RUNTIME_TRANSFER_RECOVERY_REQUIRED"))
          } catch { failure = error }
        } else if createdManagedState {
          do { try RuntimeStorage.removePrivateFile(paths.transferState) } catch {
            failure = error
          }
        }
        let outcome =
          alreadyUnsafe || mutationStarted
          ? failClosedLanAfterReleaseRecovery(restore: restoreLan, error: failure)
          : settleLanAfterFailedRelease(restore: restoreLan, state: state, payload: payload)
        do { try requireKnownLanMaintenanceOutcome(outcome) } catch { failure = error }
        throw failure
      }
    }
  }
}
