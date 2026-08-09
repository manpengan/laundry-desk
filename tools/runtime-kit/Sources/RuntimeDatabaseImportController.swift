import Foundation

enum RuntimeDatabaseImportCapacity {
  private static let expansionFactor: Int64 = 12
  private static let reserveBytes: Int64 = 4_294_967_296

  static func assertAvailable(_ output: String, sanitizedBytes: Int64) throws {
    let available: Int64
    #if RUNTIME_TESTING
      if let override = ProcessInfo.processInfo.environment[
        "LAUNDRY_RUNTIME_TEST_DATABASE_CAPACITY_BYTES"
      ], let value = Int64(override) {
        available = value
      } else {
        available = try parseAvailable(output)
      }
    #else
      available = try parseAvailable(output)
    #endif
    guard sanitizedBytes > 0, available > reserveBytes,
      sanitizedBytes <= (available - reserveBytes) / expansionFactor
    else { try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW") }
  }

  private static func parseAvailable(_ output: String) throws -> Int64 {
    let lines = output.split(whereSeparator: \.isNewline)
    guard lines.count == 2, lines[0].contains("1024-blocks") else {
      try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW")
    }
    let fields = lines[1].split(whereSeparator: \.isWhitespace)
    guard fields.count == 6, let kilobytes = Int64(fields[3]), kilobytes > 0,
      kilobytes <= Int64.max / 1_024
    else { try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW") }
    return kilobytes * 1_024
  }
}

extension NativeRuntimeController {
  func importSanitizedDatabase(
    from sanitized: URL, state: RuntimeState, payload: RuntimeManifestPayload
  ) throws {
    let environment = environment(state, payload)
    let digest = try RuntimeStorage.privateFileDigest(
      sanitized, maximum: RuntimeBackupCodec.maximumArtifactBytes)
    let capacity = try run(
      RuntimeBackupCommands.databaseCapacity(controller: self, environment: environment))
    try RuntimeDatabaseImportCapacity.assertAvailable(
      capacity.stdout, sanitizedBytes: digest.size)
    try run(RuntimeBackupCommands.resetDatabase(controller: self, environment: environment))
    try run(compose(["run", "--rm", "roles"], environment: environment))
    try run(compose(["run", "--rm", "migrate"], environment: environment))
    var loadError: Error?
    do {
      try run(
        RuntimeBackupCommands.prepareDatabaseImport(
          controller: self, environment: environment))
      try stream(
        RuntimeBackupCommands.loadSanitizedDatabase(
          controller: self, environment: environment),
        input: RuntimeStreamInput(
          url: sanitized, size: digest.size, sha256: digest.sha256),
        discardOutput: true)
    } catch {
      loadError = error
    }
    var cleanupError: Error?
    do {
      try run(
        RuntimeBackupCommands.cleanupDatabaseImport(
          controller: self, environment: environment))
    } catch {
      cleanupError = error
    }
    if cleanupError != nil { try runtimeFail("RUNTIME_DATABASE_IMPORT_CLEANUP_FAILED") }
    if let loadError { throw loadError }
    do {
      try run(
        RuntimeBackupCommands.verifyDatabaseImportAuthority(
          controller: self, environment: environment))
    } catch {
      try? run(
        RuntimeBackupCommands.cleanupDatabaseImport(
          controller: self, environment: environment))
      try runtimeFail("RUNTIME_DATABASE_IMPORT_CLEANUP_FAILED")
    }
    try run(compose(["run", "--rm", "verify"], environment: environment))
  }
}
