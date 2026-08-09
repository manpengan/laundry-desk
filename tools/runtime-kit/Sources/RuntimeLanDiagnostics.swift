import Foundation

extension NativeRuntimeController {
  private func lanCheck(_ code: String, _ body: () throws -> Bool) -> RuntimeLanCheck {
    do { return RuntimeLanCheck(code: code, ok: try body()) } catch {
      return RuntimeLanCheck(code: code, ok: false)
    }
  }

  func lanHTTPSCheck(
    path: String, generation: RuntimeLanGeneration
  ) throws -> Bool {
    let host = generation.profile.bindIPv4
    let port = generation.profile.port
    let result = try run(
      RuntimeCommandSpec(
        executable: "/usr/bin/curl",
        arguments: [
          "--fail", "--silent", "--show-error", "--max-time", "3",
          "--output", "/dev/null", "--cacert", generation.certificate.path,
          "https://\(host):\(port)\(path)",
        ], environment: [:]), accepting: [0, 6, 7, 22, 28, 35, 52, 56, 60])
    return result.code == 0
  }

  func diagnoseLan() -> RuntimeLanDiagnosis {
    do {
      let (state, payload) = try load()
      let generation = try RuntimeLanStorage.load(paths)
      var checks = [
        lanCheck("LAN_PROFILE_VALID") {
          try validateLanGeneration(
            generation, payload: payload, requireAvailablePort: false)
          return true
        },
        RuntimeLanCheck(
          code: "LAN_EXPLICITLY_ENABLED", ok: generation.state.status == "enabled"),
        lanCheck("LAN_SERVER_LOOPBACK_READY") {
          let result = try run(
            RuntimeCommandSpec(
              executable: "/usr/bin/curl",
              arguments: [
                "--fail", "--silent", "--show-error", "--max-time", "3",
                "http://127.0.0.1:8787/health",
              ], environment: [:]), accepting: [0, 6, 7, 22, 28, 52, 56])
          return result.code == 0
        },
        lanCheck("LAN_GATEWAY_CONTAINER_READY") {
          let result = try run(
            lanCompose(
              ["ps", "--status", "running", "--quiet", "lan-gateway"],
              generation: generation, state: state, payload: payload), accepting: [0, 1])
          let identifiers = result.stdout.split(whereSeparator: \.isNewline).map(String.init)
          return result.code == 0 && identifiers.count == 1
            && identifiers[0].range(
              of: "^[0-9a-f]{12,64}$", options: .regularExpression) != nil
        },
        lanCheck("LAN_HTTPS_HEALTH_READY") {
          try lanHTTPSCheck(path: "/health", generation: generation)
        },
        lanCheck("LAN_HTTPS_OWNER_READY") {
          try lanHTTPSCheck(path: "/owner", generation: generation)
        },
      ]
      checks.append(
        RuntimeLanCheck(
          code: "LAN_SERVER_PORT_ISOLATED",
          ok: !RuntimeLanValidation.portAcceptsConnections(
            generation.profile.bindIPv4, 8787)))
      checks.append(
        RuntimeLanCheck(
          code: "LAN_POSTGRES_PORT_ISOLATED",
          ok: !RuntimeLanValidation.portAcceptsConnections(
            generation.profile.bindIPv4, 8543)))
      let ok = checks.allSatisfy(\.ok)
      return RuntimeLanDiagnosis(
        ok: ok, checks: checks,
        certificateFingerprintSHA256: generation.profile.certificateFingerprintSHA256,
        validNotAfter: generation.profile.validNotAfter,
        faultCode: ok ? nil : "RUNTIME_LAN_DIAGNOSE_FAILED")
    } catch {
      let code = (error as? RuntimeKitError)?.description ?? "RUNTIME_LAN_DIAGNOSE_FAILED"
      return RuntimeLanDiagnosis(
        ok: false, checks: [RuntimeLanCheck(code: "LAN_PROFILE_VALID", ok: false)],
        certificateFingerprintSHA256: nil, validNotAfter: nil, faultCode: code)
    }
  }
}
