import Foundation

enum RuntimeBackupKind: String, Codable {
  case manual
  case scheduled
  case preRestore = "pre_restore"
  case preUpgrade = "pre_upgrade"
  case preRollback = "pre_rollback"
  case preTransfer = "pre_transfer"
}

struct RuntimeBackupFile: Codable, Equatable {
  let name: String
  let size: Int64
  let sha256: String
}

struct RuntimeBackupManifest: Codable, Equatable {
  let version: Int
  let backupID: String
  let kind: RuntimeBackupKind
  let createdAt: String
  let instanceID: String
  let release: String
  let serverVersion: String
  let serverImage: String
  let postgresImage: String
  let migrationHead: String
  let schemaSHA256: String
  let database: RuntimeBackupFile
  let photos: RuntimeBackupFile

  enum CodingKeys: String, CodingKey {
    case version, kind, release, database, photos
    case backupID = "backup_id"
    case createdAt = "created_at"
    case instanceID = "instance_id"
    case serverVersion = "server_version"
    case serverImage = "server_image"
    case postgresImage = "postgres_image"
    case migrationHead = "migration_head"
    case schemaSHA256 = "schema_sha256"
  }
}

struct RuntimeBackupSummary: Codable, Identifiable, Equatable {
  let backupID: String
  let kind: RuntimeBackupKind?
  let createdAt: String?
  let release: String?
  let bytes: Int64?
  let manifestSHA256: String?
  let confirmation: String?
  let verified: Bool
  let faultCode: String?
  let lanStatus: String?
  let lanFaultCode: String?

  var id: String { backupID }

  enum CodingKeys: String, CodingKey {
    case kind, release, bytes, confirmation, verified
    case backupID = "backup_id"
    case createdAt = "created_at"
    case manifestSHA256 = "manifest_sha256"
    case faultCode = "fault_code"
    case lanStatus = "lan_status"
    case lanFaultCode = "lan_fault_code"
  }

  func withLanOutcome(status: String, faultCode: String?) -> RuntimeBackupSummary {
    RuntimeBackupSummary(
      backupID: backupID, kind: kind, createdAt: createdAt, release: release,
      bytes: bytes, manifestSHA256: manifestSHA256, confirmation: confirmation,
      verified: verified, faultCode: self.faultCode, lanStatus: status,
      lanFaultCode: faultCode)
  }
}

struct RuntimeRestoreResult: Codable {
  let status: String
  let release: String
  let backupID: String
  let safetyBackupID: String
  let lanStatus: String
  let lanFaultCode: String?

  enum CodingKeys: String, CodingKey {
    case status, release
    case backupID = "backup_id"
    case safetyBackupID = "safety_backup_id"
    case lanStatus = "lan_status"
    case lanFaultCode = "lan_fault_code"
  }
}

struct RuntimeBackupList: Codable {
  let backups: [RuntimeBackupSummary]
}

struct RuntimeBackupSelection: Codable {
  let backupID: String

  enum CodingKeys: String, CodingKey { case backupID = "backup_id" }
}

struct RuntimeRestoreRequest: Codable {
  let backupID: String
  let confirmation: String

  enum CodingKeys: String, CodingKey {
    case backupID = "backup_id"
    case confirmation
  }
}
