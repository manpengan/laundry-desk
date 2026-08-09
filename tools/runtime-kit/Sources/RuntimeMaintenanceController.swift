import Foundation

extension NativeRuntimeController {
  private func maintenanceTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  private func readMaintenanceState() throws -> RuntimeMaintenanceState? {
    guard RuntimeStorage.pathExists(paths.maintenanceState) else { return nil }
    let data = try RuntimeStorage.readPrivate(paths.maintenanceState, maximum: 16_384)
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys).isSubset(of: [
        "version", "phase", "last_attempt_at", "last_success_at", "last_failure_at",
        "last_failure_code", "last_backup_id", "corrupt_backups", "deleted_backups",
      ]),
      Set(object.keys).isSuperset(of: [
        "version", "phase", "last_attempt_at", "corrupt_backups", "deleted_backups",
      ]),
      let value = try? JSONDecoder().decode(RuntimeMaintenanceState.self, from: data),
      value.version == 1, ["idle", "in_progress", "failed"].contains(value.phase),
      value.corruptBackups >= 0, value.deletedBackups >= 0
    else { try runtimeFail("RUNTIME_MAINTENANCE_STATE_INVALID") }
    return value
  }

  private func writeMaintenanceState(_ value: RuntimeMaintenanceState) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    do {
      try RuntimeStorage.atomicWrite(try encoder.encode(value), to: paths.maintenanceState)
    } catch { try runtimeFail("RUNTIME_MAINTENANCE_STATE_COMMIT_FAILED") }
  }

  func initializeMaintenanceBaseline(now: Date = Date()) throws {
    guard !RuntimeStorage.pathExists(paths.maintenanceState) else {
      _ = try readMaintenanceState()
      return
    }
    try writeMaintenanceState(
      RuntimeMaintenanceState(
        version: 1, phase: "idle", lastAttemptAt: maintenanceTimestamp(now),
        lastSuccessAt: nil, lastFailureAt: nil, lastFailureCode: nil,
        lastBackupID: nil, corruptBackups: 0, deletedBackups: 0))
  }

  private func attemptState(_ now: Date) throws -> RuntimeMaintenanceState {
    let previous = try readMaintenanceState()
    return RuntimeMaintenanceState(
      version: 1, phase: "in_progress", lastAttemptAt: maintenanceTimestamp(now),
      lastSuccessAt: previous?.lastSuccessAt, lastFailureAt: previous?.lastFailureAt,
      lastFailureCode: previous?.lastFailureCode, lastBackupID: previous?.lastBackupID,
      corruptBackups: previous?.corruptBackups ?? 0,
      deletedBackups: previous?.deletedBackups ?? 0)
  }

  func maintenance() throws -> RuntimeMaintenanceResult {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      let now = Date()
      let attempt = try attemptState(now)
      try writeMaintenanceState(attempt)
      do {
        let (state, payload) = try load()
        try RuntimeMaintenanceRetention.resumeStaging(paths)
        let before = try listBackupsUnlocked(state: state, payload: payload)
        let deletedBefore =
          before.count > RuntimeBackupCodec.maximumBackups
          ? try RuntimeMaintenanceRetention.apply(paths: paths, summaries: before, now: now)
          : 0
        let restoreLan = releaseLanIntent()
        try emergencyStopLanGateway()
        let summary: RuntimeBackupSummary
        do {
          summary = try createManagedBackup(
            kind: .scheduled, state: state, payload: payload, restartAfter: true)
        } catch {
          let failure = error
          let outcome = settleLanAfterFailedRelease(
            restore: restoreLan, state: state, payload: payload)
          try requireKnownLanMaintenanceOutcome(outcome)
          throw failure
        }
        let lan = releaseLanOutcome(restore: restoreLan, state: state, payload: payload)
        try requireKnownLanMaintenanceOutcome(lan)
        let summaries = try listBackupsUnlocked(state: state, payload: payload)
        let corrupt = summaries.filter { !$0.verified }.count
        let deleted = try RuntimeMaintenanceRetention.apply(
          paths: paths, summaries: summaries, now: now)
        try writeMaintenanceState(
          RuntimeMaintenanceState(
            version: 1, phase: "idle", lastAttemptAt: attempt.lastAttemptAt,
            lastSuccessAt: maintenanceTimestamp(Date()), lastFailureAt: nil,
            lastFailureCode: nil, lastBackupID: summary.backupID,
            corruptBackups: corrupt, deletedBackups: deletedBefore + deleted))
        return RuntimeMaintenanceResult(
          status: "ready", backupID: summary.backupID,
          corruptBackups: corrupt, deletedBackups: deletedBefore + deleted,
          lanStatus: lan.status, lanFaultCode: lan.faultCode)
      } catch {
        let code = (error as? RuntimeKitError)?.description ?? "RUNTIME_MAINTENANCE_FAILED"
        try writeMaintenanceState(
          RuntimeMaintenanceState(
            version: 1, phase: "failed", lastAttemptAt: attempt.lastAttemptAt,
            lastSuccessAt: attempt.lastSuccessAt,
            lastFailureAt: maintenanceTimestamp(Date()), lastFailureCode: code,
            lastBackupID: attempt.lastBackupID, corruptBackups: attempt.corruptBackups,
            deletedBackups: attempt.deletedBackups))
        throw error
      }
    }
  }

  func diagnoseMaintenance(now: Date = Date()) -> RuntimeMaintenanceDiagnosis {
    do {
      guard let state = try readMaintenanceState() else {
        return RuntimeMaintenanceDiagnosis(
          ok: false, stale: true, lastAttemptAt: nil, lastSuccessAt: nil,
          lastFailureCode: nil, lastBackupID: nil, corruptBackups: 0, deletedBackups: 0)
      }
      let baseline = ISO8601DateFormatter().date(
        from: state.lastSuccessAt ?? state.lastAttemptAt)
      let stale = baseline.map { now.timeIntervalSince($0) > 26 * 60 * 60 } ?? true
      let interrupted = state.phase == "in_progress"
      return RuntimeMaintenanceDiagnosis(
        ok: !stale && !interrupted && state.lastFailureCode == nil
          && state.corruptBackups == 0,
        stale: stale, lastAttemptAt: state.lastAttemptAt,
        lastSuccessAt: state.lastSuccessAt,
        lastFailureCode: interrupted
          ? "RUNTIME_MAINTENANCE_INTERRUPTED" : state.lastFailureCode,
        lastBackupID: state.lastBackupID, corruptBackups: state.corruptBackups,
        deletedBackups: state.deletedBackups)
    } catch {
      return RuntimeMaintenanceDiagnosis(
        ok: false, stale: true, lastAttemptAt: nil, lastSuccessAt: nil,
        lastFailureCode: "RUNTIME_MAINTENANCE_STATE_INVALID", lastBackupID: nil,
        corruptBackups: 0, deletedBackups: 0)
    }
  }

  func diagnose() -> RuntimeDiagnosis {
    let maintenance = diagnoseMaintenance()
    let transfer = transferDiagnosis()
    do {
      let (state, payload) = try load()
      let volumes = try assertVolumes(state)
      let services = try run(
        compose(
          ["ps", "--format", "json"], environment: environment(state, payload)),
        accepting: [0, 1])
      let commissioning = try? run(
        compose(
          ["run", "--rm", "--no-deps", "verify", "commission-status"],
          environment: environment(state, payload)))
      let commissionRequired = commissioning.flatMap { result -> Bool? in
        guard let data = result.stdout.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["commission_required"] as? Bool
      }
      return RuntimeDiagnosis(
        ok: maintenance.ok && transfer.phase == nil,
        project: runtimeProject, release: payload.release,
        migrationHead: payload.migrationHead, faultCode: nil,
        commissionRequired: commissionRequired,
        databaseVolumePresent: volumes.first(where: { $0.logical == "pgdata-v2" })?.exists,
        photoVolumePresent: volumes.first(where: { $0.logical == "photos" })?.exists,
        composeReachable: services.code == 0, maintenance: maintenance,
        transferPhase: transfer.phase, transferFaultCode: transfer.faultCode)
    } catch {
      let code = (error as? RuntimeKitError)?.description ?? "RUNTIME_DIAGNOSE_FAILED"
      return RuntimeDiagnosis(
        ok: false, project: runtimeProject, release: nil,
        migrationHead: nil, faultCode: code, commissionRequired: nil,
        databaseVolumePresent: nil, photoVolumePresent: nil,
        composeReachable: nil, maintenance: maintenance,
        transferPhase: transfer.phase, transferFaultCode: transfer.faultCode)
    }
  }
}
