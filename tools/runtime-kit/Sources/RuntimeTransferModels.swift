import Foundation

struct RuntimeTransferExportRequest: Decodable {
  let backupID: String
  let path: String
  let password: String

  enum CodingKeys: String, CodingKey {
    case path, password
    case backupID = "backup_id"
  }
}

struct RuntimeTransferInspectRequest: Decodable {
  let path: String
  let password: String
}

struct RuntimeTransferImportRequest: Decodable {
  let path: String
  let password: String
  let confirmation: String
}

struct RuntimeTransferManifest: Codable, Equatable {
  let version: Int
  let sourceInstanceID: String
  let exportID: String
  let exportedAt: String
  let backupManifest: RuntimeBackupManifest
  let backupManifestSHA256: String
  let database: RuntimeBackupFile
  let photos: RuntimeBackupFile
  let release: String
  let migrationHead: String
  let schemaSHA256: String
  let serverImage: String
  let postgresImage: String

  enum CodingKeys: String, CodingKey {
    case version, database, photos, release
    case sourceInstanceID = "source_instance_id"
    case exportID = "export_id"
    case exportedAt = "exported_at"
    case backupManifest = "backup_manifest"
    case backupManifestSHA256 = "backup_manifest_sha256"
    case migrationHead = "migration_head"
    case schemaSHA256 = "schema_sha256"
    case serverImage = "server_image"
    case postgresImage = "postgres_image"
  }
}

struct RuntimePortableArchiveMetadata: Equatable {
  let version: Int
  let iterations: Int
  let plaintextBytes: Int64
  let chunkCount: Int
  let archiveBytes: Int64
  let archiveSHA256: String?
}

struct RuntimeTransferExportResult: Codable {
  let status: String
  let exportID: String
  let backupID: String
  let release: String
  let bytes: Int64
  let sha256: String
  let confirmation: String

  enum CodingKeys: String, CodingKey {
    case status, release, bytes, sha256, confirmation
    case exportID = "export_id"
    case backupID = "backup_id"
  }
}

struct RuntimeTransferInspectResult: Codable {
  let status: String
  let exportID: String
  let sourceInstanceID: String
  let backupID: String
  let release: String
  let migrationHead: String
  let bytes: Int64
  let compatible: Bool
  let confirmation: String

  enum CodingKeys: String, CodingKey {
    case status, release, bytes, compatible, confirmation
    case exportID = "export_id"
    case sourceInstanceID = "source_instance_id"
    case backupID = "backup_id"
    case migrationHead = "migration_head"
  }
}

struct RuntimeTransferImportResult: Codable {
  let status: String
  let release: String
  let exportID: String
  let sourceInstanceID: String
  let safetyBackupID: String
  let lanStatus: String
  let lanFaultCode: String?

  enum CodingKeys: String, CodingKey {
    case status, release
    case exportID = "export_id"
    case sourceInstanceID = "source_instance_id"
    case safetyBackupID = "safety_backup_id"
    case lanStatus = "lan_status"
    case lanFaultCode = "lan_fault_code"
  }
}

struct RuntimeTransferRecoveryState: Codable, Equatable {
  let version: Int
  let phase: String
  let startedAt: String
  let exportID: String
  let sourceInstanceID: String
  let backupID: String
  let safetyBackupID: String?
  let faultCode: String?

  enum CodingKeys: String, CodingKey {
    case version, phase
    case startedAt = "started_at"
    case exportID = "export_id"
    case sourceInstanceID = "source_instance_id"
    case backupID = "backup_id"
    case safetyBackupID = "safety_backup_id"
    case faultCode = "fault_code"
  }

  func withPhase(
    _ next: String, safetyBackupID nextSafetyBackupID: String? = nil,
    faultCode nextFaultCode: String? = nil
  ) -> RuntimeTransferRecoveryState {
    RuntimeTransferRecoveryState(
      version: version, phase: next, startedAt: startedAt, exportID: exportID,
      sourceInstanceID: sourceInstanceID, backupID: backupID,
      safetyBackupID: nextSafetyBackupID ?? safetyBackupID,
      faultCode: nextFaultCode)
  }
}
