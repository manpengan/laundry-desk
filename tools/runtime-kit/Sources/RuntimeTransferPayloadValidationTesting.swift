#if RUNTIME_TESTING
  import CryptoKit
  import Foundation

  struct RuntimeTransferPayloadValidationTestSummary: Codable, Equatable {
    let status: String
    let databaseExactSet: Bool
    let databaseSanitized: Bool
    let photoArchive: Bool
    let negativeCases: Int

    enum CodingKeys: String, CodingKey {
      case status
      case databaseExactSet = "database_exact_set"
      case databaseSanitized = "database_sanitized"
      case photoArchive = "photo_archive"
      case negativeCases = "negative_cases"
    }
  }

  enum RuntimeTransferPayloadValidationTesting {
    private static let marker = Data("laundry-desk-photo-store:v1\n".utf8)
    private static let photoName = "01234567-89ab-4def-8123-456789abcdef.jpg"

    static func run() throws -> RuntimeTransferPayloadValidationTestSummary {
      try databaseListCases()
      let manager = FileManager.default
      let root = manager.temporaryDirectory.appendingPathComponent(
        "laundry-payload-self-test-\(UUID().uuidString)", isDirectory: true)
      try manager.createDirectory(
        at: root, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
      defer { try? manager.removeItem(at: root) }

      try databaseSanitizerCases(root: root)

      let valid = archive(entries: [
        entry(name: "./", type: 53, contents: Data()),
        entry(name: "./.laundry-photo-store-v1", contents: marker),
        entry(name: "./\(photoName)", contents: Data("photo".utf8)),
      ])
      try validate(valid, at: root, name: "valid.tar")

      var badChecksum = valid
      badChecksum[0] ^= 1
      let invalid = [
        archive(entries: [
          entry(name: "./", type: 53, contents: Data()),
          entry(name: "./.laundry-photo-store-v1", contents: marker),
          entry(name: "./\(photoName)", type: 50, contents: Data()),
        ]),
        archive(entries: [
          entry(name: "./", type: 53, contents: Data()),
          entry(name: "./.laundry-photo-store-v1", contents: marker),
          entry(name: "./\(photoName)", type: 49, contents: Data()),
        ]),
        archive(entries: [
          entry(name: "./", type: 53, contents: Data()),
          entry(name: "./.laundry-photo-store-v1", contents: marker),
          entry(name: "./\(photoName)", type: 83, contents: Data()),
        ]),
        archive(entries: [
          entry(name: "./", type: 53, contents: Data()),
          entry(name: "./.laundry-photo-store-v1", contents: marker),
          entry(name: "./../\(photoName)", contents: Data("x".utf8)),
        ]),
        archive(entries: [
          entry(name: "./", type: 53, contents: Data()),
          entry(name: "./.laundry-photo-store-v1", contents: marker),
          entry(name: "./nested/\(photoName)", contents: Data("x".utf8)),
        ]),
        archive(entries: [
          entry(name: "./", type: 53, contents: Data()),
          entry(name: "./.laundry-photo-store-v1", contents: Data("wrong\n".utf8)),
        ]),
        archive(entries: [
          entry(name: "./", type: 53, contents: Data()),
          entry(name: "./.laundry-photo-store-v1", contents: marker),
          entry(name: "./\(photoName)", contents: Data("x".utf8)),
          entry(name: "./\(photoName)", contents: Data("y".utf8)),
        ]),
        archive(
          entries: [
            entry(name: "./", type: 53, contents: Data()),
            entry(name: "./.laundry-photo-store-v1", contents: marker),
            entry(name: "./\(photoName)", contents: Data("x".utf8)),
          ], sparsePAXAt: 2),
        oversizedPhotoArchive(),
        badChecksum,
      ]
      for (index, data) in invalid.enumerated() {
        try expectFailure(data, at: root, name: "invalid-\(index).tar")
      }
      return RuntimeTransferPayloadValidationTestSummary(
        status: "passed", databaseExactSet: true, databaseSanitized: true,
        photoArchive: true, negativeCases: invalid.count + 6)
    }

    private static func databaseListCases() throws {
      let descriptor = "TABLE DATA public allowed"
      let digest = SHA256.hash(data: Data("\(descriptor)\n".utf8))
        .map { String(format: "%02x", $0) }.joined()
      let header = ";     dbname: laundry_v2\n;     Format: CUSTOM\n"
      let valid = Data("\(header)1; 0 1 \(descriptor) postgres\n".utf8)
      try RuntimeTransferPayloadValidation.validateDatabaseList(
        valid, expectedEntries: 1, expectedDigest: digest)
      let extra = valid + Data("2; 0 2 FUNCTION public attacker() postgres\n".utf8)
      do {
        try RuntimeTransferPayloadValidation.validateDatabaseList(
          extra, expectedEntries: 1, expectedDigest: digest)
        try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
      } catch let error as RuntimeKitError {
        guard
          error.description == "RUNTIME_TRANSFER_PAYLOAD_INVALID"
            || error.description.hasPrefix("RUNTIME_TRANSFER_PAYLOAD_DATABASE_")
        else { throw error }
      }
    }

    private static func databaseSanitizerCases(root: URL) throws {
      let checksum = String(repeating: "a", count: 64)
      let aggregate = "0001_roles.sql\0\(checksum)\n"
      let expected = SHA256.hash(data: Data(aggregate.utf8))
        .map { String(format: "%02x", $0) }.joined()
      let valid = sanitizerFixture(checksum: checksum)
      let raw = root.appendingPathComponent("valid-database.sql")
      let output = root.appendingPathComponent("valid-import.sql")
      try RuntimeStorage.writeExclusive(Data(valid.utf8), to: raw)
      try RuntimeDatabaseSanitizer.sanitize(
        raw: raw, output: output, expectedMigrationsSHA256: expected)
      let sanitized = try RuntimeStorage.readPrivate(output, maximum: 1_048_576)
      let text = String(decoding: sanitized, as: UTF8.self)
      guard text.hasPrefix("BEGIN;\nCREATE TEMP TABLE restore_ai_pending_actions "),
        text.hasSuffix("COMMIT;\n"), !text.contains("laundry_schema_migrations")
      else { try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED") }
      let unterminatedRaw = root.appendingPathComponent("valid-database-no-final-newline.sql")
      let unterminatedOutput = root.appendingPathComponent("valid-import-no-final-newline.sql")
      try RuntimeStorage.writeExclusive(Data(valid.dropLast().utf8), to: unterminatedRaw)
      try RuntimeDatabaseSanitizer.sanitize(
        raw: unterminatedRaw, output: unterminatedOutput,
        expectedMigrationsSHA256: expected)

      let first = RuntimeDatabaseImportSchema.tables[0].header
      let hiddenCopy = valid.replacingOccurrences(
        of: first,
        with: "COPY public.pg_authid (rolname) FROM stdin;")
      let injected = valid.replacingOccurrences(
        of: "SET statement_timeout = 0;",
        with: "SET statement_timeout = 0;\nDROP TABLE public.orgs;")
      let trailer = valid.replacingOccurrences(
        of: "\\unrestrict ", with: "SELECT 1;\n\\unrestrict ")
      let badEscape = valid.replacingOccurrences(
        of: "\(first)\n", with: "\(first)\n\\q\t")
      for (index, value) in [hiddenCopy, injected, trailer, badEscape].enumerated() {
        try expectSanitizerFailure(
          value, expected: expected, root: root, name: "database-negative-\(index)")
      }
      try expectSanitizerFailure(
        valid, expected: String(repeating: "b", count: 64), root: root,
        name: "database-negative-ledger")
    }

    private static func sanitizerFixture(checksum: String) -> String {
      let token = String(repeating: "A", count: 63)
      var lines = [
        "--", "-- PostgreSQL database dump", "--", "", "\\restrict \(token)", "",
        "SET statement_timeout = 0;", "SET lock_timeout = 0;",
        "SET idle_in_transaction_session_timeout = 0;", "SET client_encoding = 'UTF8';",
        "SET standard_conforming_strings = on;",
        "SELECT pg_catalog.set_config('search_path', '', false);",
        "SET check_function_bodies = false;", "SET xmloption = content;",
        "SET client_min_messages = warning;", "SET row_security = off;", "",
      ]
      for table in RuntimeDatabaseImportSchema.tables {
        lines.append(table.header)
        if table.imported {
          let values = Array(
            repeating: "\\N", count: table.columns.split(separator: ",").count)
          lines.append(values.joined(separator: "\t"))
        } else {
          lines.append("0001_roles.sql\t\(checksum)\t2026-08-08 00:00:00+00")
        }
        lines.append("\\.")
        lines.append("")
      }
      for sequence in RuntimeDatabaseImportSchema.sequences {
        lines.append("SELECT pg_catalog.setval('public.\(sequence)', 1, false);")
      }
      lines.append("")
      lines.append("\\unrestrict \(token)")
      lines.append("")
      return lines.joined(separator: "\n")
    }

    private static func expectSanitizerFailure(
      _ value: String, expected: String, root: URL, name: String
    ) throws {
      let raw = root.appendingPathComponent("\(name).sql")
      let output = root.appendingPathComponent("\(name)-import.sql")
      try RuntimeStorage.writeExclusive(Data(value.utf8), to: raw)
      do {
        try RuntimeDatabaseSanitizer.sanitize(
          raw: raw, output: output, expectedMigrationsSHA256: expected)
        try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
      } catch let error as RuntimeKitError {
        guard
          error.description == "RUNTIME_TRANSFER_PAYLOAD_INVALID"
            || error.description.hasPrefix("RUNTIME_TRANSFER_PAYLOAD_DATABASE_")
        else { throw error }
      }
    }

    private static func validate(_ data: Data, at root: URL, name: String) throws {
      let url = root.appendingPathComponent(name)
      try RuntimeStorage.writeExclusive(data, to: url)
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      try RuntimeTransferPayloadValidation.validatePhotoArchive(
        url, file: RuntimeBackupFile(name: name, size: Int64(data.count), sha256: digest))
    }

    private static func expectFailure(_ data: Data, at root: URL, name: String) throws {
      do {
        try validate(data, at: root, name: name)
        try runtimeFail("RUNTIME_TRANSFER_SELF_TEST_FAILED")
      } catch let error as RuntimeKitError {
        guard error.description == "RUNTIME_TRANSFER_PAYLOAD_INVALID" else { throw error }
      }
    }

    private static func archive(
      entries: [(String, UInt8, Data)], sparsePAXAt: Int? = nil
    ) -> Data {
      var result = Data()
      for (index, value) in entries.enumerated() {
        let pax =
          sparsePAXAt == index
          ? paxData(["GNU.sparse.map": "0,1"])
          : paxData(["mtime": "0", "atime": "0", "ctime": "0"])
        append(header(name: "./PaxHeaders/item", type: 120, size: pax.count), to: &result)
        append(pax, to: &result)
        append(header(name: value.0, type: value.1, size: value.2.count), to: &result)
        append(value.2, to: &result)
      }
      result.append(Data(repeating: 0, count: 1_024))
      let remainder = result.count % 10_240
      if remainder != 0 { result.append(Data(repeating: 0, count: 10_240 - remainder)) }
      return result
    }

    private static func oversizedPhotoArchive() -> Data {
      var result = Data()
      for value in [
        entry(name: "./", type: 53, contents: Data()),
        entry(name: "./.laundry-photo-store-v1", contents: marker),
      ] {
        let pax = paxData(["mtime": "0"])
        append(header(name: "./PaxHeaders/item", type: 120, size: pax.count), to: &result)
        append(pax, to: &result)
        append(header(name: value.0, type: value.1, size: value.2.count), to: &result)
        append(value.2, to: &result)
      }
      let pax = paxData(["mtime": "0"])
      append(header(name: "./PaxHeaders/item", type: 120, size: pax.count), to: &result)
      append(pax, to: &result)
      append(header(name: "./\(photoName)", type: 48, size: 20_971_521), to: &result)
      result.append(Data(repeating: 0, count: 1_024))
      let remainder = result.count % 10_240
      if remainder != 0 { result.append(Data(repeating: 0, count: 10_240 - remainder)) }
      return result
    }

    private static func entry(
      name: String, type: UInt8 = 48, contents: Data
    ) -> (String, UInt8, Data) {
      (name, type, contents)
    }

    private static func paxData(_ values: [String: String]) -> Data {
      let lines = values.keys.sorted().map { key -> String in
        let body = "\(key)=\(values[key]!)\n"
        var length = body.utf8.count + 2
        while true {
          let line = "\(length) \(body)"
          if line.utf8.count == length { return line }
          length = line.utf8.count
        }
      }
      return Data(lines.joined().utf8)
    }

    private static func header(name: String, type: UInt8, size: Int) -> Data {
      var value = Data(repeating: 0, count: 512)
      write(Data(name.utf8), at: 0, to: &value)
      write(Data("0000600\0".utf8), at: 100, to: &value)
      write(Data("0000000\0".utf8), at: 108, to: &value)
      write(Data("0000000\0".utf8), at: 116, to: &value)
      write(Data("\(String(format: "%011o", size))\0".utf8), at: 124, to: &value)
      write(Data("00000000000\0".utf8), at: 136, to: &value)
      write(Data(repeating: 32, count: 8), at: 148, to: &value)
      value[156] = type
      write(Data("ustar\0".utf8), at: 257, to: &value)
      write(Data("00".utf8), at: 263, to: &value)
      let checksum = value.reduce(0) { $0 + Int($1) }
      write(Data("\(String(format: "%06o", checksum))\0 ".utf8), at: 148, to: &value)
      return value
    }

    private static func append(_ data: Data, to result: inout Data) {
      result.append(data)
      let padding = (512 - data.count % 512) % 512
      if padding > 0 { result.append(Data(repeating: 0, count: padding)) }
    }

    private static func write(_ data: Data, at offset: Int, to target: inout Data) {
      target.replaceSubrange(offset..<(offset + data.count), with: data)
    }
  }
#endif
