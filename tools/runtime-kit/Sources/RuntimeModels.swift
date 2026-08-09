import Foundation

enum RuntimeKitError: Error, CustomStringConvertible {
  case code(String)

  var description: String {
    switch self {
    case .code(let value): return value
    }
  }
}

@inline(__always) func runtimeFail(_ code: String) throws -> Never {
  throw RuntimeKitError.code(code)
}

struct RuntimeServerImage: Codable, Equatable {
  let index: String
  let linuxArm64: String
  let linuxAmd64: String

  enum CodingKeys: String, CodingKey {
    case index
    case linuxArm64 = "linux_arm64"
    case linuxAmd64 = "linux_amd64"
  }
}

struct RuntimeRollbackTarget: Codable, Equatable {
  let release: String
  let serverImageIndex: String
  let maximumCompatibleSchema: String

  enum CodingKeys: String, CodingKey {
    case release
    case serverImageIndex = "server_image_index"
    case maximumCompatibleSchema = "maximum_compatible_schema"
  }
}

struct RuntimeCommissionResult: Codable {
  let status: String
  let release: String
  let lanStatus: String
  let lanFaultCode: String?

  enum CodingKeys: String, CodingKey {
    case status, release
    case lanStatus = "lan_status"
    case lanFaultCode = "lan_fault_code"
  }
}

struct RuntimeManifestPayload: Codable, Equatable {
  let schemaVersion: Int
  let product: String
  let release: String
  let contractsMajor: Int
  let contractsSHA256: String
  let serverVersion: String
  let webBundleSHA256: String
  let minimumAppVersion: String
  let databaseSchemaSHA256: String
  let migrationsSHA256: String
  let migrationHead: String
  let maximumCompatibleSchema: String
  let rollbackTarget: RuntimeRollbackTarget?
  let composeSHA256: String
  let serverImage: RuntimeServerImage
  let postgresMajor: Int
  let postgresImage: String
  let lanComposeSHA256: String?
  let ownerSPASHA256: String?

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case product, release
    case contractsMajor = "contracts_major"
    case contractsSHA256 = "contracts_sha256"
    case serverVersion = "server_version"
    case webBundleSHA256 = "web_bundle_sha256"
    case minimumAppVersion = "minimum_app_version"
    case databaseSchemaSHA256 = "database_schema_sha256"
    case migrationsSHA256 = "migrations_sha256"
    case migrationHead = "migration_head"
    case maximumCompatibleSchema = "maximum_compatible_schema"
    case rollbackTarget = "rollback_target"
    case composeSHA256 = "compose_sha256"
    case serverImage = "server_image"
    case postgresMajor = "postgres_major"
    case postgresImage = "postgres_image"
    case lanComposeSHA256 = "lan_compose_sha256"
    case ownerSPASHA256 = "owner_spa_sha256"
  }
}

struct RuntimeManifestEnvelope: Codable {
  let payload: RuntimeManifestPayload
  let signature: String
}

struct RuntimeState: Codable {
  let version: Int
  let status: String
  let release: String
  let manifestSHA256: String
  let composeSHA256: String
  let instanceID: String
  let volumes: [String]

  enum CodingKeys: String, CodingKey {
    case version, status, release, volumes
    case manifestSHA256 = "manifest_sha256"
    case composeSHA256 = "compose_sha256"
    case instanceID = "instance_id"
  }

  func withStatus(_ next: String) -> RuntimeState {
    RuntimeState(
      version: version, status: next, release: release,
      manifestSHA256: manifestSHA256, composeSHA256: composeSHA256,
      instanceID: instanceID, volumes: volumes)
  }

  func withRelease(_ nextRelease: String, manifestSHA256 nextManifestSHA256: String)
    -> RuntimeState
  {
    RuntimeState(
      version: version, status: status, release: nextRelease,
      manifestSHA256: nextManifestSHA256, composeSHA256: composeSHA256,
      instanceID: instanceID, volumes: volumes)
  }
}

struct RuntimeSetup: Codable {
  let adminUsername: String
  let adminDisplayName: String
  let adminPassword: String
  let adminPin: String
  let approverUsername: String
  let approverDisplayName: String
  let approverPassword: String
  let approverPin: String
}

struct RuntimeCommissionSetup: Codable {
  let approverUsername: String
  let approverDisplayName: String
  let approverPassword: String
  let approverPin: String
}

struct RuntimeDiagnosis: Codable {
  let ok: Bool
  let project: String
  let release: String?
  let migrationHead: String?
  let faultCode: String?
  let commissionRequired: Bool?
  let databaseVolumePresent: Bool?
  let photoVolumePresent: Bool?
  let composeReachable: Bool?
  let maintenance: RuntimeMaintenanceDiagnosis?
  let transferPhase: String?
  let transferFaultCode: String?

  enum CodingKeys: String, CodingKey {
    case ok, project, release
    case migrationHead = "migration_head"
    case faultCode = "fault_code"
    case commissionRequired = "commission_required"
    case databaseVolumePresent = "database_volume_present"
    case photoVolumePresent = "photo_volume_present"
    case composeReachable = "compose_reachable"
    case maintenance
    case transferPhase = "transfer_phase"
    case transferFaultCode = "transfer_fault_code"
  }
}
