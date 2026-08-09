import Foundation

enum RuntimeCLIDataProtection {
  private static func object(_ data: Data, keys: Set<String>) throws -> Data {
    guard !data.isEmpty, data.count <= 4_096,
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == keys
    else { try runtimeFail("RUNTIME_TRANSFER_STDIN_INVALID") }
    return data
  }

  private static func common(_ path: String, _ password: String) throws {
    guard path.hasPrefix("/"), !path.contains("\0"), path.utf8.count <= 2_048,
      path.hasSuffix(".laundry-transfer"), (12...256).contains(password.utf8.count)
    else { try runtimeFail("RUNTIME_TRANSFER_STDIN_INVALID") }
  }

  private static func exportRequest(_ data: Data) throws -> RuntimeTransferExportRequest {
    let value = try object(data, keys: ["backup_id", "path", "password"])
    guard let request = try? JSONDecoder().decode(RuntimeTransferExportRequest.self, from: value),
      RuntimeBackupCodec.validBackupID(request.backupID)
    else { try runtimeFail("RUNTIME_TRANSFER_STDIN_INVALID") }
    try common(request.path, request.password)
    return request
  }

  private static func inspectRequest(_ data: Data) throws -> RuntimeTransferInspectRequest {
    let value = try object(data, keys: ["path", "password"])
    guard let request = try? JSONDecoder().decode(RuntimeTransferInspectRequest.self, from: value)
    else { try runtimeFail("RUNTIME_TRANSFER_STDIN_INVALID") }
    try common(request.path, request.password)
    return request
  }

  private static func importRequest(_ data: Data) throws -> RuntimeTransferImportRequest {
    let value = try object(data, keys: ["path", "password", "confirmation"])
    guard let request = try? JSONDecoder().decode(RuntimeTransferImportRequest.self, from: value),
      request.confirmation.range(
        of: "^TRANSFER-[0-9A-F]{12}$", options: .regularExpression) != nil
    else { try runtimeFail("RUNTIME_TRANSFER_STDIN_INVALID") }
    try common(request.path, request.password)
    return request
  }

  private static func encoded<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  static func run(
    arguments: [String], stdin: Data, controller: NativeRuntimeController
  ) throws -> String {
    #if RUNTIME_TESTING
      if arguments == ["transfer", "self-test"] {
        guard stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
        return try encoded(RuntimePortableArchiveTesting.run())
      }
      if arguments == ["transfer", "payload-self-test"] {
        guard stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
        return try encoded(RuntimeTransferPayloadValidationTesting.run())
      }
      if arguments == ["transfer", "gate-self-test"] {
        guard stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
        return try encoded(
          RuntimeTransferRecoveryGateTesting.run(
            resources: controller.paths.compose.deletingLastPathComponent()))
      }
      if arguments == ["transfer", "photo-consistency-self-test"] {
        guard stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
        return try encoded(RuntimePhotoConsistencyTesting.run())
      }
    #endif
    guard arguments.count == 2, arguments[0] == "transfer" else {
      try runtimeFail("RUNTIME_ARGS_INVALID")
    }
    if arguments[1] == "export" {
      return try encoded(controller.exportTransfer(exportRequest(stdin)))
    }
    if arguments[1] == "inspect" {
      return try encoded(controller.inspectTransfer(inspectRequest(stdin)))
    }
    if arguments[1] == "import" {
      return try encoded(controller.importTransfer(importRequest(stdin)))
    }
    try runtimeFail("RUNTIME_ARGS_INVALID")
  }
}
