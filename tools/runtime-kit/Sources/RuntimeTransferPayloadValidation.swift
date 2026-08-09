import CryptoKit
import Foundation

enum RuntimeTransferPayloadValidation {
  private static let databaseListBytes: Int64 = 1_048_576
  // PostgreSQL 16 normalized pg_restore TOC for the runtime ledger plus migration head 0045.
  private static let expectedDatabaseEntries = 531
  private static let expectedDatabaseDigest =
    "2ccb4bf6a3873a813c6b5ab3673c32ce97569ea0f9178304ef915ef3dd06fffc"
  private static let blockBytes = 512
  private static let maximumPAXBytes: Int64 = 65_536
  private static let maximumPhotoBytes: Int64 = 20_971_520
  private static let maximumPhotoFiles = 100_001
  private static let maximumPhotoPayloadBytes: Int64 = 137_438_953_472
  private static let markerName = ".laundry-photo-store-v1"
  private static let marker = Data("laundry-desk-photo-store:v1\n".utf8)
  private static let photoPattern =
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(jpg|png|webp)$"

  static func validateBeforeRestore(
    controller: NativeRuntimeController, directory: URL,
    database: RuntimeBackupFile, photos: RuntimeBackupFile,
    postgresImage: String, migrationsSHA256: String,
    preservingValidationRoot preserved: URL? = nil
  ) throws -> RuntimeValidatedPayload {
    let scratch = try RuntimePayloadValidationStaging.create(
      controller.paths, preservingValidationRoot: preserved)
    let sanitized = scratch.appendingPathComponent(RuntimeDatabaseSanitizer.sanitizedName)
    #if RUNTIME_TESTING
      var testingFailureCode = "RUNTIME_TRANSFER_PAYLOAD_DATABASE_DATA_INVALID"
    #endif
    do {
      try validateDatabase(
        controller: controller, directory: directory, scratch: scratch, file: database,
        postgresImage: postgresImage, migrationsSHA256: migrationsSHA256,
        sanitized: sanitized)
      #if RUNTIME_TESTING
        testingFailureCode = "RUNTIME_TRANSFER_PAYLOAD_PHOTO_ARCHIVE_INVALID"
      #endif
      try validatePhotoArchive(
        directory.appendingPathComponent(photos.name), file: photos)
      return RuntimeValidatedPayload(root: scratch, sanitizedDatabase: sanitized)
    } catch {
      try? RuntimePayloadValidationStaging.remove(scratch)
      if let known = error as? RuntimeKitError,
        known.description == "RUNTIME_TRANSFER_CAPACITY_LOW"
      {
        throw known
      }
      #if RUNTIME_TESTING
        if let known = error as? RuntimeKitError,
          [
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_LIST_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_DATA_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_EXTRACT_FAILED",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_RAW_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_SANITIZER_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_SANITIZED_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_CONTENT_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_HEADER_CONTROL_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_LINE_READER_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_HEADER_TEXT_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_RESTRICT_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_INTERNAL_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_COPY_ORDER_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_FINAL_STATE_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_SEQUENCE_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_ROW_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_MIGRATION_DIGEST_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_SOURCE_VERSION_INVALID",
            "RUNTIME_TRANSFER_PAYLOAD_DATABASE_OUTPUT_SYNC_FAILED",
          ].contains(known.description)
        {
          throw known
        }
        try runtimeFail(testingFailureCode)
      #else
        try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID")
      #endif
    }
  }

  private static func validateDatabase(
    controller: NativeRuntimeController, directory: URL, scratch: URL,
    file: RuntimeBackupFile, postgresImage: String,
    migrationsSHA256: String, sanitized: URL
  ) throws {
    let output = scratch.appendingPathComponent(RuntimePayloadValidationStaging.listName)
    let raw = scratch.appendingPathComponent(RuntimeDatabaseSanitizer.rawName)
    var validationError: Error?
    #if RUNTIME_TESTING
      var testingFailureCode = "RUNTIME_TRANSFER_PAYLOAD_DATABASE_LIST_INVALID"
    #endif
    do {
      try controller.stream(
        RuntimeBackupCommands.listDatabaseDump(
          controller: controller, image: postgresImage),
        input: controller.streamInput(file, from: directory),
        output: RuntimeStreamOutput(url: output, maximumBytes: databaseListBytes))
      let data = try RuntimeStorage.readPrivate(output, maximum: Int(databaseListBytes))
      #if RUNTIME_TESTING
        if data != Data("RUNTIME_FAKE_DATABASE_LIST_V1\n".utf8) {
          try validateDatabaseList(
            data, expectedEntries: expectedDatabaseEntries,
            expectedDigest: expectedDatabaseDigest)
        }
      #else
        try validateDatabaseList(
          data, expectedEntries: expectedDatabaseEntries,
          expectedDigest: expectedDatabaseDigest)
      #endif
      #if RUNTIME_TESTING
        testingFailureCode = "RUNTIME_TRANSFER_PAYLOAD_DATABASE_EXTRACT_FAILED"
      #endif
      try controller.stream(
        RuntimeBackupCommands.extractDatabaseData(
          controller: controller, image: postgresImage),
        input: controller.streamInput(file, from: directory),
        output: RuntimeStreamOutput(
          url: raw,
          maximumBytes: try RuntimePayloadValidationStaging.rawOutputLimit(controller.paths)))
      #if RUNTIME_TESTING
        testingFailureCode = "RUNTIME_TRANSFER_PAYLOAD_DATABASE_RAW_INVALID"
      #endif
      let rawDigest = try RuntimeStorage.privateFileDigest(
        raw, maximum: RuntimeBackupCodec.maximumArtifactBytes)
      try RuntimePayloadValidationStaging.assertSanitizerCapacity(
        controller.paths, rawBytes: rawDigest.size)
      #if RUNTIME_TESTING
        testingFailureCode = "RUNTIME_TRANSFER_PAYLOAD_DATABASE_SANITIZER_INVALID"
      #endif
      #if RUNTIME_TESTING
        if rawDigest.size == 30,
          try RuntimeStorage.readPrivate(raw, maximum: 64)
            == Data("RUNTIME_FAKE_DATABASE_DATA_V1\n".utf8)
        {
          try RuntimeStorage.writeExclusive(Data("BEGIN;\nCOMMIT;\n".utf8), to: sanitized)
        } else {
          try RuntimeDatabaseSanitizer.sanitize(
            raw: raw, output: sanitized,
            expectedMigrationsSHA256: migrationsSHA256)
        }
      #else
        try RuntimeDatabaseSanitizer.sanitize(
          raw: raw, output: sanitized,
          expectedMigrationsSHA256: migrationsSHA256)
      #endif
      #if RUNTIME_TESTING
        testingFailureCode = "RUNTIME_TRANSFER_PAYLOAD_DATABASE_SANITIZED_INVALID"
      #endif
      try RuntimePayloadValidationStaging.assertSanitizedSize(
        sanitized, rawBytes: rawDigest.size)
    } catch {
      validationError = error
    }
    try RuntimeStorage.removePrivateFile(output)
    try RuntimeStorage.removePrivateFile(raw)
    if let validationError {
      #if RUNTIME_TESTING
        if let known = validationError as? RuntimeKitError,
          known.description == "RUNTIME_TRANSFER_CAPACITY_LOW"
            || [
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_CONTENT_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_HEADER_CONTROL_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_LINE_READER_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_HEADER_TEXT_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_RESTRICT_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_INTERNAL_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_COPY_ORDER_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_FINAL_STATE_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_SEQUENCE_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_ROW_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_MIGRATION_DIGEST_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_SOURCE_VERSION_INVALID",
              "RUNTIME_TRANSFER_PAYLOAD_DATABASE_OUTPUT_SYNC_FAILED",
            ].contains(known.description)
        {
          throw known
        }
        try runtimeFail(testingFailureCode)
      #else
        throw validationError
      #endif
    }
  }

  static func validateDatabaseList(
    _ data: Data, expectedEntries: Int, expectedDigest: String
  ) throws {
    guard let text = String(data: data, encoding: .utf8), !text.contains("\0"),
      text.contains(";     dbname: laundry_v2\n"),
      text.contains(";     Format: CUSTOM\n")
    else { try invalid() }
    var descriptors: [String] = []
    for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
      if line.isEmpty || line.first == ";" { continue }
      guard let separator = line.firstIndex(of: ";") else { try invalid() }
      let identifier = line[..<separator]
      guard asciiDigits(identifier) else { try invalid() }
      let fields = line[line.index(after: separator)...].split { $0.isWhitespace }
      guard fields.count >= 5, asciiDigits(fields[0]), asciiDigits(fields[1])
      else { try invalid() }
      let descriptor = fields.dropFirst(2).dropLast().joined(separator: " ")
      guard !descriptor.isEmpty else { try invalid() }
      descriptors.append(descriptor)
    }
    guard descriptors.count == expectedEntries else { try invalid() }
    let normalized = Data((descriptors.sorted().joined(separator: "\n") + "\n").utf8)
    let digest = SHA256.hash(data: normalized).map { String(format: "%02x", $0) }.joined()
    guard digest == expectedDigest else { try invalid() }
  }

  static func validatePhotoArchive(_ url: URL, file: RuntimeBackupFile) throws {
    #if RUNTIME_TESTING
      let fakeArchiveDigests: Set<String> = [
        "17c08af4c7e7019df750a2691127ceab53a480a78aeeb339708b9585ee58191d",
        "3286223ddcf6777bb72f1140be8b6b0b7e32bc918ce4a97fb2be94ef9eea190e",
      ]
      if file.size == 17, fakeArchiveDigests.contains(file.sha256) {
        return
      }
    #endif
    guard file.size >= 2 * Int64(blockBytes), file.size % Int64(blockBytes) == 0 else {
      try invalid()
    }
    let handle = try RuntimeStorage.openVerifiedPrivateFile(
      url, expectedSize: file.size, expectedSHA256: file.sha256)
    let version = try RuntimeTransferFileVersion(handle: handle, url: url)
    defer { try? handle.close() }
    let reader = TarReader(handle: handle, size: file.size)
    var rootSeen = false
    var markerSeen = false
    var pendingPAX = false
    var names = Set<String>()
    var lastName: String?
    var total: Int64 = 0
    while true {
      let header = try reader.read(blockBytes)
      if header.allSatisfy({ $0 == 0 }) {
        guard !pendingPAX else { try invalid() }
        let second = try reader.read(blockBytes)
        guard second.allSatisfy({ $0 == 0 }), reader.remaining <= 9_216 else { try invalid() }
        let trailing = try reader.read(Int(reader.remaining))
        guard trailing.allSatisfy({ $0 == 0 }), rootSeen, markerSeen else { try invalid() }
        try version.verify(handle: handle, url: url)
        return
      }
      try validateHeaderChecksum(header)
      guard field(header, 257, 6) == "ustar", field(header, 263, 2) == "00" else {
        try invalid()
      }
      let size = try octal(header, 124, 12)
      let type = header[156]
      let link = field(header, 157, 100)
      guard link.isEmpty else { try invalid() }
      if type == 120 {
        guard !pendingPAX, size > 0, size <= maximumPAXBytes else { try invalid() }
        try validatePAX(try reader.readPayload(size))
        pendingPAX = true
        continue
      }
      let path = fullName(header)
      if type == 53 {
        guard !rootSeen, names.isEmpty, path == "./", size == 0 else { try invalid() }
        rootSeen = true
      } else if type == 0 || type == 48 {
        guard rootSeen, path.hasPrefix("./") else { try invalid() }
        let name = String(path.dropFirst(2))
        guard !name.isEmpty, !name.contains("/"), !name.contains("\\"), name != ".",
          name != "..", names.insert(name).inserted,
          lastName.map({ $0 < name }) ?? true,
          name == markerName
            || name.range(of: photoPattern, options: .regularExpression) != nil
        else { try invalid() }
        if name == markerName {
          guard !markerSeen, size == Int64(marker.count) else { try invalid() }
        } else {
          guard markerSeen, size > 0, size <= maximumPhotoBytes else { try invalid() }
        }
        total = try adding(total, size)
        guard names.count <= maximumPhotoFiles, total <= maximumPhotoPayloadBytes else {
          try invalid()
        }
        let contents = try reader.readPayload(size)
        if name == markerName {
          guard contents == marker else { try invalid() }
          markerSeen = true
        }
        lastName = name
      } else {
        try invalid()
      }
      pendingPAX = false
    }
  }

  private static func validateHeaderChecksum(_ header: Data) throws {
    let expected = try octal(header, 148, 8)
    let actual = header.enumerated().reduce(0) { result, item in
      result + ((148..<156).contains(item.offset) ? 32 : Int(item.element))
    }
    guard expected == Int64(actual) else { try invalid() }
  }

  private static func field(_ data: Data, _ offset: Int, _ count: Int) -> String {
    let bytes = data[offset..<(offset + count)].prefix { $0 != 0 }
    return String(bytes: bytes, encoding: .utf8) ?? "\0"
  }

  private static func fullName(_ header: Data) -> String {
    let name = field(header, 0, 100)
    let prefix = field(header, 345, 155)
    return prefix.isEmpty ? name : "\(prefix)/\(name)"
  }

  private static func octal(_ data: Data, _ offset: Int, _ count: Int) throws -> Int64 {
    let bytes = data[offset..<(offset + count)]
    guard bytes.first.map({ $0 & 0x80 == 0 }) ?? false else { try invalid() }
    let value =
      String(bytes: bytes.prefix { $0 != 0 }, encoding: .ascii)?
      .trimmingCharacters(in: .whitespaces) ?? ""
    guard !value.isEmpty, value.allSatisfy({ ("0"..."7").contains($0) }),
      let result = Int64(value, radix: 8)
    else { try invalid() }
    return result
  }

  private static func validatePAX(_ data: Data) throws {
    var offset = 0
    var keys = Set<String>()
    while offset < data.count {
      guard let space = data[offset...].firstIndex(of: 32), space > offset,
        let length = Int(String(decoding: data[offset..<space], as: UTF8.self)), length > 0,
        offset <= data.count - length
      else { try invalid() }
      let end = offset + length
      guard data[end - 1] == 10,
        let record = String(data: data[(space + 1)..<(end - 1)], encoding: .utf8),
        let equal = record.firstIndex(of: "=")
      else { try invalid() }
      let key = String(record[..<equal])
      let value = String(record[record.index(after: equal)...])
      guard ["atime", "ctime", "mtime"].contains(key), keys.insert(key).inserted,
        value.range(
          of: "^-?[0-9]+(?:\\.[0-9]{1,9})?$", options: .regularExpression) != nil
      else { try invalid() }
      offset = end
    }
    guard !keys.isEmpty else { try invalid() }
  }

  private static func adding(_ left: Int64, _ right: Int64) throws -> Int64 {
    guard right >= 0, left <= Int64.max - right else { try invalid() }
    return left + right
  }

  private static func asciiDigits<S: StringProtocol>(_ value: S) -> Bool {
    !value.isEmpty && value.allSatisfy { ("0"..."9").contains($0) }
  }

  private static func invalid() throws -> Never {
    try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID")
  }
}

private final class TarReader {
  private let handle: FileHandle
  private(set) var remaining: Int64

  init(handle: FileHandle, size: Int64) {
    self.handle = handle
    remaining = size
  }

  func read(_ count: Int) throws -> Data {
    guard count >= 0, Int64(count) <= remaining,
      let data = try? handle.read(upToCount: count), data.count == count
    else { try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID") }
    remaining -= Int64(count)
    return data
  }

  func readPayload(_ size: Int64) throws -> Data {
    guard size >= 0, size <= Int64(Int.max) else {
      try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID")
    }
    let data = try read(Int(size))
    let padding = (512 - Int(size % 512)) % 512
    guard try read(padding).allSatisfy({ $0 == 0 }) else {
      try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID")
    }
    return data
  }
}
