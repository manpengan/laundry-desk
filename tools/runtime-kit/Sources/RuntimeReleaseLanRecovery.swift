import Foundation

extension NativeRuntimeController {
  func releaseLanIntent() -> Bool { lanStatus().enabled }

  func releaseLanOutcome(
    restore: Bool, state: RuntimeState, payload: RuntimeManifestPayload
  ) -> (status: String, faultCode: String?) {
    guard restore else {
      let current = lanStatus()
      if current.faultCode == "RUNTIME_LAN_PHYSICAL_STATE_UNCERTAIN" {
        return ("physical_state_uncertain", "RUNTIME_LAN_STOP_FAILED")
      }
      if current.faultCode == "RUNTIME_LAN_STATE_COMMIT_FAILED" {
        return ("state_commit_uncertain", current.faultCode)
      }
      if current.configured {
        return (current.enabled ? "enabled" : "disabled", current.faultCode)
      }
      return (current.faultCode == nil ? "not_configured" : "invalid", current.faultCode)
    }
    do {
      try restoreEnabledLanAfterServerStart(state: state, payload: payload)
      return ("enabled", nil)
    } catch {
      let code = (error as? RuntimeKitError)?.description ?? "RUNTIME_LAN_START_FAILED"
      if lanStatus().faultCode == "RUNTIME_LAN_PHYSICAL_STATE_UNCERTAIN" {
        return ("physical_state_uncertain", code)
      }
      return (
        code == "RUNTIME_LAN_STATE_COMMIT_FAILED"
          ? "state_commit_uncertain" : "disabled_after_restore_failure",
        code
      )
    }
  }

  private func failClosedReleaseLan(_ faultCode: String) -> (
    status: String, faultCode: String?
  ) {
    do { try emergencyStopLanGateway() } catch {
      return (
        "stop_failed_state_enabled",
        (error as? RuntimeKitError)?.description ?? "RUNTIME_LAN_STOP_FAILED"
      )
    }
    var code = faultCode
    do { try persistLanDisabled() } catch {
      code = "RUNTIME_LAN_STATE_COMMIT_FAILED"
    }
    return (
      code == "RUNTIME_LAN_STATE_COMMIT_FAILED"
        ? "state_commit_uncertain" : "disabled_after_restore_failure",
      code
    )
  }

  @discardableResult func settleLanAfterFailedRelease(
    restore: Bool, state: RuntimeState, payload: RuntimeManifestPayload
  ) -> (status: String, faultCode: String?) {
    runner.setManifest(payload)
    do {
      try emergencyStopLanGateway()
      try gates(state, payload, bootstrap: false)
    } catch {
      guard restore else {
        if lanStatus().faultCode == "RUNTIME_LAN_PHYSICAL_STATE_UNCERTAIN" {
          return ("physical_state_uncertain", "RUNTIME_LAN_STOP_FAILED")
        }
        return ("disabled", (error as? RuntimeKitError)?.description)
      }
      return failClosedReleaseLan(
        (error as? RuntimeKitError)?.description ?? "RUNTIME_HEALTH_GATE_FAILED")
    }
    return releaseLanOutcome(restore: restore, state: state, payload: payload)
  }

  func requireKnownLanMaintenanceOutcome(
    _ outcome: (status: String, faultCode: String?)
  ) throws {
    guard
      ["state_commit_uncertain", "physical_state_uncertain", "stop_failed_state_enabled"]
        .contains(outcome.status)
    else { return }
    try runtimeFail(outcome.faultCode ?? "RUNTIME_LAN_STOP_FAILED")
  }

  func stopServerAfterUnsafeMaintenance(
    state: RuntimeState, payload: RuntimeManifestPayload
  ) throws {
    do {
      try run(
        compose(
          ["stop", "server"],
          environment: environment(state, payload)))
    } catch { try runtimeFail("RUNTIME_LAN_STOP_FAILED") }
  }

  @discardableResult func failClosedLanAfterReleaseRecovery(
    restore: Bool, error: Error
  ) -> (status: String, faultCode: String?) {
    guard restore else {
      do { try emergencyStopLanGateway() } catch {
        return (
          "physical_state_uncertain",
          (error as? RuntimeKitError)?.description ?? "RUNTIME_LAN_STOP_FAILED"
        )
      }
      return ("disabled", (error as? RuntimeKitError)?.description)
    }
    return failClosedReleaseLan(
      (error as? RuntimeKitError)?.description ?? "RUNTIME_RELEASE_RECOVERY_REQUIRED")
  }
}
