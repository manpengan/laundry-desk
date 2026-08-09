import Foundation

enum RuntimeCLI {
  private static func manifestURL(_ arguments: [String], command: String) throws -> URL {
    guard arguments.count == 3, arguments[0] == command, arguments[1] == "--manifest",
      arguments[2].hasPrefix("/"), !arguments[2].contains("\0")
    else { try runtimeFail("RUNTIME_ARGS_INVALID") }
    return URL(fileURLWithPath: arguments[2]).standardizedFileURL
  }

  private static func setup(_ data: Data) throws -> RuntimeSetup {
    guard !data.isEmpty, data.count <= 4_096,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == [
        "adminUsername", "adminDisplayName", "adminPassword", "adminPin",
        "approverUsername", "approverDisplayName", "approverPassword", "approverPin",
      ],
      let value = try? JSONDecoder().decode(RuntimeSetup.self, from: data)
    else { try runtimeFail("RUNTIME_SETUP_STDIN_INVALID") }
    return value
  }

  private static func commissionSetup(_ data: Data) throws -> RuntimeCommissionSetup {
    guard !data.isEmpty, data.count <= 2_048,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == [
        "approverUsername", "approverDisplayName", "approverPassword", "approverPin",
      ],
      let value = try? JSONDecoder().decode(RuntimeCommissionSetup.self, from: data)
    else { try runtimeFail("RUNTIME_COMMISSION_STDIN_INVALID") }
    return value
  }

  private static func lanSetup(_ data: Data) throws -> RuntimeLanSetup {
    guard !data.isEmpty, data.count <= 32_768,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["bind_ipv4", "port", "certificate_pem", "private_key_pem"],
      let value = try? JSONDecoder().decode(RuntimeLanSetup.self, from: data),
      value.certificatePEM.utf8.count <= 16_384,
      value.privateKeyPEM.utf8.count <= 16_384
    else { try runtimeFail("RUNTIME_LAN_STDIN_INVALID") }
    return value
  }

  private static func backupSelection(_ data: Data) throws -> RuntimeBackupSelection {
    guard !data.isEmpty, data.count <= 512,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["backup_id"],
      let value = try? JSONDecoder().decode(RuntimeBackupSelection.self, from: data),
      RuntimeBackupCodec.validBackupID(value.backupID)
    else { try runtimeFail("RUNTIME_BACKUP_STDIN_INVALID") }
    return value
  }

  private static func restoreRequest(_ data: Data) throws -> RuntimeRestoreRequest {
    guard !data.isEmpty, data.count <= 512,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["backup_id", "confirmation"],
      let value = try? JSONDecoder().decode(RuntimeRestoreRequest.self, from: data),
      RuntimeBackupCodec.validBackupID(value.backupID),
      value.confirmation.range(
        of: "^RESTORE-[0-9A-F]{12}$", options: .regularExpression) != nil
    else { try runtimeFail("RUNTIME_BACKUP_STDIN_INVALID") }
    return value
  }

  private static func rollbackRequest(_ data: Data) throws -> RuntimeRollbackRequest {
    guard !data.isEmpty, data.count <= 256,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["confirmation"],
      let value = try? JSONDecoder().decode(RuntimeRollbackRequest.self, from: data),
      value.confirmation.hasPrefix("ROLLBACK-"),
      (try? RuntimeManifestVerifier.compareVersions(
        String(value.confirmation.dropFirst("ROLLBACK-".count)),
        String(value.confirmation.dropFirst("ROLLBACK-".count)))) == 0
    else { try runtimeFail("RUNTIME_ROLLBACK_STDIN_INVALID") }
    return value
  }

  private static func encoded<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  private static func output(
    _ status: String, release: String? = nil,
    path: String? = nil
  ) throws -> String {
    var value: [String: String] = ["status": status]
    if let release { value["release"] = release }
    if let path { value["path"] = path }
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
  }

  static func run(
    arguments: [String], stdin: Data, controller: NativeRuntimeController,
    runner: RuntimeRunner, executable: String
  ) throws -> String {
    guard let command = arguments.first else { try runtimeFail("RUNTIME_ARGS_INVALID") }
    if command == "transfer" {
      return try RuntimeCLIDataProtection.run(
        arguments: arguments, stdin: stdin, controller: controller)
    }
    if command == "install" {
      let release = try controller.install(
        manifestURL: manifestURL(arguments, command: command),
        setup: setup(stdin))
      return try output("ready", release: release)
    }
    if command == "recover" {
      let release = try controller.recover(manifestURL: manifestURL(arguments, command: command))
      return try output("ready", release: release)
    }
    if command == "commission" {
      guard arguments.count == 1 else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      return try encoded(controller.commission(commissionSetup(stdin)))
    }
    if command == "maintenance" {
      guard arguments.count == 1, stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      return try encoded(controller.maintenance())
    }
    if command == "upgrade" {
      guard stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      return try encoded(
        controller.upgrade(manifestURL: manifestURL(arguments, command: command)))
    }
    if command == "rollback" {
      guard arguments.count == 1 else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      return try encoded(controller.rollback(rollbackRequest(stdin)))
    }
    if command == "backup" {
      guard arguments.count == 2 else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      if arguments[1] == "create" {
        guard stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
        return try encoded(controller.createBackup())
      }
      if arguments[1] == "list" {
        guard stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
        return try encoded(RuntimeBackupList(backups: controller.listBackups()))
      }
      if arguments[1] == "verify" {
        return try encoded(controller.verifyBackup(backupSelection(stdin).backupID))
      }
      if arguments[1] == "restore" {
        return try encoded(controller.restoreBackup(restoreRequest(stdin)))
      }
      try runtimeFail("RUNTIME_ARGS_INVALID")
    }
    if command == "lan" {
      guard arguments.count == 2 else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      let operation = arguments[1]
      if operation == "configure" {
        return try encoded(controller.configureLan(lanSetup(stdin)))
      }
      guard stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      if operation == "enable" { return try encoded(controller.enableLan()) }
      if operation == "disable" { return try encoded(controller.disableLan()) }
      if operation == "status" { return try encoded(controller.lanStatus()) }
      if operation == "onboard" { return try encoded(controller.lanOnboarding()) }
      if operation == "diagnose" { return try encoded(controller.diagnoseLan()) }
      try runtimeFail("RUNTIME_ARGS_INVALID")
    }
    if command == "support" {
      guard arguments == ["support", "create"], stdin.isEmpty else {
        try runtimeFail("RUNTIME_ARGS_INVALID")
      }
      return try encoded(controller.createSupportBundle())
    }
    if ["start", "stop", "restart", "status", "diagnose"].contains(command) {
      guard arguments.count == 1, stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      if command == "start" { return try output("ready", release: controller.start()) }
      if command == "stop" { return try output("stopped", release: controller.stop()) }
      if command == "restart" { return try output("ready", release: controller.restart()) }
      let data = try JSONEncoder().encode(controller.diagnose())
      return String(decoding: data, as: UTF8.self)
    }
    if command == "launchd" {
      guard arguments.count == 2, stdin.isEmpty else { try runtimeFail("RUNTIME_ARGS_INVALID") }
      if arguments[1] == "install" {
        return try output(
          "installed",
          path: controller.installLaunchAgent(executable: executable))
      }
      if arguments[1] == "uninstall" {
        return try output("uninstalled", path: controller.uninstallLaunchAgent())
      }
    }
    try runtimeFail("RUNTIME_ARGS_INVALID")
  }
}
