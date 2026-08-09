import Foundation

struct RuntimeReleaseHistory: Codable, Equatable {
  let version: Int
  let highestAcceptedRelease: String
  let previousRelease: String?
  let previousManifestSHA256: String?
  let preUpgradeBackupID: String?

  enum CodingKeys: String, CodingKey {
    case version
    case highestAcceptedRelease = "highest_accepted_release"
    case previousRelease = "previous_release"
    case previousManifestSHA256 = "previous_manifest_sha256"
    case preUpgradeBackupID = "pre_upgrade_backup_id"
  }
}

struct RuntimeReleaseTransition: Codable, Equatable {
  let version: Int
  let kind: String
  let phase: String
  let fromRelease: String
  let toRelease: String
  let fromManifestSHA256: String
  let toManifestSHA256: String
  let safetyBackupID: String
  let preState: Data
  let preManifest: Data
  let preHistory: Data
  let prePreviousManifest: Data
  let targetState: Data
  let targetManifest: Data
  let targetHistory: Data
  let targetPreviousManifest: Data

  enum CodingKeys: String, CodingKey {
    case version, kind, phase
    case fromRelease = "from_release"
    case toRelease = "to_release"
    case fromManifestSHA256 = "from_manifest_sha256"
    case toManifestSHA256 = "to_manifest_sha256"
    case safetyBackupID = "safety_backup_id"
    case preState = "pre_state"
    case preManifest = "pre_manifest"
    case preHistory = "pre_history"
    case prePreviousManifest = "pre_previous_manifest"
    case targetState = "target_state"
    case targetManifest = "target_manifest"
    case targetHistory = "target_history"
    case targetPreviousManifest = "target_previous_manifest"
  }

  func withPhase(_ next: String) -> RuntimeReleaseTransition {
    RuntimeReleaseTransition(
      version: version, kind: kind, phase: next,
      fromRelease: fromRelease, toRelease: toRelease,
      fromManifestSHA256: fromManifestSHA256, toManifestSHA256: toManifestSHA256,
      safetyBackupID: safetyBackupID, preState: preState, preManifest: preManifest,
      preHistory: preHistory, prePreviousManifest: prePreviousManifest,
      targetState: targetState, targetManifest: targetManifest,
      targetHistory: targetHistory, targetPreviousManifest: targetPreviousManifest)
  }
}

struct RuntimeRollbackRequest: Codable {
  let confirmation: String
}

struct RuntimeUpgradeResult: Codable {
  let status: String
  let release: String
  let previousRelease: String
  let safetyBackupID: String
  let lanStatus: String
  let lanFaultCode: String?

  enum CodingKeys: String, CodingKey {
    case status, release
    case previousRelease = "previous_release"
    case safetyBackupID = "safety_backup_id"
    case lanStatus = "lan_status"
    case lanFaultCode = "lan_fault_code"
  }
}

struct RuntimeRollbackResult: Codable {
  let status: String
  let release: String
  let rolledBackFrom: String
  let recoveryBackupID: String
  let lanStatus: String
  let lanFaultCode: String?

  enum CodingKeys: String, CodingKey {
    case status, release
    case rolledBackFrom = "rolled_back_from"
    case recoveryBackupID = "recovery_backup_id"
    case lanStatus = "lan_status"
    case lanFaultCode = "lan_fault_code"
  }
}

enum RuntimeReleaseCodec {
  private static let checksum = "^[0-9a-f]{64}$"

  private static func exactKeys(_ data: Data, expected: Set<String>) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return false }
    return Set(object.keys) == expected
  }

  private static func validRelease(_ value: String) -> Bool {
    (try? RuntimeManifestVerifier.compareVersions(value, value)) == 0
  }

  private static func validChecksum(_ value: String) -> Bool {
    value.range(of: checksum, options: .regularExpression) != nil
  }

  static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }

  static func decodeHistory(_ data: Data, currentRelease: String) throws -> RuntimeReleaseHistory {
    let baseKeys: Set<String> = ["version", "highest_accepted_release"]
    let previousKeys: Set<String> = [
      "previous_release", "previous_manifest_sha256", "pre_upgrade_backup_id",
    ]
    guard let value = try? JSONDecoder().decode(RuntimeReleaseHistory.self, from: data),
      exactKeys(data, expected: baseKeys)
        || exactKeys(data, expected: baseKeys.union(previousKeys)),
      value.version == 1, validRelease(value.highestAcceptedRelease),
      try RuntimeManifestVerifier.compareVersions(value.highestAcceptedRelease, currentRelease) >= 0
    else { try runtimeFail("RUNTIME_RELEASE_HISTORY_INVALID") }
    let previous = [
      value.previousRelease, value.previousManifestSHA256, value.preUpgradeBackupID,
    ]
    guard
      previous.allSatisfy({ $0 == nil })
        || (previous.allSatisfy({ $0 != nil })
          && validRelease(value.previousRelease ?? "")
          && validChecksum(value.previousManifestSHA256 ?? "")
          && RuntimeBackupCodec.validBackupID(value.preUpgradeBackupID ?? ""))
    else { try runtimeFail("RUNTIME_RELEASE_HISTORY_INVALID") }
    return value
  }

  static func decodeTransition(_ data: Data) throws -> RuntimeReleaseTransition {
    let keys: Set<String> = [
      "version", "kind", "phase", "from_release", "to_release", "from_manifest_sha256",
      "to_manifest_sha256", "safety_backup_id", "pre_state", "pre_manifest",
      "pre_history", "pre_previous_manifest", "target_state", "target_manifest",
      "target_history", "target_previous_manifest",
    ]
    guard exactKeys(data, expected: keys),
      let value = try? JSONDecoder().decode(RuntimeReleaseTransition.self, from: data),
      value.version == 2, ["upgrade", "rollback"].contains(value.kind),
      ["prepared", "applying", "committing"].contains(value.phase),
      validRelease(value.fromRelease), validRelease(value.toRelease),
      validChecksum(value.fromManifestSHA256), validChecksum(value.toManifestSHA256),
      RuntimeBackupCodec.validBackupID(value.safetyBackupID),
      !value.preState.isEmpty, value.preState.count <= 65_536,
      !value.preManifest.isEmpty, value.preManifest.count <= 65_536,
      !value.preHistory.isEmpty, value.preHistory.count <= 65_536,
      value.prePreviousManifest.count <= 65_536,
      !value.targetState.isEmpty, value.targetState.count <= 65_536,
      !value.targetManifest.isEmpty, value.targetManifest.count <= 65_536,
      !value.targetHistory.isEmpty, value.targetHistory.count <= 65_536,
      value.targetPreviousManifest.count <= 65_536
    else { try runtimeFail("RUNTIME_RELEASE_TRANSITION_INVALID") }
    return value
  }
}
