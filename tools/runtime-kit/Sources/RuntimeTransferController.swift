import CryptoKit
import Darwin
import Foundation

struct RuntimeVerifiedBackup {
  let directory: URL
  let manifestData: Data
  let manifest: RuntimeBackupManifest
  let summary: RuntimeBackupSummary
}

private enum RuntimeTransferPayloadCodec {
  static let prefixBytes = 36
  static let magic = Data("LAUNDRY-PAYLOAD1".utf8)

  static func prefix(manifest: Int, database: Int64, photos: Int64) throws -> Data {
    guard (1...65_536).contains(manifest), database > 0, photos > 0 else {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
    var data = magic
    append(UInt32(manifest), to: &data)
    append(UInt64(database), to: &data)
    append(UInt64(photos), to: &data)
    return data
  }

  static func lengths(_ data: Data) throws -> (Int, Int64, Int64) {
    guard data.count == prefixBytes, data.prefix(magic.count) == magic else {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
    let manifest = Int(integer(data, at: 16, as: UInt32.self))
    let databaseRaw = integer(data, at: 20, as: UInt64.self)
    let photosRaw = integer(data, at: 28, as: UInt64.self)
    guard (1...65_536).contains(manifest), databaseRaw <= UInt64(Int64.max),
      photosRaw <= UInt64(Int64.max)
    else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    return (manifest, Int64(databaseRaw), Int64(photosRaw))
  }

  static func total(manifest: Int, database: Int64, photos: Int64) throws -> Int64 {
    guard database > 0, photos > 0,
      database <= RuntimeBackupCodec.maximumArtifactBytes,
      photos <= RuntimeBackupCodec.maximumArtifactBytes,
      database <= Int64.max - photos - Int64(prefixBytes + manifest)
    else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    let value = Int64(prefixBytes + manifest) + database + photos
    guard value <= RuntimePortableArchive.maximumPlaintextBytes else {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
    return value
  }

  private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var encoded = value.bigEndian
    withUnsafeBytes(of: &encoded) { data.append(contentsOf: $0) }
  }

  private static func integer<T: FixedWidthInteger>(
    _ data: Data, at offset: Int, as type: T.Type
  ) -> T {
    data[offset..<(offset + MemoryLayout<T>.size)].reduce(T.zero) {
      ($0 << 8) | T($1)
    }
  }
}

private final class RuntimeTransferPlaintextSource {
  let totalBytes: Int64
  private var leading: Data
  private var leadingOffset = 0
  private let database: FileHandle
  private let photos: FileHandle
  private let databaseURL: URL
  private let photosURL: URL
  private let databaseVersion: RuntimeTransferFileVersion
  private let photosVersion: RuntimeTransferFileVersion
  private var databaseRemaining: Int64
  private var photosRemaining: Int64
  private var databaseHash = SHA256()
  private var photosHash = SHA256()

  init(backup: RuntimeVerifiedBackup, manifest: Data) throws {
    let prefix = try RuntimeTransferPayloadCodec.prefix(
      manifest: manifest.count, database: backup.manifest.database.size,
      photos: backup.manifest.photos.size)
    leading = prefix + manifest
    totalBytes = try RuntimeTransferPayloadCodec.total(
      manifest: manifest.count, database: backup.manifest.database.size,
      photos: backup.manifest.photos.size)
    databaseURL = backup.directory.appendingPathComponent(RuntimeBackupCodec.databaseName)
    photosURL = backup.directory.appendingPathComponent(RuntimeBackupCodec.photosName)
    database = try RuntimeStorage.openVerifiedPrivateFile(
      databaseURL,
      expectedSize: backup.manifest.database.size,
      expectedSHA256: backup.manifest.database.sha256)
    photos = try RuntimeStorage.openVerifiedPrivateFile(
      photosURL,
      expectedSize: backup.manifest.photos.size,
      expectedSHA256: backup.manifest.photos.sha256)
    databaseVersion = try RuntimeTransferFileVersion(handle: database, url: databaseURL)
    photosVersion = try RuntimeTransferFileVersion(handle: photos, url: photosURL)
    databaseRemaining = backup.manifest.database.size
    photosRemaining = backup.manifest.photos.size
  }

  func read(_ maximum: Int) throws -> Data {
    guard maximum > 0 else { return Data() }
    if leadingOffset < leading.count {
      let count = min(maximum, leading.count - leadingOffset)
      defer { leadingOffset += count }
      return leading.subdata(in: leadingOffset..<(leadingOffset + count))
    }
    if databaseRemaining > 0 {
      let data = try read(database, remaining: &databaseRemaining, maximum)
      databaseHash.update(data: data)
      return data
    }
    if photosRemaining > 0 {
      let data = try read(photos, remaining: &photosRemaining, maximum)
      photosHash.update(data: data)
      return data
    }
    return Data()
  }

  func finish(databaseSHA256: String, photosSHA256: String) throws {
    guard databaseRemaining == 0, photosRemaining == 0,
      databaseHash.finalize().map({ String(format: "%02x", $0) }).joined() == databaseSHA256,
      photosHash.finalize().map({ String(format: "%02x", $0) }).joined() == photosSHA256
    else { try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID") }
    try databaseVersion.verify(handle: database, url: databaseURL)
    try photosVersion.verify(handle: photos, url: photosURL)
  }

  private func read(_ handle: FileHandle, remaining: inout Int64, _ maximum: Int) throws -> Data {
    do {
      let count = min(maximum, Int(remaining))
      let data = try handle.read(upToCount: count) ?? Data()
      guard data.count == count else { try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID") }
      remaining -= Int64(count)
      return data
    } catch { try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID") }
  }

  deinit {
    try? database.close()
    try? photos.close()
  }
}

private final class RuntimeTransferPayloadSink {
  let root: URL
  private var header = Data()
  private var manifestData: Data?
  private var manifestBytes = 0
  private var databaseRemaining: Int64 = 0
  private var photosRemaining: Int64 = 0
  private var consumed: Int64 = 0
  private var databaseHash = SHA256()
  private var photosHash = SHA256()
  private var databaseHandle: FileHandle?
  private var photosHandle: FileHandle?
  private var finished = false

  init(paths: RuntimePaths) throws {
    let parent = paths.root.appendingPathComponent("transfer-staging", isDirectory: true)
    try RuntimeStorage.ensureDirectory(parent)
    root = parent.appendingPathComponent(try RuntimeStorage.randomToken(bytes: 18))
    try RuntimeStorage.createExclusiveDirectory(root)
  }

  func consume(_ chunk: Data) throws {
    consumed += Int64(chunk.count)
    var data = chunk
    if manifestData == nil {
      header.append(data)
      guard header.count >= RuntimeTransferPayloadCodec.prefixBytes else { return }
      let lengths = try RuntimeTransferPayloadCodec.lengths(
        header.prefix(RuntimeTransferPayloadCodec.prefixBytes))
      manifestBytes = lengths.0
      databaseRemaining = lengths.1
      photosRemaining = lengths.2
      _ = try RuntimeTransferPayloadCodec.total(
        manifest: manifestBytes, database: databaseRemaining, photos: photosRemaining)
      guard header.count >= RuntimeTransferPayloadCodec.prefixBytes + manifestBytes else { return }
      let end = RuntimeTransferPayloadCodec.prefixBytes + manifestBytes
      let value = header.subdata(in: RuntimeTransferPayloadCodec.prefixBytes..<end)
      try RuntimeStorage.writeExclusive(
        value, to: root.appendingPathComponent("transfer-manifest.json"))
      manifestData = value
      data = header.subdata(in: end..<header.count)
      header.removeAll(keepingCapacity: false)
      databaseHandle = try RuntimeStorage.createPrivateStreamFile(
        root.appendingPathComponent(RuntimeBackupCodec.databaseName))
      photosHandle = try RuntimeStorage.createPrivateStreamFile(
        root.appendingPathComponent(RuntimeBackupCodec.photosName))
    }
    try writePayload(data)
  }

  private func writePayload(_ data: Data) throws {
    var offset = 0
    if databaseRemaining > 0 {
      let count = min(data.count, Int(databaseRemaining))
      let part = data.subdata(in: 0..<count)
      guard let databaseHandle else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
      try databaseHandle.write(contentsOf: part)
      databaseHash.update(data: part)
      databaseRemaining -= Int64(count)
      offset += count
    }
    if offset < data.count, photosRemaining > 0 {
      let count = min(data.count - offset, Int(photosRemaining))
      let part = data.subdata(in: offset..<(offset + count))
      guard let photosHandle else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
      try photosHandle.write(contentsOf: part)
      photosHash.update(data: part)
      photosRemaining -= Int64(count)
      offset += count
    }
    guard offset == data.count else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
  }

  func finish(_ metadata: RuntimePortableArchiveMetadata) throws -> RuntimeStagedTransfer {
    guard let manifestData, let databaseOutput = databaseHandle,
      let photosOutput = photosHandle,
      databaseRemaining == 0, photosRemaining == 0,
      consumed == metadata.plaintextBytes
    else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    do {
      try databaseOutput.synchronize()
      try photosOutput.synchronize()
      try databaseOutput.close()
      try photosOutput.close()
    } catch { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    self.databaseHandle = nil
    self.photosHandle = nil
    try RuntimeStorage.syncParent(of: root.appendingPathComponent(RuntimeBackupCodec.databaseName))
    let manifest = try RuntimeTransferController.decodeTransferManifest(manifestData)
    let databaseSHA = databaseHash.finalize().map { String(format: "%02x", $0) }.joined()
    let photosSHA = photosHash.finalize().map { String(format: "%02x", $0) }.joined()
    guard
      manifest.database.size + manifest.photos.size + Int64(manifestBytes + 36)
        == metadata.plaintextBytes,
      manifest.database.sha256 == databaseSHA, manifest.photos.sha256 == photosSHA
    else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    finished = true
    return RuntimeStagedTransfer(
      root: root, manifestData: manifestData, manifest: manifest, metadata: metadata)
  }

  func discard() throws {
    try? databaseHandle?.close()
    try? photosHandle?.close()
    databaseHandle = nil
    photosHandle = nil
    for name in [
      "transfer-manifest.json", RuntimeBackupCodec.databaseName,
      RuntimeBackupCodec.photosName,
    ]
    where RuntimeStorage.pathExists(root.appendingPathComponent(name)) {
      try RuntimeStorage.removePrivateFile(root.appendingPathComponent(name))
    }
    guard Darwin.rmdir(root.path) == 0 else {
      try runtimeFail("RUNTIME_TRANSFER_STAGING_INVALID")
    }
    try RuntimeStorage.syncParent(of: root)
    finished = true
  }

  deinit {
    try? databaseHandle?.close()
    try? photosHandle?.close()
    if !finished { try? discard() }
  }
}

struct RuntimeStagedTransfer {
  let root: URL
  let manifestData: Data
  let manifest: RuntimeTransferManifest
  let metadata: RuntimePortableArchiveMetadata
}

enum RuntimeTransferController {
  static func plaintextBytes(
    backup: RuntimeVerifiedBackup, manifestData: Data
  ) throws -> Int64 {
    try RuntimeTransferPayloadCodec.total(
      manifest: manifestData.count, database: backup.manifest.database.size,
      photos: backup.manifest.photos.size)
  }

  static func encrypt(
    backup: RuntimeVerifiedBackup, manifestData: Data, password: String,
    output: FileHandle
  ) throws -> RuntimePortableArchiveMetadata {
    let source = try RuntimeTransferPlaintextSource(backup: backup, manifest: manifestData)
    let metadata = try RuntimePortableArchive.encrypt(
      source: source.read, totalBytes: source.totalBytes,
      password: password, output: output)
    try source.finish(
      databaseSHA256: backup.manifest.database.sha256,
      photosSHA256: backup.manifest.photos.sha256)
    return metadata
  }

  static func stage(
    path: String, password: String, paths: RuntimePaths, capacityReserve: Int64
  ) throws -> RuntimeStagedTransfer {
    let input = try RuntimeExternalPath.openInput(path)
    var sink: RuntimeTransferPayloadSink?
    do {
      let metadata = try RuntimePortableArchive.decrypt(
        input: input.handle, password: password,
        preflight: { metadata in
          guard metadata.archiveBytes == input.size,
            metadata.plaintextBytes <= Int64.max - capacityReserve
          else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
          try RuntimeExternalPath.assertCapacity(
            at: paths.root,
            requiredBytes: metadata.plaintextBytes + capacityReserve,
            domain: .runtime)
          sink = try RuntimeTransferPayloadSink(paths: paths)
        },
        sink: { chunk in
          guard let sink else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
          try sink.consume(chunk)
        })
      guard let sink else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
      try input.finish()
      return try sink.finish(metadata)
    } catch {
      var failure = error
      if let sink {
        do { try sink.discard() } catch { failure = error }
      }
      do { try input.finish() } catch { throw error }
      throw failure
    }
  }

  static func decodeTransferManifest(_ data: Data) throws -> RuntimeTransferManifest {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == [
        "version", "source_instance_id", "export_id", "exported_at", "backup_manifest",
        "backup_manifest_sha256", "database", "photos", "release", "migration_head",
        "schema_sha256", "server_image", "postgres_image",
      ],
      let database = object["database"] as? [String: Any],
      let photos = object["photos"] as? [String: Any],
      Set(database.keys) == ["name", "size", "sha256"],
      Set(photos.keys) == ["name", "size", "sha256"],
      let value = try? JSONDecoder().decode(RuntimeTransferManifest.self, from: data),
      (try? encodeManifest(value)) == data,
      value.version == 1,
      value.sourceInstanceID.range(
        of: "^[A-Za-z0-9_-]{22,128}$", options: .regularExpression) != nil,
      value.exportID.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil,
      validExportTimestamp(value.exportedAt),
      value.backupManifest.instanceID == value.sourceInstanceID,
      value.backupManifest.database == value.database,
      value.backupManifest.photos == value.photos,
      value.backupManifest.release == value.release,
      value.backupManifest.migrationHead == value.migrationHead,
      value.backupManifest.schemaSHA256 == value.schemaSHA256,
      value.backupManifest.serverImage == value.serverImage,
      value.backupManifest.postgresImage == value.postgresImage,
      RuntimeManifestVerifier.sha256(try RuntimeBackupCodec.encode(value.backupManifest))
        == value.backupManifestSHA256
    else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    _ = try RuntimeBackupCodec.decode(
      try RuntimeBackupCodec.encode(value.backupManifest),
      expectedBackupID: value.backupManifest.backupID)
    return value
  }

  static func encodeManifest(_ value: RuntimeTransferManifest) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }

  static func validExportTimestamp(_ value: String) -> Bool {
    guard
      value.range(
        of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
        options: .regularExpression) != nil
    else { return false }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) != nil
  }

  static func confirmation(_ manifestData: Data) -> String {
    "TRANSFER-\(RuntimeManifestVerifier.sha256(manifestData).prefix(12).uppercased())"
  }
}
