import Foundation

enum RuntimeBackupKind: String, Codable {
  case manual
  case preRestore = "pre_restore"
  case preUpgrade = "pre_upgrade"
  case preRollback = "pre_rollback"
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

  var id: String { backupID }

  enum CodingKeys: String, CodingKey {
    case kind, release, bytes, confirmation, verified
    case backupID = "backup_id"
    case createdAt = "created_at"
    case manifestSHA256 = "manifest_sha256"
    case faultCode = "fault_code"
  }
}

struct RuntimeRestoreResult: Codable {
  let status: String
  let release: String
  let backupID: String
  let safetyBackupID: String

  enum CodingKeys: String, CodingKey {
    case status, release
    case backupID = "backup_id"
    case safetyBackupID = "safety_backup_id"
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
