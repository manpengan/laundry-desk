import Foundation

extension NativeRuntimeController {
  private func removeCommissionSecrets() throws {
    do { try RuntimeStorage.removeBootstrapSecrets(paths.secrets) } catch {
      try runtimeFail("RUNTIME_COMMISSION_SECRET_CLEANUP_FAILED")
    }
  }

  private func writeCommissionSecrets(_ setup: RuntimeCommissionSetup) throws {
    let values = RuntimeStorage.buildCommissionSecrets(setup)
    for name in RuntimeStorage.bootstrapSecrets where name.hasPrefix("bootstrap-approver-") {
      guard let value = values[name]?.data(using: .utf8) else {
        try runtimeFail("RUNTIME_SETUP_INVALID")
      }
      try RuntimeStorage.writeExclusive(
        value, to: paths.secrets.appendingPathComponent(name))
    }
  }

  private func commissionUnlocked(_ setup: RuntimeCommissionSetup) throws
    -> RuntimeCommissionResult
  {
    let stateData = try RuntimeStorage.readPrivate(paths.state)
    guard try decodeState(stateData).status == "installed"
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    let (state, payload) = try load()
    try assertVolumes(state)
    try assertImage(payload)
    let env = environment(state, payload)
    let restoreLan = releaseLanIntent()
    try emergencyStopLanGateway()
    var authorityMutationStarted = false
    var cleanupFailed = false
    do {
      try run(compose(["stop", "server"], environment: env))
      // A process interruption can leave short-lived approver files behind.
      // Keep every serving surface stopped until their durable removal succeeds.
      do { try removeCommissionSecrets() } catch {
        cleanupFailed = true
        throw error
      }
      try run(compose(["up", "-d", "--wait", "postgres"], environment: env))
      authorityMutationStarted = true
      try run(compose(["run", "--rm", "roles"], environment: env))
      try run(compose(["run", "--rm", "migrate"], environment: env))
      try writeCommissionSecrets(setup)
      try run(compose(["run", "--rm", "commission"], environment: env))
      try run(compose(["run", "--rm", "verify", "verify-commissioned"], environment: env))
      try removeCommissionSecrets()
      try gates(state, payload, bootstrap: false)
    } catch {
      var operationError = error
      do { try removeCommissionSecrets() } catch {
        operationError = error
        cleanupFailed = true
      }
      if authorityMutationStarted || cleanupFailed {
        do { try stopServerAfterUnsafeMaintenance(state: state, payload: payload) } catch {
          if !cleanupFailed { operationError = error }
        }
      }
      let outcome =
        authorityMutationStarted || cleanupFailed
        ? failClosedLanAfterReleaseRecovery(restore: restoreLan, error: operationError)
        : settleLanAfterFailedRelease(restore: restoreLan, state: state, payload: payload)
      if cleanupFailed { try runtimeFail("RUNTIME_COMMISSION_SECRET_CLEANUP_FAILED") }
      try requireKnownLanMaintenanceOutcome(outcome)
      throw operationError
    }
    let outcome = releaseLanOutcome(restore: restoreLan, state: state, payload: payload)
    try requireKnownLanMaintenanceOutcome(outcome)
    return RuntimeCommissionResult(
      status: "commissioned", release: payload.release,
      lanStatus: outcome.status, lanFaultCode: outcome.faultCode)
  }

  func commission(_ setup: RuntimeCommissionSetup) throws -> RuntimeCommissionResult {
    try validateRuntimeCommissionSetup(setup)
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      return try commissionUnlocked(setup)
    }
  }
}
