import CryptoKit
import Foundation

enum RuntimeDatabaseSanitizer {
  static let rawName = ".database-raw.sql"
  static let sanitizedName = ".database-import.sql"
  static let maximumLineBytes = 67_108_864
  private static let ignoredStatements: Set<String> = [
    "SET statement_timeout = 0;", "SET lock_timeout = 0;",
    "SET idle_in_transaction_session_timeout = 0;", "SET client_encoding = 'UTF8';",
    "SET standard_conforming_strings = on;",
    "SELECT pg_catalog.set_config('search_path', '', false);",
    "SET check_function_bodies = false;", "SET xmloption = content;",
    "SET client_min_messages = warning;", "SET row_security = off;",
  ]

  static func sanitize(
    raw: URL, output: URL, expectedMigrationsSHA256: String
  ) throws {
    let source: (FileHandle, RuntimeTransferFileVersion)
    do {
      let digest = try RuntimeStorage.privateFileDigest(
        raw, maximum: RuntimeBackupCodec.maximumArtifactBytes)
      let input = try RuntimeStorage.openVerifiedPrivateFile(
        raw, expectedSize: digest.size, expectedSHA256: digest.sha256)
      source = (input, try RuntimeTransferFileVersion(handle: input, url: raw))
    } catch {
      try diagnostic("RUNTIME_TRANSFER_PAYLOAD_DATABASE_SOURCE_VERSION_INVALID", error)
    }
    let (input, inputVersion) = source
    let sink: FileHandle
    do {
      sink = try RuntimeStorage.createPrivateStreamFile(output)
    } catch {
      try? input.close()
      try diagnostic("RUNTIME_TRANSFER_PAYLOAD_DATABASE_OUTPUT_SYNC_FAILED", error)
    }
    var succeeded = false
    defer {
      try? input.close()
      if !succeeded {
        try? sink.close()
        try? RuntimeStorage.removePrivateFile(output)
      }
    }
    let reader = RuntimeDatabaseLineReader(handle: input, maximumLineBytes: maximumLineBytes)
    do {
      try write("BEGIN;\n", to: sink)
      for table in RuntimeDatabaseImportSchema.tables where table.imported {
        try write(
          "CREATE TEMP TABLE \(table.stagingName) (LIKE public.\(table.name) INCLUDING DEFAULTS) ON COMMIT DROP;\n",
          to: sink)
      }
      try consume(
        reader: reader, sink: sink,
        expectedMigrationsSHA256: expectedMigrationsSHA256)
    } catch {
      if let known = error as? RuntimeKitError,
        [
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
        ].contains(known.description)
      {
        throw known
      }
      if let known = error as? RuntimeKitError,
        known.description == "RUNTIME_TRANSFER_PAYLOAD_INVALID"
      {
        try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_LINE_READER_INVALID")
      }
      try diagnostic("RUNTIME_TRANSFER_PAYLOAD_DATABASE_OUTPUT_SYNC_FAILED", error)
    }
    do {
      try inputVersion.verify(handle: input, url: raw)
    } catch {
      try diagnostic("RUNTIME_TRANSFER_PAYLOAD_DATABASE_SOURCE_VERSION_INVALID", error)
    }
    do {
      try sink.synchronize()
      try sink.close()
      try RuntimeStorage.syncParent(of: output)
      succeeded = true
    } catch {
      try diagnostic("RUNTIME_TRANSFER_PAYLOAD_DATABASE_OUTPUT_SYNC_FAILED", error)
    }
  }

  private static func consume(
    reader: RuntimeDatabaseLineReader, sink: FileHandle,
    expectedMigrationsSHA256: String
  ) throws {
    var expectedIndex = 0
    var current: RuntimeDatabaseCopyTable?
    var restrictToken: String?
    var sequenceValues: [String: (String, String)] = [:]
    var migrationEntries: [(String, String)] = []
    while let data = try reader.next() {
      if let table = current {
        if data == Data("\\.".utf8) {
          if table.imported { try write("\\.\n", to: sink) }
          current = nil
        } else {
          try validateRow(data, columns: columnCount(table.columns))
          if !table.imported {
            migrationEntries.append(try migrationEntry(data))
          }
          if table.imported { try sink.write(contentsOf: data + Data([10])) }
        }
        continue
      }
      guard let line = String(data: data, encoding: .utf8), !line.contains("\0") else {
        try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_HEADER_TEXT_INVALID")
      }
      if line.isEmpty || line.hasPrefix("--") || ignoredStatements.contains(line) { continue }
      if line.hasPrefix("\\restrict ") {
        let token = String(line.dropFirst(10))
        guard restrictToken == nil, validToken(token) else {
          try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_RESTRICT_INVALID")
        }
        restrictToken = token
        continue
      }
      if line.hasPrefix("\\unrestrict ") {
        let token = String(line.dropFirst(12))
        guard restrictToken == token, expectedIndex == RuntimeDatabaseImportSchema.tables.count
        else { try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_FINAL_STATE_INVALID") }
        restrictToken = nil
        continue
      }
      if expectedIndex < RuntimeDatabaseImportSchema.tables.count {
        let table = RuntimeDatabaseImportSchema.tables[expectedIndex]
        guard line == table.header else {
          try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_COPY_ORDER_INVALID")
        }
        if table.imported { try write("\(table.stagingHeader)\n", to: sink) }
        current = table
        expectedIndex += 1
        continue
      }
      let sequence = try parseSequence(line)
      guard RuntimeDatabaseImportSchema.sequences.contains(sequence.0),
        sequenceValues[sequence.0] == nil
      else { try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_SEQUENCE_INVALID") }
      sequenceValues[sequence.0] = (sequence.1, sequence.2)
    }
    guard current == nil, restrictToken == nil,
      expectedIndex == RuntimeDatabaseImportSchema.tables.count,
      Set(sequenceValues.keys) == Set(RuntimeDatabaseImportSchema.sequences)
    else { try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_FINAL_STATE_INVALID") }
    try validateMigrationEntries(
      migrationEntries, expectedSHA256: expectedMigrationsSHA256)
    for name in RuntimeDatabaseImportSchema.loadOrder {
      guard let table = RuntimeDatabaseImportSchema.tables.first(where: { $0.name == name })
      else { try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_INTERNAL_INVALID") }
      try write(
        "INSERT INTO public.\(name) (\(table.columns)) SELECT \(table.columns) FROM \(table.stagingName);\n",
        to: sink)
    }
    for name in RuntimeDatabaseImportSchema.sequences {
      guard let value = sequenceValues[name] else {
        try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_INTERNAL_INVALID")
      }
      try write(
        "SELECT pg_catalog.setval('public.\(name)', \(value.0), \(value.1));\n", to: sink)
    }
    try write("COMMIT;\n", to: sink)
  }

  private static func validateRow(_ row: Data, columns: Int) throws {
    guard !row.isEmpty, row.count <= maximumLineBytes, !row.contains(0), !row.contains(13),
      row.reduce(1, { $1 == 9 ? $0 + 1 : $0 }) == columns
    else { try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_ROW_INVALID") }
    var index = row.startIndex
    while index < row.endIndex {
      guard row[index] != 92 else {
        index += 1
        guard index < row.endIndex else {
          try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_ROW_INVALID")
        }
        let value = row[index]
        if [98, 102, 110, 114, 116, 118, 92].contains(value) {
          index += 1
        } else if value == 78 {
          let fieldStart = index == row.startIndex + 1 || row[index - 2] == 9
          let fieldEnd = index + 1 == row.endIndex || row[index + 1] == 9
          guard fieldStart, fieldEnd else {
            try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_ROW_INVALID")
          }
          index += 1
        } else if (48...55).contains(value) {
          var count = 0
          while index < row.endIndex, count < 3, (48...55).contains(row[index]) {
            index += 1
            count += 1
          }
        } else if value == 120 {
          index += 1
          var count = 0
          while index < row.endIndex, count < 2, hexadecimal(row[index]) {
            index += 1
            count += 1
          }
          guard count > 0 else {
            try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_ROW_INVALID")
          }
        } else {
          try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_ROW_INVALID")
        }
        continue
      }
      index += 1
    }
  }

  private static func parseSequence(_ line: String) throws -> (String, String, String) {
    let pattern = #"^SELECT pg_catalog\.setval\('public\.([a-z0-9_]+)', ([0-9]+), (true|false)\);$"#
    let regex = try NSRegularExpression(pattern: pattern)
    let range = NSRange(line.startIndex..<line.endIndex, in: line)
    guard let match = regex.firstMatch(in: line, range: range), match.range == range,
      let nameRange = Range(match.range(at: 1), in: line),
      let valueRange = Range(match.range(at: 2), in: line),
      let calledRange = Range(match.range(at: 3), in: line),
      Int64(line[valueRange]) != nil
    else { try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_SEQUENCE_INVALID") }
    return (String(line[nameRange]), String(line[valueRange]), String(line[calledRange]))
  }

  private static func migrationEntry(_ row: Data) throws -> (String, String) {
    guard let line = String(data: row, encoding: .utf8) else {
      try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_MIGRATION_DIGEST_INVALID")
    }
    let fields = line.split(separator: "\t", omittingEmptySubsequences: false)
    guard fields.count == 3,
      fields[0].range(
        of: "^[0-9]{4}_[a-z0-9_]+\\.sql$", options: .regularExpression) != nil,
      fields[1].range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      !fields[2].isEmpty, !fields[2].contains("\\")
    else { try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_MIGRATION_DIGEST_INVALID") }
    return (String(fields[0]), String(fields[1]))
  }

  private static func validateMigrationEntries(
    _ entries: [(String, String)], expectedSHA256: String
  ) throws {
    guard !entries.isEmpty, expectedSHA256.count == 64 else {
      try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_MIGRATION_DIGEST_INVALID")
    }
    for (index, entry) in entries.enumerated() {
      guard Int(entry.0.prefix(4)) == index + 1 else {
        try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_MIGRATION_DIGEST_INVALID")
      }
    }
    let canonical = entries.map { "\($0.0)\0\($0.1)\n" }.joined()
    let digest = SHA256.hash(data: Data(canonical.utf8))
      .map { String(format: "%02x", $0) }.joined()
    guard digest == expectedSHA256 else {
      try contentInvalid("RUNTIME_TRANSFER_PAYLOAD_DATABASE_MIGRATION_DIGEST_INVALID")
    }
  }

  private static func columnCount(_ columns: String) -> Int {
    columns.split(separator: ",", omittingEmptySubsequences: false).count
  }

  private static func validToken(_ token: String) -> Bool {
    (63...64).contains(token.count)
      && token.utf8.allSatisfy {
        (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
      }
  }

  private static func hexadecimal(_ value: UInt8) -> Bool {
    (48...57).contains(value) || (65...70).contains(value) || (97...102).contains(value)
  }

  private static func write(_ value: String, to handle: FileHandle) throws {
    guard let data = value.data(using: .utf8) else { try invalid() }
    try handle.write(contentsOf: data)
  }

  private static func invalid() throws -> Never {
    try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID")
  }

  private static func contentInvalid(_ code: String) throws -> Never {
    #if RUNTIME_TESTING
      try runtimeFail(code)
    #else
      try invalid()
    #endif
  }

  private static func diagnostic(_ code: String, _ error: Error) throws -> Never {
    #if RUNTIME_TESTING
      try runtimeFail(code)
    #else
      throw error
    #endif
  }
}

private final class RuntimeDatabaseLineReader {
  private let handle: FileHandle
  private let maximumLineBytes: Int
  private var buffer = Data()
  private var ended = false

  init(handle: FileHandle, maximumLineBytes: Int) {
    self.handle = handle
    self.maximumLineBytes = maximumLineBytes
  }

  func next() throws -> Data? {
    while true {
      if let newline = buffer.firstIndex(of: 10) {
        let line = Data(buffer[..<newline])
        buffer.removeSubrange(...newline)
        guard line.count <= maximumLineBytes else { try invalid() }
        return line
      }
      if ended {
        guard !buffer.isEmpty else { return nil }
        let line = buffer
        buffer.removeAll(keepingCapacity: false)
        guard line.count <= maximumLineBytes else { try invalid() }
        return line
      }
      let chunk = try handle.read(upToCount: 65_536) ?? Data()
      if chunk.isEmpty { ended = true } else { buffer.append(chunk) }
      guard buffer.count <= maximumLineBytes else { try invalid() }
    }
  }

  private func invalid() throws -> Never {
    try runtimeFail("RUNTIME_TRANSFER_PAYLOAD_INVALID")
  }
}
