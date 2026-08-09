import Foundation

extension NativeRuntimeController {
  private func failLanStop() throws -> Never {
    do { try RuntimeLanStorage.quarantinePhysicalState(paths) } catch {
      try runtimeFail("RUNTIME_LAN_STOP_FAILED")
    }
    try runtimeFail("RUNTIME_LAN_STOP_FAILED")
  }

  func emergencyStopLanGateway() throws {
    let projectLabel = "label=com.docker.compose.project=\(runtimeProject)"
    let serviceLabel = "label=com.docker.compose.service=lan-gateway"
    let result: RuntimeCommandResult
    do {
      result = try run(
        command([
          "ps", "--all", "--quiet", "--filter", projectLabel,
          "--filter", serviceLabel,
        ]))
    } catch { try failLanStop() }
    let trimmed = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed == "[]" { return }
    let identifiers = trimmed.split(whereSeparator: \.isNewline).map(String.init)
    guard (1...32).contains(identifiers.count),
      identifiers.allSatisfy({
        $0.range(of: "^[0-9a-f]{12,64}$", options: .regularExpression) != nil
      })
    else { try failLanStop() }
    do { try run(command(["rm", "-f"] + identifiers)) } catch {
      try failLanStop()
    }
  }

  private func lanPayload(_ payload: RuntimeManifestPayload) throws -> (String, String) {
    guard payload.schemaVersion == 2,
      let composeSHA256 = payload.lanComposeSHA256,
      let ownerSPASHA256 = payload.ownerSPASHA256
    else { try runtimeFail("RUNTIME_LAN_MANIFEST_V2_REQUIRED") }
    let data: Data
    do { data = try RuntimeStorage.readBounded(paths.lanCompose, maximum: 524_288) } catch {
      try runtimeFail("RUNTIME_LAN_RESOURCE_CHECKSUM_MISMATCH")
    }
    guard RuntimeManifestVerifier.sha256(data) == composeSHA256 else {
      try runtimeFail("RUNTIME_LAN_RESOURCE_CHECKSUM_MISMATCH")
    }
    return (composeSHA256, ownerSPASHA256)
  }

  func lanCompose(
    _ args: [String], generation: RuntimeLanGeneration,
    state: RuntimeState, payload: RuntimeManifestPayload
  ) -> RuntimeCommandSpec {
    command(
      [
        "compose", "--project-name", runtimeProject,
        "--env-file", generation.environment.path,
        "--file", paths.compose.path,
        "--file", paths.lanCompose.path,
      ] + args,
      environment: environment(state, payload))
  }

  func persistLanDisabled() throws {
    guard
      RuntimeStorage.pathExists(paths.lanState)
        || RuntimeStorage.pathExists(paths.lanUncertainState)
        || RuntimeStorage.pathExists(paths.lanPhysicalUncertainState)
    else { try runtimeFail("RUNTIME_LAN_PROFILE_MISSING") }
    do {
      try RuntimeLanStorage.persistDisabledAuthority(paths)
    } catch {
      try RuntimeLanStorage.quarantineState(paths)
      try runtimeFail("RUNTIME_LAN_STATE_COMMIT_FAILED")
    }
  }

  private func restoreLoopbackServer(
    state: RuntimeState, payload: RuntimeManifestPayload
  ) throws {
    let environment = environment(state, payload)
    try run(
      compose(
        ["up", "-d", "--wait", "--force-recreate", "--no-deps", "server"],
        environment: environment))
    let health = try run(
      RuntimeCommandSpec(
        executable: "/usr/bin/curl",
        arguments: [
          "--fail", "--silent", "--show-error", "--max-time", "3",
          "http://127.0.0.1:8787/health",
        ], environment: [:]))
    guard let data = health.stdout.data(using: .utf8),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      root["ok"] as? Bool == true,
      (root["data"] as? [String: Any])?["status"] as? String == "ready"
    else { try runtimeFail("RUNTIME_HEALTH_GATE_FAILED") }
  }

  func validateLanGeneration(
    _ generation: RuntimeLanGeneration, payload: RuntimeManifestPayload,
    requireAvailablePort: Bool
  ) throws {
    let digests = try lanPayload(payload)
    guard generation.profile.lanComposeSHA256 == digests.0,
      generation.profile.ownerSPASHA256 == digests.1
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
    try RuntimeLanValidation.validateAddress(generation.profile.bindIPv4)
    try RuntimeLanValidation.validatePort(
      generation.profile.port, bindIPv4: generation.profile.bindIPv4,
      requireAvailable: requireAvailablePort)
    let certificate = try RuntimeLanValidation.certificate(
      certificatePEM: String(
        decoding: RuntimeStorage.readPrivate(generation.certificate, maximum: 16_384),
        as: UTF8.self),
      privateKeyPEM: String(
        decoding: RuntimeStorage.readPrivate(generation.privateKey, maximum: 16_384),
        as: UTF8.self),
      bindIPv4: generation.profile.bindIPv4)
    guard certificate.fingerprintSHA256 == generation.profile.certificateFingerprintSHA256,
      certificate.validNotAfter == generation.profile.validNotAfter,
      certificate.ipSANs == generation.profile.ipSANs
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
  }

  private func startGateway(
    generation: RuntimeLanGeneration, state: RuntimeState, payload: RuntimeManifestPayload
  ) throws {
    try validateLanGeneration(generation, payload: payload, requireAvailablePort: true)
    do {
      try run(
        lanCompose(
          ["up", "-d", "--wait", "lan-gateway"], generation: generation,
          state: state, payload: payload))
      guard try lanHTTPSCheck(path: "/health", generation: generation),
        try lanHTTPSCheck(path: "/owner", generation: generation)
      else {
        try runtimeFail("RUNTIME_LAN_START_FAILED")
      }
    } catch {
      try runtimeFail("RUNTIME_LAN_START_FAILED")
    }
  }

  func configureLan(_ setup: RuntimeLanSetup) throws -> RuntimeLanSummary {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      let (state, payload) = try load()
      if payload.schemaVersion == 2 {
        _ = try lanPayload(payload)
      } else if payload.schemaVersion != 1 {
        try runtimeFail("RUNTIME_LAN_MANIFEST_V2_REQUIRED")
      }
      try RuntimeLanValidation.validateAddress(setup.bindIPv4)
      try RuntimeLanValidation.validatePort(
        setup.port, bindIPv4: setup.bindIPv4, requireAvailable: false)
      let certificate = try RuntimeLanValidation.certificate(
        certificatePEM: setup.certificatePEM,
        privateKeyPEM: setup.privateKeyPEM, bindIPv4: setup.bindIPv4)
      let hadConfiguration =
        RuntimeStorage.pathExists(paths.lanState)
        || RuntimeStorage.pathExists(paths.lanUncertainState)
        || RuntimeStorage.pathExists(paths.lanPhysicalUncertainState)
      try emergencyStopLanGateway()
      if RuntimeStorage.pathExists(paths.lanState) {
        try persistLanDisabled()
      }
      if hadConfiguration {
        try restoreLoopbackServer(state: state, payload: payload)
      }
      try RuntimeLanValidation.validatePort(
        setup.port, bindIPv4: setup.bindIPv4, requireAvailable: true)
      if RuntimeStorage.pathExists(paths.lanUncertainState) {
        try RuntimeStorage.removePrivateFile(paths.lanUncertainState)
      }
      if RuntimeStorage.pathExists(paths.lanPhysicalUncertainState) {
        try RuntimeStorage.removePrivateFile(paths.lanPhysicalUncertainState)
      }
      let generation = try RuntimeLanStorage.create(
        paths: paths, setup: setup, certificate: certificate, payload: payload)
      return RuntimeLanStorage.summary(generation)
    }
  }

  func enableLan() throws -> RuntimeLanSummary {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      let (state, payload) = try load()
      try emergencyStopLanGateway()
      do {
        let generation = try RuntimeLanStorage.load(paths)
        try assertVolumes(state)
        try assertImage(payload)
        try gates(state, payload, bootstrap: false)
        try startGateway(generation: generation, state: state, payload: payload)
        return RuntimeLanStorage.summary(
          try RuntimeLanStorage.setStatus("enabled", paths: paths))
      } catch {
        let failure = error
        try emergencyStopLanGateway()
        try persistLanDisabled()
        throw failure
      }
    }
  }

  func disableLan() throws -> RuntimeLanSummary {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try emergencyStopLanGateway()
      try persistLanDisabled()
      return RuntimeLanStorage.summary(try RuntimeLanStorage.load(paths))
    }
  }

  func lanStatus() -> RuntimeLanStatus {
    if RuntimeStorage.pathExists(paths.lanPhysicalUncertainState) {
      return RuntimeLanStatus(
        configured: false, enabled: false, generation: nil, bindIPv4: nil, port: nil,
        certificateFingerprintSHA256: nil, validNotAfter: nil,
        faultCode: "RUNTIME_LAN_PHYSICAL_STATE_UNCERTAIN")
    }
    if RuntimeStorage.pathExists(paths.lanUncertainState) {
      return RuntimeLanStatus(
        configured: false, enabled: false, generation: nil, bindIPv4: nil, port: nil,
        certificateFingerprintSHA256: nil, validNotAfter: nil,
        faultCode: "RUNTIME_LAN_STATE_COMMIT_FAILED")
    }
    do {
      let value = try RuntimeLanStorage.load(paths)
      return RuntimeLanStatus(
        configured: true, enabled: value.state.status == "enabled",
        generation: value.profile.generation, bindIPv4: value.profile.bindIPv4,
        port: value.profile.port,
        certificateFingerprintSHA256: value.profile.certificateFingerprintSHA256,
        validNotAfter: value.profile.validNotAfter, faultCode: nil)
    } catch {
      let code = (error as? RuntimeKitError)?.description ?? "RUNTIME_LAN_PROFILE_INVALID"
      return RuntimeLanStatus(
        configured: false, enabled: false, generation: nil, bindIPv4: nil, port: nil,
        certificateFingerprintSHA256: nil, validNotAfter: nil,
        faultCode: code == "RUNTIME_LAN_PROFILE_MISSING" ? nil : code)
    }
  }

  func lanOnboarding() throws -> RuntimeLanOnboarding {
    let (_, payload) = try load()
    let generation = try RuntimeLanStorage.load(paths)
    try validateLanGeneration(generation, payload: payload, requireAvailablePort: false)
    let url = "https://\(generation.profile.bindIPv4):\(generation.profile.port)/owner"
    return RuntimeLanOnboarding(
      ownerURL: url,
      certificateFingerprintSHA256: generation.profile.certificateFingerprintSHA256,
      validNotAfter: generation.profile.validNotAfter,
      ipSANs: generation.profile.ipSANs, qr: try RuntimeLanQR.terminal(url))
  }

  func restoreEnabledLanAfterServerStart(
    state: RuntimeState, payload: RuntimeManifestPayload
  ) throws {
    if RuntimeStorage.pathExists(paths.lanPhysicalUncertainState) {
      try runtimeFail("RUNTIME_LAN_STOP_FAILED")
    }
    if RuntimeStorage.pathExists(paths.lanUncertainState) {
      try emergencyStopLanGateway()
      try runtimeFail("RUNTIME_LAN_STATE_COMMIT_FAILED")
    }
    guard RuntimeStorage.pathExists(paths.lanState) else { return }
    try emergencyStopLanGateway()
    let generation = try RuntimeLanStorage.load(paths)
    guard generation.state.status == "enabled" else { return }
    do {
      try startGateway(generation: generation, state: state, payload: payload)
    } catch {
      let failure = error
      try emergencyStopLanGateway()
      try persistLanDisabled()
      throw failure
    }
  }
}
