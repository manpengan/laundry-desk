import Foundation

struct RuntimeMaintenanceState: Codable, Equatable {
  let version: Int
  let phase: String
  let lastAttemptAt: String
  let lastSuccessAt: String?
  let lastFailureAt: String?
  let lastFailureCode: String?
  let lastBackupID: String?
  let corruptBackups: Int
  let deletedBackups: Int

  enum CodingKeys: String, CodingKey {
    case version, phase
    case lastAttemptAt = "last_attempt_at"
    case lastSuccessAt = "last_success_at"
    case lastFailureAt = "last_failure_at"
    case lastFailureCode = "last_failure_code"
    case lastBackupID = "last_backup_id"
    case corruptBackups = "corrupt_backups"
    case deletedBackups = "deleted_backups"
  }
}

struct RuntimeMaintenanceResult: Codable {
  let status: String
  let backupID: String
  let corruptBackups: Int
  let deletedBackups: Int
  let lanStatus: String
  let lanFaultCode: String?

  enum CodingKeys: String, CodingKey {
    case status
    case backupID = "backup_id"
    case corruptBackups = "corrupt_backups"
    case deletedBackups = "deleted_backups"
    case lanStatus = "lan_status"
    case lanFaultCode = "lan_fault_code"
  }
}

struct RuntimeMaintenanceDiagnosis: Codable {
  let ok: Bool
  let stale: Bool
  let lastAttemptAt: String?
  let lastSuccessAt: String?
  let lastFailureCode: String?
  let lastBackupID: String?
  let corruptBackups: Int
  let deletedBackups: Int

  enum CodingKeys: String, CodingKey {
    case ok, stale
    case lastAttemptAt = "last_attempt_at"
    case lastSuccessAt = "last_success_at"
    case lastFailureCode = "last_failure_code"
    case lastBackupID = "last_backup_id"
    case corruptBackups = "corrupt_backups"
    case deletedBackups = "deleted_backups"
  }
}
