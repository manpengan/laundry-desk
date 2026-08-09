import Foundation

enum RuntimeBackupCodec {
  static let databaseName = "database.dump"
  static let photosName = "photos.tar"
  static let manifestName = "manifest.json"
  static let maximumArtifactBytes: Int64 = 137_438_953_472
  static let maximumBackups = 1_000
  private static let backupPattern =
    "^(?:manual|scheduled|safety)-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9_-]{22}$"
  private static let digestPattern = "^[0-9a-f]{64}$"
  private static let timestampPattern =
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"

  static func validBackupID(_ value: String) -> Bool {
    value.range(of: backupPattern, options: .regularExpression) != nil
  }

  static func encode(_ value: RuntimeBackupManifest) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }

  static func decode(_ data: Data, expectedBackupID: String) throws -> RuntimeBackupManifest {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == [
        "version", "backup_id", "kind", "created_at", "instance_id", "release",
        "server_version", "server_image", "postgres_image", "migration_head",
        "schema_sha256", "database", "photos",
      ],
      let database = object["database"] as? [String: Any],
      let photos = object["photos"] as? [String: Any],
      Set(database.keys) == ["name", "size", "sha256"],
      Set(photos.keys) == ["name", "size", "sha256"],
      let value = try? JSONDecoder().decode(RuntimeBackupManifest.self, from: data),
      value.version == 1, value.backupID == expectedBackupID,
      validBackupID(value.backupID),
      [
        RuntimeBackupKind.manual, .scheduled, .preRestore, .preUpgrade, .preRollback,
        .preTransfer,
      ].contains(value.kind),
      value.createdAt.range(of: timestampPattern, options: .regularExpression) != nil,
      ISO8601DateFormatter().date(from: value.createdAt) != nil,
      value.instanceID.range(
        of: "^[A-Za-z0-9_-]{22,128}$", options: .regularExpression) != nil,
      value.database.name == databaseName, value.photos.name == photosName,
      validFile(value.database), validFile(value.photos),
      !value.release.isEmpty, value.release.count <= 64,
      !value.serverVersion.isEmpty, value.serverVersion.count <= 64,
      value.serverImage.contains("@sha256:"), value.serverImage.count <= 512,
      value.postgresImage.contains("@sha256:"), value.postgresImage.count <= 512,
      !value.migrationHead.isEmpty, value.migrationHead.count <= 256,
      value.schemaSHA256.range(of: digestPattern, options: .regularExpression) != nil
    else { try runtimeFail("RUNTIME_BACKUP_INVALID") }
    return value
  }

  static func confirmation(_ manifestSHA256: String) throws -> String {
    guard manifestSHA256.range(of: digestPattern, options: .regularExpression) != nil else {
      try runtimeFail("RUNTIME_BACKUP_INVALID")
    }
    return "RESTORE-\(manifestSHA256.prefix(12).uppercased())"
  }

  static func summary(
    manifest: RuntimeBackupManifest, manifestSHA256: String
  ) throws -> RuntimeBackupSummary {
    RuntimeBackupSummary(
      backupID: manifest.backupID, kind: manifest.kind, createdAt: manifest.createdAt,
      release: manifest.release, bytes: manifest.database.size + manifest.photos.size,
      manifestSHA256: manifestSHA256,
      confirmation: try confirmation(manifestSHA256), verified: true, faultCode: nil,
      lanStatus: nil, lanFaultCode: nil)
  }

  static func invalidSummary(backupID: String, error: Error) -> RuntimeBackupSummary {
    RuntimeBackupSummary(
      backupID: backupID, kind: nil, createdAt: nil, release: nil, bytes: nil,
      manifestSHA256: nil, confirmation: nil, verified: false,
      faultCode: (error as? RuntimeKitError)?.description ?? "RUNTIME_BACKUP_INVALID",
      lanStatus: nil, lanFaultCode: nil)
  }

  private static func validFile(_ value: RuntimeBackupFile) -> Bool {
    value.size > 0 && value.size <= maximumArtifactBytes
      && value.sha256.range(of: digestPattern, options: .regularExpression) != nil
  }
}
