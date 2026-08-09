import Foundation

extension NativeRuntimeController {
  private func stopUnsafeTransferServices() {
    do { try emergencyStopLanGateway() } catch {}
    do {
      let (state, payload) = try load()
      try stopServerAfterUnsafeMaintenance(state: state, payload: payload)
    } catch {}
  }

  private func failClosedInvalidTransferState() throws -> Never {
    stopUnsafeTransferServices()
    try runtimeFail("RUNTIME_TRANSFER_STATE_INVALID")
  }

  private func guardedTransferState() throws -> RuntimeTransferRecoveryState? {
    do { return try readTransferState() } catch {
      try failClosedInvalidTransferState()
    }
  }

  private func failClosedUnsafeTransfer(
    _ recovery: RuntimeTransferRecoveryState
  ) throws -> Never {
    stopUnsafeTransferServices()
    try? RuntimePayloadValidationStaging.resume(paths)
    if recovery.phase == "starting" {
      do {
        try writeTransferState(
          recovery.withPhase(
            "failed", faultCode: "RUNTIME_TRANSFER_RECOVERY_REQUIRED"))
      } catch {}
    }
    try runtimeFail("RUNTIME_TRANSFER_RECOVERY_REQUIRED")
  }

  func prepareForRuntimeMutation() throws {
    guard let recovery = try guardedTransferState() else {
      try resumeTransferStaging()
      try RuntimePayloadValidationStaging.resume(paths)
      return
    }
    guard ["preflight_complete", "safety_ready"].contains(recovery.phase) else {
      try failClosedUnsafeTransfer(recovery)
    }
    try emergencyStopLanGateway()
    try resumeTransferStaging()
    try RuntimePayloadValidationStaging.resume(paths)
    try RuntimeStorage.removePrivateFile(paths.transferState)
  }

  func prepareForRuntimeMutationIfRootExists() throws {
    guard RuntimeStorage.pathExists(paths.root) else { return }
    try RuntimeStorage.validateDirectory(paths.root)
    try prepareForRuntimeMutation()
  }

  func prepareForBackupRestore(
    _ backupID: String, state: RuntimeState
  ) throws -> RuntimeTransferRecoveryState? {
    guard let recovery = try guardedTransferState() else {
      try resumeTransferStaging()
      try RuntimePayloadValidationStaging.resume(paths)
      return nil
    }
    guard recovery.safetyBackupID == backupID else {
      if !["preflight_complete", "safety_ready"].contains(recovery.phase) {
        try failClosedUnsafeTransfer(recovery)
      }
      try runtimeFail("RUNTIME_TRANSFER_RECOVERY_REQUIRED")
    }
    if recovery.exportID == runtimeManagedRestoreExportID,
      recovery.sourceInstanceID != state.instanceID
    {
      try failClosedInvalidTransferState()
    }
    return recovery
  }

  func completeTransferRecoveryIfMatched(_ backupID: String) throws {
    guard let recovery = try readTransferState() else { return }
    guard recovery.safetyBackupID == backupID else {
      try runtimeFail("RUNTIME_TRANSFER_RECOVERY_REQUIRED")
    }
    try resumeTransferStaging()
    try RuntimeStorage.removePrivateFile(paths.transferState)
  }
}
