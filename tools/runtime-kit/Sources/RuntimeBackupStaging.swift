import Foundation

extension NativeRuntimeController {
  func ensureBackupCapacity() throws {
    let values = try backupsRoot.resourceValues(forKeys: [
      .volumeAvailableCapacityForImportantUsageKey
    ])
    guard let available = values.volumeAvailableCapacityForImportantUsage,
      available >= 536_870_912
    else { try runtimeFail("RUNTIME_BACKUP_CAPACITY_LOW") }
  }

  private func backupTimestamp(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    return formatter.string(from: date)
  }

  func manifestTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  func makeBackupID(kind: RuntimeBackupKind, now: Date) throws -> String {
    let prefix = kind == .manual ? "manual" : (kind == .scheduled ? "scheduled" : "safety")
    return "\(prefix)-\(backupTimestamp(now))-\(try RuntimeStorage.randomToken(bytes: 16))"
  }

  func assertBackupSlotAvailable(
    kind: RuntimeBackupKind, state: RuntimeState, payload: RuntimeManifestPayload
  ) throws {
    let entries = try FileManager.default.contentsOfDirectory(atPath: backupsRoot.path)
    guard entries.count <= RuntimeBackupCodec.maximumBackups else {
      try runtimeFail("RUNTIME_BACKUP_LIMIT_REACHED")
    }
    guard entries.count == RuntimeBackupCodec.maximumBackups else { return }
    guard kind == .scheduled else { try runtimeFail("RUNTIME_BACKUP_LIMIT_REACHED") }
    let summaries = try listBackupsUnlocked(state: state, payload: payload)
    guard RuntimeMaintenanceRetention.canRecoverOverflow(summaries) else {
      try runtimeFail("RUNTIME_BACKUP_LIMIT_REACHED")
    }
  }
}
