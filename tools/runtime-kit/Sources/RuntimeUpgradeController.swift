import Foundation

extension NativeRuntimeController {
  private func defaultReleaseHistory(_ state: RuntimeState) -> RuntimeReleaseHistory {
    RuntimeReleaseHistory(
      version: 1, highestAcceptedRelease: state.release,
      previousRelease: nil, previousManifestSHA256: nil, preUpgradeBackupID: nil)
  }

  private func releaseHistoryData(_ state: RuntimeState) throws -> Data {
    guard RuntimeStorage.pathExists(paths.releaseHistory) else {
      return try RuntimeReleaseCodec.encode(defaultReleaseHistory(state))
    }
    return try RuntimeStorage.readPrivate(paths.releaseHistory)
  }

  private func writeReleaseHistory(_ value: RuntimeReleaseHistory) throws {
    try RuntimeStorage.atomicWrite(
      try RuntimeReleaseCodec.encode(value), to: paths.releaseHistory)
  }

  private func writeReleaseTransition(_ value: RuntimeReleaseTransition) throws {
    try RuntimeStorage.atomicWrite(
      try RuntimeReleaseCodec.encode(value), to: paths.transition)
  }

  private func clearReleaseTransition() throws {
    try RuntimeStorage.removePrivateFile(paths.pendingManifest)
    try RuntimeStorage.removePrivateFile(paths.transition)
  }

  private func commitReleaseTransition() throws {
    do { try clearReleaseTransition() } catch {
      try runtimeFail("RUNTIME_RELEASE_COMMIT_UNCERTAIN")
    }
  }

  private func optionalPreviousManifest() throws -> Data {
    guard RuntimeStorage.pathExists(paths.previousManifest) else { return Data() }
    return try RuntimeStorage.readPrivate(paths.previousManifest)
  }

  private func validatePreviousManifest(
    _ data: Data, history: RuntimeReleaseHistory
  ) throws {
    if data.isEmpty {
      guard history.previousRelease == nil, history.previousManifestSHA256 == nil,
        history.preUpgradeBackupID == nil
      else { try runtimeFail("RUNTIME_RELEASE_TRANSITION_INVALID") }
      return
    }
    let payload = try verifyManifest(data)
    guard history.previousRelease == payload.release,
      history.previousManifestSHA256 == RuntimeManifestVerifier.sha256(data),
      history.preUpgradeBackupID != nil
    else { try runtimeFail("RUNTIME_RELEASE_TRANSITION_INVALID") }
  }

  private func validatedTransition(
    _ value: RuntimeReleaseTransition
  ) throws -> (RuntimeState, RuntimeManifestPayload, RuntimeReleaseHistory) {
    let preState = try decodeState(value.preState)
    let targetState = try decodeState(value.targetState)
    let preManifest = try verifyManifest(value.preManifest)
    let targetManifest = try verifyManifest(value.targetManifest)
    let preHistory = try RuntimeReleaseCodec.decodeHistory(
      value.preHistory, currentRelease: preState.release)
    let targetHistory = try RuntimeReleaseCodec.decodeHistory(
      value.targetHistory, currentRelease: targetState.release)
    try validatePreviousManifest(value.prePreviousManifest, history: preHistory)
    try validatePreviousManifest(value.targetPreviousManifest, history: targetHistory)
    let preSHA256 = RuntimeManifestVerifier.sha256(value.preManifest)
    let targetSHA256 = RuntimeManifestVerifier.sha256(value.targetManifest)
    guard value.fromRelease == preManifest.release,
      value.toRelease == targetManifest.release,
      value.fromManifestSHA256 == preSHA256, value.toManifestSHA256 == targetSHA256,
      preState.release == preManifest.release, preState.manifestSHA256 == preSHA256,
      targetState.release == targetManifest.release, targetState.manifestSHA256 == targetSHA256,
      preState.status == "installed", targetState.status == "installed",
      preState.composeSHA256 == targetState.composeSHA256,
      preState.instanceID == targetState.instanceID, preState.volumes == targetState.volumes,
      preManifest.composeSHA256 == preState.composeSHA256,
      targetManifest.composeSHA256 == targetState.composeSHA256
    else { try runtimeFail("RUNTIME_RELEASE_TRANSITION_INVALID") }
    if value.kind == "upgrade" {
      guard try RuntimeManifestVerifier.compareVersions(value.fromRelease, value.toRelease) < 0,
        value.targetPreviousManifest == value.preManifest,
        targetHistory.highestAcceptedRelease == targetManifest.release,
        targetHistory.previousRelease == preManifest.release,
        targetHistory.previousManifestSHA256 == preSHA256,
        targetHistory.preUpgradeBackupID == value.safetyBackupID
      else { try runtimeFail("RUNTIME_RELEASE_TRANSITION_INVALID") }
    } else {
      guard try RuntimeManifestVerifier.compareVersions(value.fromRelease, value.toRelease) > 0,
        value.targetPreviousManifest.isEmpty,
        preHistory.previousRelease == targetManifest.release,
        preHistory.previousManifestSHA256 == targetSHA256,
        preHistory.preUpgradeBackupID != nil,
        targetHistory.highestAcceptedRelease == preHistory.highestAcceptedRelease,
        targetHistory.previousRelease == nil, targetHistory.previousManifestSHA256 == nil,
        targetHistory.preUpgradeBackupID == nil
      else { try runtimeFail("RUNTIME_RELEASE_TRANSITION_INVALID") }
    }
    runner.setManifest(preManifest)
    return (preState, preManifest, preHistory)
  }

  @discardableResult private func recoverInterruptedReleaseTransition() throws -> Bool {
    guard RuntimeStorage.pathExists(paths.transition) else {
      guard !RuntimeStorage.pathExists(paths.pendingManifest) else {
        try runtimeFail("RUNTIME_RELEASE_RECOVERY_REQUIRED")
      }
      return false
    }
    let restoreLan = releaseLanIntent()
    let transition = try RuntimeReleaseCodec.decodeTransition(
      RuntimeStorage.readPrivate(paths.transition, maximum: 524_288))
    let (state, payload, _) = try validatedTransition(transition)
    do {
      try emergencyStopLanGateway()
      try restoreReleaseSafetyBackup(
        transition.safetyBackupID, state: state, payload: payload)
      try RuntimeStorage.atomicWrite(transition.preManifest, to: paths.manifest)
      try RuntimeStorage.atomicWrite(transition.preState, to: paths.state)
      try RuntimeStorage.atomicWrite(transition.preHistory, to: paths.releaseHistory)
      if transition.prePreviousManifest.isEmpty {
        try RuntimeStorage.removePrivateFile(paths.previousManifest)
      } else {
        try RuntimeStorage.atomicWrite(
          transition.prePreviousManifest, to: paths.previousManifest)
      }
      try clearReleaseTransition()
      runner.setManifest(payload)
    } catch {
      _ = failClosedLanAfterReleaseRecovery(restore: restoreLan, error: error)
      try runtimeFail("RUNTIME_RELEASE_RECOVERY_REQUIRED")
    }
    _ = releaseLanOutcome(restore: restoreLan, state: state, payload: payload)
    return true
  }

  private func validateUpgrade(
    current: RuntimeManifestPayload, candidate: RuntimeManifestPayload,
    history: RuntimeReleaseHistory, composeSHA256: String
  ) throws {
    guard candidate.composeSHA256 == composeSHA256,
      try RuntimeManifestVerifier.compareVersions(candidate.release, current.release) > 0,
      try RuntimeManifestVerifier.compareVersions(
        candidate.release, history.highestAcceptedRelease) >= 0,
      let rollback = candidate.rollbackTarget,
      rollback.release == current.release,
      rollback.serverImageIndex == current.serverImage.index,
      rollback.maximumCompatibleSchema == current.maximumCompatibleSchema
    else { try runtimeFail("RUNTIME_UPGRADE_INCOMPATIBLE") }
  }

  private func validateRollback(
    current: RuntimeManifestPayload, previous: RuntimeManifestPayload,
    previousData: Data, history: RuntimeReleaseHistory, confirmation: String
  ) throws {
    guard let previousRelease = history.previousRelease,
      let previousManifestSHA256 = history.previousManifestSHA256,
      history.preUpgradeBackupID != nil,
      previousRelease == previous.release,
      previousManifestSHA256 == RuntimeManifestVerifier.sha256(previousData),
      confirmation == "ROLLBACK-\(previous.release)",
      let rollback = current.rollbackTarget,
      rollback.release == previous.release,
      rollback.serverImageIndex == previous.serverImage.index,
      rollback.maximumCompatibleSchema == previous.maximumCompatibleSchema,
      try RuntimeManifestVerifier.compareVersions(current.release, previous.release) > 0
    else { try runtimeFail("RUNTIME_ROLLBACK_INCOMPATIBLE") }
  }

  private func recoverAfterFailedUpgrade() throws {
    do {
      guard try recoverInterruptedReleaseTransition() else {
        try runtimeFail("RUNTIME_RELEASE_RECOVERY_REQUIRED")
      }
    } catch {
      try runtimeFail("RUNTIME_RELEASE_RECOVERY_REQUIRED")
    }
    try runtimeFail("RUNTIME_UPGRADE_ROLLED_BACK")
  }

  private func recoverAfterFailedRollback() throws {
    do {
      guard try recoverInterruptedReleaseTransition() else {
        try runtimeFail("RUNTIME_RELEASE_RECOVERY_REQUIRED")
      }
    } catch {
      try runtimeFail("RUNTIME_RELEASE_RECOVERY_REQUIRED")
    }
    try runtimeFail("RUNTIME_ROLLBACK_RECOVERED")
  }

  func upgrade(manifestURL: URL) throws -> RuntimeUpgradeResult {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      if try recoverInterruptedReleaseTransition() {
        try runtimeFail("RUNTIME_RELEASE_TRANSITION_RECOVERED")
      }
      let snapshot = try loadSnapshot()
      try initializeMaintenanceBaseline()
      let restoreLan = releaseLanIntent()
      let state = snapshot.state
      let current = snapshot.payload
      let stateData = snapshot.stateData
      let currentData = snapshot.manifestData
      let historyData = try releaseHistoryData(state)
      let history = try RuntimeReleaseCodec.decodeHistory(
        historyData, currentRelease: state.release)
      let previousData = try optionalPreviousManifest()
      let candidateData = try RuntimeStorage.readBounded(manifestURL)
      let candidate = try verifyManifest(candidateData)
      try validateUpgrade(
        current: current, candidate: candidate, history: history,
        composeSHA256: state.composeSHA256)

      let safety: RuntimeBackupSummary
      do {
        safety = try createReleaseSafetyBackup(
          kind: .preUpgrade, state: state, payload: current)
      } catch {
        _ = settleLanAfterFailedRelease(
          restore: restoreLan, state: state, payload: current)
        throw error
      }

      let candidateSHA256 = RuntimeManifestVerifier.sha256(candidateData)
      let candidateState = state.withRelease(
        candidate.release, manifestSHA256: candidateSHA256)
      let candidateStateData = try encodedState(candidateState)
      let candidateHistory = RuntimeReleaseHistory(
        version: 1, highestAcceptedRelease: candidate.release,
        previousRelease: current.release,
        previousManifestSHA256: RuntimeManifestVerifier.sha256(currentData),
        preUpgradeBackupID: safety.backupID)
      let candidateHistoryData = try RuntimeReleaseCodec.encode(candidateHistory)
      let prepared = RuntimeReleaseTransition(
        version: 2, kind: "upgrade", phase: "prepared",
        fromRelease: current.release, toRelease: candidate.release,
        fromManifestSHA256: state.manifestSHA256,
        toManifestSHA256: candidateSHA256, safetyBackupID: safety.backupID,
        preState: stateData, preManifest: currentData, preHistory: historyData,
        prePreviousManifest: previousData, targetState: candidateStateData,
        targetManifest: candidateData, targetHistory: candidateHistoryData,
        targetPreviousManifest: currentData)
      _ = try validatedTransition(prepared)
      do {
        try writeReleaseTransition(prepared)
      } catch {
        _ = settleLanAfterFailedRelease(
          restore: restoreLan, state: state, payload: current)
        throw error
      }
      do {
        try writeReleaseTransition(prepared.withPhase("applying"))
        runner.setManifest(candidate)
        try prepareImages(candidate)
        try assertImage(candidate)
        try gates(candidateState, candidate, bootstrap: false)
        try assertVolumes(candidateState)
        try run(
          compose(
            ["stop", "server"],
            environment: environment(candidateState, candidate)))
        try writeReleaseTransition(prepared.withPhase("committing"))
        try RuntimeStorage.atomicWrite(currentData, to: paths.previousManifest)
        try RuntimeStorage.atomicWrite(candidateData, to: paths.manifest)
        try RuntimeStorage.atomicWrite(candidateStateData, to: paths.state)
        try writeReleaseHistory(candidateHistory)
        try gates(candidateState, candidate, bootstrap: false)
      } catch {
        try recoverAfterFailedUpgrade()
      }
      do { try commitReleaseTransition() } catch {
        _ = failClosedLanAfterReleaseRecovery(restore: restoreLan, error: error)
        throw error
      }
      let lan = releaseLanOutcome(
        restore: restoreLan, state: candidateState, payload: candidate)
      return RuntimeUpgradeResult(
        status: "ready", release: candidate.release, previousRelease: current.release,
        safetyBackupID: safety.backupID, lanStatus: lan.status,
        lanFaultCode: lan.faultCode)
    }
  }

  func rollback(_ request: RuntimeRollbackRequest) throws -> RuntimeRollbackResult {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      if try recoverInterruptedReleaseTransition() {
        try runtimeFail("RUNTIME_RELEASE_TRANSITION_RECOVERED")
      }
      let snapshot = try loadSnapshot()
      try initializeMaintenanceBaseline()
      let restoreLan = releaseLanIntent()
      let state = snapshot.state
      let current = snapshot.payload
      let stateData = snapshot.stateData
      let historyData = try releaseHistoryData(state)
      let history = try RuntimeReleaseCodec.decodeHistory(
        historyData, currentRelease: state.release)
      let currentData = snapshot.manifestData
      let previousData = try RuntimeStorage.readPrivate(paths.previousManifest)
      let previous = try verifyManifest(previousData)
      try validateRollback(
        current: current, previous: previous, previousData: previousData, history: history,
        confirmation: request.confirmation)
      guard let preUpgradeBackupID = history.preUpgradeBackupID else {
        try runtimeFail("RUNTIME_ROLLBACK_INCOMPATIBLE")
      }

      let recovery: RuntimeBackupSummary
      do {
        recovery = try createReleaseSafetyBackup(
          kind: .preRollback, state: state, payload: current)
      } catch {
        _ = settleLanAfterFailedRelease(
          restore: restoreLan, state: state, payload: current)
        throw error
      }
      let previousState = state.withRelease(
        previous.release, manifestSHA256: RuntimeManifestVerifier.sha256(previousData))
      let previousStateData = try encodedState(previousState)
      let previousHistory = RuntimeReleaseHistory(
        version: 1, highestAcceptedRelease: history.highestAcceptedRelease,
        previousRelease: nil, previousManifestSHA256: nil, preUpgradeBackupID: nil)
      let previousHistoryData = try RuntimeReleaseCodec.encode(previousHistory)
      let prepared = RuntimeReleaseTransition(
        version: 2, kind: "rollback", phase: "prepared",
        fromRelease: current.release, toRelease: previous.release,
        fromManifestSHA256: state.manifestSHA256,
        toManifestSHA256: RuntimeManifestVerifier.sha256(previousData),
        safetyBackupID: recovery.backupID,
        preState: stateData, preManifest: currentData, preHistory: historyData,
        prePreviousManifest: previousData, targetState: previousStateData,
        targetManifest: previousData, targetHistory: previousHistoryData,
        targetPreviousManifest: Data())
      _ = try validatedTransition(prepared)
      do {
        try writeReleaseTransition(prepared)
      } catch {
        _ = settleLanAfterFailedRelease(
          restore: restoreLan, state: state, payload: current)
        throw error
      }
      do {
        try writeReleaseTransition(prepared.withPhase("applying"))
        try restoreReleaseSafetyBackup(
          preUpgradeBackupID, state: previousState, payload: previous)
        try writeReleaseTransition(prepared.withPhase("committing"))
        try RuntimeStorage.atomicWrite(previousData, to: paths.manifest)
        try RuntimeStorage.atomicWrite(previousStateData, to: paths.state)
        try writeReleaseHistory(previousHistory)
        try RuntimeStorage.removePrivateFile(paths.previousManifest)
      } catch {
        try recoverAfterFailedRollback()
      }
      do { try commitReleaseTransition() } catch {
        _ = failClosedLanAfterReleaseRecovery(restore: restoreLan, error: error)
        throw error
      }
      runner.setManifest(previous)
      let lan = releaseLanOutcome(
        restore: restoreLan, state: previousState, payload: previous)
      return RuntimeRollbackResult(
        status: "ready", release: previous.release, rolledBackFrom: current.release,
        recoveryBackupID: recovery.backupID, lanStatus: lan.status,
        lanFaultCode: lan.faultCode)
    }
  }
}
