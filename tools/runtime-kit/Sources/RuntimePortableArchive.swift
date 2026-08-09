import CryptoKit
import Foundation

enum RuntimePortableArchive {
  static let version = 1
  static let chunkBytes = 1_048_576
  static let maximumPlaintextBytes: Int64 = 137_438_953_472
  static let maximumArchiveBytes: Int64 = {
    let chunk = Int64(chunkBytes)
    let count = (maximumPlaintextBytes + chunk - 1) / chunk
    return maximumPlaintextBytes + Int64(headerBytes)
      + count * Int64(recordHeaderBytes + tagBytes)
  }()
  private static let headerBytes = 56
  private static let tagBytes = 16
  private static let recordHeaderBytes = 4
  private static let magic = Data("LDRXFER1".utf8)
  private static let kdfIdentifier: UInt8 = 1
  private static let aeadIdentifier: UInt8 = 1

  private struct Header {
    let data: Data
    let iterations: Int
    let salt: Data
    let noncePrefix: Data
    let plaintextBytes: Int64
    let chunkCount: Int
  }

  static func archiveBytes(forPlaintext plaintextBytes: Int64) throws -> Int64 {
    let count = try validatedChunkCount(plaintextBytes)
    return archiveBytes(plaintextBytes: plaintextBytes, chunkCount: count)
  }

  static func encrypt(
    source: (Int) throws -> Data,
    totalBytes: Int64,
    password: String,
    output: FileHandle,
    iterations: Int? = nil
  ) throws -> RuntimePortableArchiveMetadata {
    do {
      guard try output.offset() == 0 else { try runtimeFail("RUNTIME_TRANSFER_WRITE_FAILED") }
    } catch {
      try runtimeFail("RUNTIME_TRANSFER_WRITE_FAILED")
    }
    let rounds = iterations ?? RuntimePasswordKDF.calibratedIterations()
    try RuntimePasswordKDF.validateIterations(rounds)
    let count = try validatedChunkCount(totalBytes)
    let header = try makeHeader(
      iterations: rounds, salt: RuntimePasswordKDF.randomBytes(count: 16),
      noncePrefix: RuntimePasswordKDF.randomBytes(count: 4),
      plaintextBytes: totalBytes, chunkCount: count)
    let key = try RuntimePasswordKDF.deriveKey(
      password: password, salt: header.salt, iterations: rounds)
    var archiveHash = SHA256()
    try write(header.data, to: output, hash: &archiveHash)
    for index in 0..<count {
      let expected = expectedChunkBytes(index: index, count: count, totalBytes: totalBytes)
      let plaintext = try readSource(exactly: expected, source: source)
      let record = recordHeader(plaintextBytes: expected)
      let aad = authenticatedData(header: header.data, index: index, record: record)
      let sealed: AES.GCM.SealedBox
      do {
        sealed = try AES.GCM.seal(
          plaintext, using: key, nonce: try nonce(prefix: header.noncePrefix, index: index),
          authenticating: aad)
      } catch {
        try runtimeFail("RUNTIME_TRANSFER_ENCRYPT_FAILED")
      }
      guard sealed.ciphertext.count == expected, sealed.tag.count == tagBytes else {
        try runtimeFail("RUNTIME_TRANSFER_ENCRYPT_FAILED")
      }
      try write(record, to: output, hash: &archiveHash)
      try write(sealed.ciphertext, to: output, hash: &archiveHash)
      try write(sealed.tag, to: output, hash: &archiveHash)
    }
    guard try source(1).isEmpty else { try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID") }
    let result = metadata(header, archiveSHA256: digestHex(archiveHash.finalize()))
    do {
      guard try output.offset() == UInt64(result.archiveBytes) else {
        try runtimeFail("RUNTIME_TRANSFER_WRITE_FAILED")
      }
      try output.synchronize()
    } catch {
      try runtimeFail("RUNTIME_TRANSFER_WRITE_FAILED")
    }
    return result
  }

  static func decrypt(
    input: FileHandle,
    password: String,
    preflight: (RuntimePortableArchiveMetadata) throws -> Void = { _ in },
    sink: (Data) throws -> Void
  ) throws -> RuntimePortableArchiveMetadata {
    do {
      guard try input.offset() == 0 else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    } catch {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
    let headerData = try readInput(exactly: headerBytes, from: input)
    let header = try decodeHeader(headerData)
    try preflight(metadata(header, archiveSHA256: nil))
    let key = try RuntimePasswordKDF.deriveKey(
      password: password, salt: header.salt, iterations: header.iterations)
    var archiveHash = SHA256()
    archiveHash.update(data: headerData)
    for index in 0..<header.chunkCount {
      let record = try readInput(exactly: recordHeaderBytes, from: input)
      let encodedLength = try decodeRecord(record)
      let expected = expectedChunkBytes(
        index: index, count: header.chunkCount, totalBytes: header.plaintextBytes)
      guard encodedLength == expected else {
        try runtimeFail("RUNTIME_TRANSFER_INVALID")
      }
      let ciphertext = try readInput(exactly: expected, from: input)
      let tag = try readInput(exactly: tagBytes, from: input)
      archiveHash.update(data: record)
      archiveHash.update(data: ciphertext)
      archiveHash.update(data: tag)
      let plaintext: Data
      do {
        let box = try AES.GCM.SealedBox(
          nonce: try nonce(prefix: header.noncePrefix, index: index),
          ciphertext: ciphertext, tag: tag)
        plaintext = try AES.GCM.open(
          box, using: key,
          authenticating: authenticatedData(header: header.data, index: index, record: record))
      } catch {
        try runtimeFail("RUNTIME_TRANSFER_INVALID")
      }
      guard plaintext.count == expected else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
      try sink(plaintext)
    }
    guard try readAtMostOneByte(from: input).isEmpty else {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
    return metadata(header, archiveSHA256: digestHex(archiveHash.finalize()))
  }

  private static func validatedChunkCount(_ totalBytes: Int64) throws -> Int {
    guard totalBytes > 0, totalBytes <= maximumPlaintextBytes else {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
    return Int((totalBytes + Int64(chunkBytes) - 1) / Int64(chunkBytes))
  }

  private static func makeHeader(
    iterations: Int, salt: Data, noncePrefix: Data,
    plaintextBytes: Int64, chunkCount: Int
  ) throws -> Header {
    guard salt.count == 16, noncePrefix.count == 4,
      chunkCount == (try validatedChunkCount(plaintextBytes))
    else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    var data = Data()
    data.append(magic)
    append(UInt16(version), to: &data)
    data.append(kdfIdentifier)
    data.append(aeadIdentifier)
    append(UInt32(iterations), to: &data)
    data.append(salt)
    data.append(noncePrefix)
    append(UInt32(chunkBytes), to: &data)
    append(UInt64(plaintextBytes), to: &data)
    append(UInt64(chunkCount), to: &data)
    guard data.count == headerBytes else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    return Header(
      data: data, iterations: iterations, salt: salt, noncePrefix: noncePrefix,
      plaintextBytes: plaintextBytes, chunkCount: chunkCount)
  }

  private static func decodeHeader(_ data: Data) throws -> Header {
    do {
      var cursor = Cursor(data)
      guard try cursor.read(magic.count) == magic,
        try cursor.uint16() == UInt16(version),
        try cursor.uint8() == kdfIdentifier,
        try cursor.uint8() == aeadIdentifier
      else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
      let iterations = Int(try cursor.uint32())
      try RuntimePasswordKDF.validateIterations(iterations)
      let salt = try cursor.read(16)
      let prefix = try cursor.read(4)
      guard try cursor.uint32() == UInt32(chunkBytes) else {
        try runtimeFail("RUNTIME_TRANSFER_INVALID")
      }
      let plaintextRaw = try cursor.uint64()
      guard plaintextRaw <= UInt64(Int64.max) else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
      let plaintextBytes = Int64(plaintextRaw)
      let chunkCountRaw = try cursor.uint64()
      guard chunkCountRaw <= UInt64(Int.max) else {
        try runtimeFail("RUNTIME_TRANSFER_INVALID")
      }
      let chunkCount = Int(chunkCountRaw)
      guard cursor.atEnd,
        chunkCount == (try validatedChunkCount(plaintextBytes))
      else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
      return Header(
        data: data, iterations: iterations, salt: salt, noncePrefix: prefix,
        plaintextBytes: plaintextBytes, chunkCount: chunkCount)
    } catch {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
  }

  private static func recordHeader(plaintextBytes: Int) -> Data {
    var data = Data()
    append(UInt32(plaintextBytes), to: &data)
    return data
  }

  private static func decodeRecord(_ data: Data) throws -> Int {
    var cursor = Cursor(data)
    let value = Int(try cursor.uint32())
    guard cursor.atEnd else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    return value
  }

  private static func expectedChunkBytes(index: Int, count: Int, totalBytes: Int64) -> Int {
    if index < count - 1 { return chunkBytes }
    return Int(totalBytes - Int64(index) * Int64(chunkBytes))
  }

  private static func nonce(prefix: Data, index: Int) throws -> AES.GCM.Nonce {
    guard prefix.count == 4, index >= 0 else {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
    var data = prefix
    append(UInt64(index), to: &data)
    return try AES.GCM.Nonce(data: data)
  }

  private static func authenticatedData(header: Data, index: Int, record: Data) -> Data {
    var data = header
    append(UInt64(index), to: &data)
    data.append(record)
    return data
  }

  private static func readSource(
    exactly count: Int, source: (Int) throws -> Data
  ) throws -> Data {
    var data = Data()
    while data.count < count {
      let remaining = count - data.count
      let part = try source(remaining)
      guard !part.isEmpty, part.count <= remaining else {
        try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID")
      }
      data.append(part)
    }
    return data
  }

  private static func readInput(exactly count: Int, from input: FileHandle) throws -> Data {
    var data = Data()
    do {
      while data.count < count {
        let part = try input.read(upToCount: count - data.count) ?? Data()
        guard !part.isEmpty else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
        data.append(part)
      }
    } catch {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
    return data
  }

  private static func readAtMostOneByte(from input: FileHandle) throws -> Data {
    do { return try input.read(upToCount: 1) ?? Data() } catch {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
  }

  private static func write(
    _ data: Data, to output: FileHandle, hash: inout SHA256
  ) throws {
    do { try output.write(contentsOf: data) } catch {
      try runtimeFail("RUNTIME_TRANSFER_WRITE_FAILED")
    }
    hash.update(data: data)
  }

  private static func metadata(
    _ header: Header, archiveSHA256: String?
  ) -> RuntimePortableArchiveMetadata {
    RuntimePortableArchiveMetadata(
      version: version, iterations: header.iterations,
      plaintextBytes: header.plaintextBytes, chunkCount: header.chunkCount,
      archiveBytes: archiveBytes(
        plaintextBytes: header.plaintextBytes, chunkCount: header.chunkCount),
      archiveSHA256: archiveSHA256)
  }

  private static func digestHex(_ digest: SHA256.Digest) -> String {
    digest.map { String(format: "%02x", $0) }.joined()
  }

  private static func archiveBytes(plaintextBytes: Int64, chunkCount: Int) -> Int64 {
    Int64(headerBytes) + plaintextBytes
      + Int64(chunkCount) * Int64(recordHeaderBytes + tagBytes)
  }

  private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var bigEndian = value.bigEndian
    withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
  }

  private struct Cursor {
    let data: Data
    var offset = 0

    init(_ data: Data) { self.data = data }
    var atEnd: Bool { offset == data.count }

    mutating func read(_ count: Int) throws -> Data {
      guard count >= 0, offset <= data.count - count else {
        try runtimeFail("RUNTIME_TRANSFER_INVALID")
      }
      defer { offset += count }
      return data.subdata(in: offset..<(offset + count))
    }

    mutating func uint8() throws -> UInt8 { try read(1)[0] }
    mutating func uint16() throws -> UInt16 { try integer(UInt16.self) }
    mutating func uint32() throws -> UInt32 { try integer(UInt32.self) }
    mutating func uint64() throws -> UInt64 { try integer(UInt64.self) }

    private mutating func integer<T: FixedWidthInteger>(_ type: T.Type) throws -> T {
      let bytes = try read(MemoryLayout<T>.size)
      return bytes.reduce(T.zero) { ($0 << 8) | T($1) }
    }
  }
}
