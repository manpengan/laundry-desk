#if RUNTIME_TESTING
  import CryptoKit
  import Foundation

  struct RuntimePortableArchiveTestSummary: Codable, Equatable {
    let status: String
    let knownAnswer: Bool
    let roundTrip: Bool
    let chunkCount: Int
    let negativeCases: Int
    let calibrationInRange: Bool

    enum CodingKeys: String, CodingKey {
      case status
      case knownAnswer = "known_answer"
      case roundTrip = "round_trip"
      case chunkCount = "chunk_count"
      case negativeCases = "negative_cases"
      case calibrationInRange = "calibration_in_range"
    }
  }

  enum RuntimePortableArchiveTesting {
    private static let password = "correct horse battery staple"
    private static let knownAnswer =
      "6c4a646aad10d067add5fb79d9078a16da83d50f81670a8e7593b249e6d94936"
    private static let headerBytes = 56
    private static let tagBytes = 16
    private static let frameLengthBytes = 4

    static func run() throws -> RuntimePortableArchiveTestSummary {
      let manager = FileManager.default
      let root = manager.temporaryDirectory.appendingPathComponent(
        "laundry-transfer-self-test-\(UUID().uuidString)", isDirectory: true)
      try manager.createDirectory(
        at: root, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
      defer { try? manager.removeItem(at: root) }

      let answer = try RuntimePasswordKDF.deriveKeyBytes(
        password: password, salt: Data("0123456789abcdef".utf8), iterations: 600_000)
      guard answer.hexString == knownAnswer else {
        try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
      }
      guard RuntimeTransferController.validExportTimestamp("2026-08-08T10:10:07.804Z"),
        !RuntimeTransferController.validExportTimestamp("2026-08-08T10:10:07Z")
      else { try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED") }

      let plaintextBytes = RuntimePortableArchive.chunkBytes * 2 + 17
      let plaintext = Data((0..<plaintextBytes).map { UInt8($0 % 251) })
      let archiveURL = root.appendingPathComponent("roundtrip.laundry-transfer")
      guard
        manager.createFile(
          atPath: archiveURL.path, contents: nil,
          attributes: [.posixPermissions: 0o600])
      else { try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED") }
      let output = try FileHandle(forWritingTo: archiveURL)
      var offset = 0
      let encrypted = try RuntimePortableArchive.encrypt(
        source: { maximum in
          guard offset < plaintext.count else { return Data() }
          let count = min(maximum, 65_537, plaintext.count - offset)
          defer { offset += count }
          return plaintext.subdata(in: offset..<(offset + count))
        }, totalBytes: Int64(plaintext.count), password: password,
        output: output, iterations: 600_000)
      try output.close()
      guard encrypted.chunkCount == 3,
        try RuntimePortableArchive.archiveBytes(forPlaintext: Int64(plaintext.count))
          == encrypted.archiveBytes
      else {
        try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
      }

      let input = try FileHandle(forReadingFrom: archiveURL)
      var recovered = Data()
      let decrypted = try RuntimePortableArchive.decrypt(
        input: input, password: password, sink: { recovered.append($0) })
      try input.close()
      guard decrypted == encrypted, recovered == plaintext else {
        try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
      }

      let capacityInput = try FileHandle(forReadingFrom: archiveURL)
      var capacitySinkCalled = false
      do {
        _ = try RuntimePortableArchive.decrypt(
          input: capacityInput, password: password,
          preflight: { _ in try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW") },
          sink: { _ in capacitySinkCalled = true })
        try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
      } catch let error as RuntimeKitError {
        guard error.description == "RUNTIME_TRANSFER_CAPACITY_LOW", !capacitySinkCalled else {
          try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
        }
      }
      try capacityInput.close()

      let archive = try Data(contentsOf: archiveURL)
      let archiveSHA256 = SHA256.hash(data: archive).hexString
      guard archive.prefix(8) == Data("LDRXFER1".utf8),
        encrypted.archiveSHA256 == archiveSHA256,
        decrypted.archiveSHA256 == archiveSHA256
      else {
        try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
      }
      var invalidArchives: [(Data, String)] = []
      var tagTampered = archive
      tagTampered[tagTampered.count - 1] ^= 1
      invalidArchives.append((tagTampered, password))
      invalidArchives.append((archive, "different valid password"))
      invalidArchives.append((Data(archive.dropLast()), password))
      invalidArchives.append((archive + Data([0]), password))
      var headerTampered = archive
      headerTampered[0] ^= 1
      invalidArchives.append((headerTampered, password))
      var roundsTampered = archive
      roundsTampered.replaceSubrange(12..<16, with: [0, 0, 0, 1])
      invalidArchives.append((roundsTampered, password))

      let fullFrameBytes = frameLengthBytes + RuntimePortableArchive.chunkBytes + tagBytes
      let firstEnd = headerBytes + fullFrameBytes
      let secondEnd = firstEnd + fullFrameBytes
      let header = archive.prefix(headerBytes)
      let first = archive.subdata(in: headerBytes..<firstEnd)
      let second = archive.subdata(in: firstEnd..<secondEnd)
      let tail = archive.suffix(from: secondEnd)
      invalidArchives.append((header + second + first + tail, password))
      invalidArchives.append((header + first + first + tail, password))

      for (index, value) in invalidArchives.enumerated() {
        try expectInvalid(value.0, password: value.1, index: index, root: root)
      }
      let rounds = RuntimePasswordKDF.calibratedIterations()
      let calibrationInRange =
        (RuntimePasswordKDF.minimumIterations...RuntimePasswordKDF.maximumIterations)
        .contains(rounds)
      guard calibrationInRange else { try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED") }
      return RuntimePortableArchiveTestSummary(
        status: "passed", knownAnswer: true, roundTrip: true,
        chunkCount: encrypted.chunkCount, negativeCases: invalidArchives.count,
        calibrationInRange: true)
    }

    private static func expectInvalid(
      _ data: Data, password: String, index: Int, root: URL
    ) throws {
      let url = root.appendingPathComponent("invalid-\(index).laundry-transfer")
      try data.write(to: url, options: .withoutOverwriting)
      let input = try FileHandle(forReadingFrom: url)
      defer { try? input.close() }
      do {
        _ = try RuntimePortableArchive.decrypt(
          input: input, password: password, sink: { _ in })
      } catch let error as RuntimeKitError where error.description == "RUNTIME_TRANSFER_INVALID" {
        return
      }
      try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
    }
  }

  extension Data {
    fileprivate var hexString: String {
      map { String(format: "%02x", $0) }.joined()
    }
  }

  extension SHA256.Digest {
    fileprivate var hexString: String {
      map { String(format: "%02x", $0) }.joined()
    }
  }
#endif
