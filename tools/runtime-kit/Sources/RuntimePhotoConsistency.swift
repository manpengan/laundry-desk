import CryptoKit
import Darwin
import Foundation

private struct RuntimePhotoInventoryRow: Codable, Equatable {
  let byteSize: Int64
  let contentSHA256: String
  let storageKey: String

  enum CodingKeys: String, CodingKey {
    case byteSize = "byte_size"
    case contentSHA256 = "content_sha256"
    case storageKey = "storage_key"
  }
}

enum RuntimePhotoConsistency {
  static let maximumInventoryBytes: Int64 = 33_554_432
  private static let maximumPhotos = 100_000
  private static let storageKeyPattern =
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(?:jpg|png|webp)$"

  static func validate(database: Data, photos: Data) throws {
    let left = try decode(database)
    let right = try decode(photos)
    guard left == right else { try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED") }
  }

  private static func decode(_ data: Data) throws -> [RuntimePhotoInventoryRow] {
    guard !data.isEmpty, Int64(data.count) <= maximumInventoryBytes,
      let objects = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
      objects.count <= maximumPhotos,
      objects.allSatisfy({
        Set($0.keys) == ["byte_size", "content_sha256", "storage_key"]
      }),
      let rows = try? JSONDecoder().decode([RuntimePhotoInventoryRow].self, from: data)
    else { try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED") }
    var previous: String?
    for row in rows {
      guard (1...20_971_520).contains(row.byteSize),
        row.contentSHA256.range(
          of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
        row.storageKey.range(of: storageKeyPattern, options: .regularExpression) != nil,
        previous.map({ $0 < row.storageKey }) ?? true
      else { try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED") }
      previous = row.storageKey
    }
    return rows
  }
}

private enum RuntimePhotoConsistencyStaging {
  static let databaseName = "database-inventory.json"
  static let photosName = "photo-inventory.json"

  static func create(_ paths: RuntimePaths) throws -> URL {
    let root = paths.root.appendingPathComponent("photo-consistency-staging", isDirectory: true)
    if RuntimeStorage.pathExists(root) { try remove(root) }
    try RuntimeStorage.createExclusiveDirectory(root)
    return root
  }

  static func remove(_ root: URL) throws {
    try RuntimeStorage.validateDirectory(root)
    let allowed = Set([databaseName, photosName])
    let entries = try FileManager.default.contentsOfDirectory(atPath: root.path)
    guard entries.count <= allowed.count, entries.allSatisfy(allowed.contains) else {
      try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED")
    }
    for name in entries {
      let path = root.appendingPathComponent(name)
      var metadata = stat()
      guard Darwin.lstat(path.path, &metadata) == 0,
        (metadata.st_mode & S_IFMT) == S_IFREG,
        (metadata.st_mode & 0o777) == 0o600, metadata.st_nlink == 1,
        metadata.st_size >= 0,
        metadata.st_size <= RuntimePhotoConsistency.maximumInventoryBytes
      else { try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED") }
      try RuntimeStorage.removePrivateFile(path)
    }
    guard Darwin.rmdir(root.path) == 0 else {
      try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED")
    }
    try RuntimeStorage.syncParent(of: root)
  }

  static func readVerified(_ path: URL) throws -> Data {
    let digest = try RuntimeStorage.privateFileDigest(
      path, maximum: RuntimePhotoConsistency.maximumInventoryBytes)
    let handle = try RuntimeStorage.openVerifiedPrivateFile(
      path, expectedSize: digest.size, expectedSHA256: digest.sha256)
    defer { try? handle.close() }
    let version = try RuntimeTransferFileVersion(handle: handle, url: path)
    guard let data = try handle.readToEnd(), Int64(data.count) == digest.size,
      SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == digest.sha256
    else { try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED") }
    try version.verify(handle: handle, url: path)
    return data
  }
}

extension NativeRuntimeController {
  func validatePhotoConsistency(state: RuntimeState, payload: RuntimeManifestPayload) throws {
    let staging: URL
    do { staging = try RuntimePhotoConsistencyStaging.create(paths) } catch {
      try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED")
    }
    do {
      let database = staging.appendingPathComponent(RuntimePhotoConsistencyStaging.databaseName)
      let photos = staging.appendingPathComponent(RuntimePhotoConsistencyStaging.photosName)
      try stream(
        RuntimeBackupCommands.databasePhotoInventory(
          controller: self, environment: environment(state, payload)),
        output: RuntimeStreamOutput(
          url: database, maximumBytes: RuntimePhotoConsistency.maximumInventoryBytes))
      try stream(
        RuntimeBackupCommands.photoInventory(
          controller: self, image: payload.serverImage.index),
        output: RuntimeStreamOutput(
          url: photos, maximumBytes: RuntimePhotoConsistency.maximumInventoryBytes))
      try RuntimePhotoConsistency.validate(
        database: RuntimePhotoConsistencyStaging.readVerified(database),
        photos: RuntimePhotoConsistencyStaging.readVerified(photos))
      try RuntimePhotoConsistencyStaging.remove(staging)
    } catch {
      try? RuntimePhotoConsistencyStaging.remove(staging)
      try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_FAILED")
    }
  }
}
