import Foundation

private struct RuntimeSupportRuntime: Codable {
  let code: String
  let release: String?
}

private struct RuntimeSupportServer: Codable {
  let code: String
  let migrationHead: String?

  enum CodingKeys: String, CodingKey {
    case code
    case migrationHead = "migration_head"
  }
}

private struct RuntimeSupportLan: Codable {
  let code: String
  let enabled: Bool
  let passedChecks: Int
  let totalChecks: Int

  enum CodingKeys: String, CodingKey {
    case code, enabled
    case passedChecks = "passed_checks"
    case totalChecks = "total_checks"
  }
}

private struct RuntimeSupportBackup: Codable {
  let code: String
  let totalCount: Int
  let verifiedCount: Int
  let invalidCount: Int

  enum CodingKeys: String, CodingKey {
    case code
    case totalCount = "total_count"
    case verifiedCount = "verified_count"
    case invalidCount = "invalid_count"
  }
}

private struct RuntimeSupportPrinting: Codable {
  let code: String
  let queueCount: Int

  enum CodingKeys: String, CodingKey {
    case code
    case queueCount = "queue_count"
  }
}

private struct RuntimeSupportBundlePayload: Codable {
  let schemaVersion: Int
  let generatedAt: String
  let runtime: RuntimeSupportRuntime
  let server: RuntimeSupportServer
  let lan: RuntimeSupportLan
  let backup: RuntimeSupportBackup
  let printing: RuntimeSupportPrinting

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case generatedAt = "generated_at"
    case runtime, server, lan, backup, printing
  }
}

extension NativeRuntimeController {
  private func supportBackups(
    state: RuntimeState, payload: RuntimeManifestPayload
  ) throws -> RuntimeSupportBackup {
    let values = try listBackupsUnlocked(state: state, payload: payload)
    let verified = values.filter(\.verified).count
    return RuntimeSupportBackup(
      code: values.contains(where: { !$0.verified }) ? "BACKUP_ATTENTION" : "BACKUP_OK",
      totalCount: values.count, verifiedCount: verified,
      invalidCount: values.count - verified)
  }

  func createSupportBundle() throws -> RuntimeSupportCreateResult {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      let (state, manifest) = try load()
      let runtime = diagnose()
      let lanDiagnosis = diagnoseLan()
      let lanStatus = lanStatus()
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime]
      let payload = RuntimeSupportBundlePayload(
        schemaVersion: 1, generatedAt: formatter.string(from: Date()),
        runtime: RuntimeSupportRuntime(
          code: runtime.ok ? "RUNTIME_OK" : "RUNTIME_ATTENTION",
          release: runtime.release),
        server: RuntimeSupportServer(
          code: runtime.composeReachable == true ? "SERVER_OK" : "SERVER_ATTENTION",
          migrationHead: runtime.migrationHead),
        lan: RuntimeSupportLan(
          code: lanDiagnosis.ok ? "LAN_OK" : "LAN_ATTENTION",
          enabled: lanStatus.enabled,
          passedChecks: lanDiagnosis.checks.filter(\.ok).count,
          totalChecks: lanDiagnosis.checks.count),
        backup: try supportBackups(state: state, payload: manifest),
        printing: RuntimeSupportPrinting(code: "PRINTING_NOT_ASSESSED", queueCount: 0))
      let data = try RuntimeLanStorage.encode(payload)
      guard data.count <= 262_144 else { try runtimeFail("RUNTIME_SUPPORT_BUNDLE_TOO_LARGE") }
      try RuntimeStorage.ensureDirectory(paths.supportRoot)
      try RuntimeStorage.atomicWrite(data, to: paths.supportBundle)
      let digest = try RuntimeStorage.privateFileDigest(
        paths.supportBundle, maximum: 262_144)
      guard digest.size == Int64(data.count) else {
        try runtimeFail("RUNTIME_SUPPORT_BUNDLE_INVALID")
      }
      return RuntimeSupportCreateResult(
        status: "created", path: paths.supportBundle.path, bytes: digest.size)
    }
  }
}
