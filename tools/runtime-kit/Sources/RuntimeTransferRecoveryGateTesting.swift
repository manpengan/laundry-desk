#if RUNTIME_TESTING
  import Foundation

  struct RuntimeTransferRecoveryGateTestResult: Codable {
    let status: String
    let blockedOperations: [String]
    let allowedOperations: [String]
    let safeRecovery: Bool
    let exactRestoreRecovery: Bool
    let startingFailClosed: Bool
    let invalidStateFailClosed: Bool

    enum CodingKeys: String, CodingKey {
      case status
      case blockedOperations = "blocked_operations"
      case allowedOperations = "allowed_operations"
      case safeRecovery = "safe_recovery"
      case exactRestoreRecovery = "exact_restore_recovery"
      case startingFailClosed = "starting_fail_closed"
      case invalidStateFailClosed = "invalid_state_fail_closed"
    }
  }

  enum RuntimeTransferRecoveryGateTesting {
    private static let recoveryCode = "RUNTIME_TRANSFER_RECOVERY_REQUIRED"
    private static let safetyBackupID =
      "safety-20260808T120000Z-AAAAAAAAAAAAAAAAAAAAAA"

    private static func recovery(
      phase: String, safetyBackupID: String? = Self.safetyBackupID,
      exportID: String = "BBBBBBBBBBBBBBBBBBBBBB"
    ) -> RuntimeTransferRecoveryState {
      RuntimeTransferRecoveryState(
        version: 1, phase: phase, startedAt: "2026-08-08T12:00:00.000Z",
        exportID: exportID, sourceInstanceID: "CCCCCCCCCCCCCCCCCCCCCC",
        backupID: "manual-20260808T110000Z-DDDDDDDDDDDDDDDDDDDDDD",
        safetyBackupID: safetyBackupID, faultCode: nil)
    }

    private static func errorCode(_ body: () throws -> Void) -> String? {
      do {
        try body()
        return nil
      } catch {
        return (error as? RuntimeKitError)?.description ?? "RUNTIME_FAILED"
      }
    }

    private static func assertBlocked(
      _ operations: [(String, () throws -> Void)]
    ) throws -> [String] {
      try operations.map { name, operation in
        guard errorCode(operation) == recoveryCode else {
          try runtimeFail("RUNTIME_TRANSFER_GATE_SELF_TEST_FAILED")
        }
        return name
      }
    }

    private static func validSetup() -> RuntimeSetup {
      RuntimeSetup(
        adminUsername: "admin", adminDisplayName: "Admin",
        adminPassword: "admin-password-strong", adminPin: "123456",
        approverUsername: "approver", approverDisplayName: "Approver",
        approverPassword: "approver-password-strong", approverPin: "654321")
    }

    private static func validCommissionSetup() -> RuntimeCommissionSetup {
      RuntimeCommissionSetup(
        approverUsername: "approver", approverDisplayName: "Approver",
        approverPassword: "approver-password-strong", approverPin: "654321")
    }

    static func run(resources: URL) throws -> RuntimeTransferRecoveryGateTestResult {
      let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent(
          "laundry-transfer-gate-self-test-\(UUID().uuidString)", isDirectory: true)
      try RuntimeStorage.ensureDirectory(root)
      defer { try? FileManager.default.removeItem(at: root) }
      let paths = RuntimePaths.resolve(root: root, resources: resources)
      let log = root.appendingPathComponent("runner.log")
      let controller = NativeRuntimeController(
        paths: paths, runner: FakeRuntimeRunner(logURL: log), appVersion: "0.1.0")

      try RuntimeStorage.ensureDirectory(paths.transferStaging)
      let stale = paths.transferStaging.appendingPathComponent(
        "AAAAAAAAAAAAAAAAAAAAAAAA", isDirectory: true)
      try RuntimeStorage.createExclusiveDirectory(stale)
      try RuntimeStorage.writeExclusive(
        Data("stale database list\n".utf8),
        to: stale.appendingPathComponent(
          ".database-list-BBBBBBBBBBBBBBBBBBBBBBBB"))
      try RuntimeStorage.ensureDirectory(paths.payloadValidationStaging)
      let validationStale = paths.payloadValidationStaging.appendingPathComponent(
        "DDDDDDDDDDDDDDDDDDDDDDDD", isDirectory: true)
      try RuntimeStorage.createExclusiveDirectory(validationStale)
      try RuntimeStorage.writeExclusive(
        Data("BEGIN;\nCOMMIT;\n".utf8),
        to: validationStale.appendingPathComponent(RuntimeDatabaseSanitizer.sanitizedName))
      try controller.prepareForRuntimeMutation()
      let noStateStagingRecovery =
        !RuntimeStorage.pathExists(stale) && !RuntimeStorage.pathExists(validationStale)

      try controller.writeTransferState(recovery(phase: "preflight_complete", safetyBackupID: nil))
      try controller.prepareForRuntimeMutation()
      let safeRecovery =
        noStateStagingRecovery
        && !RuntimeStorage.pathExists(paths.transferState)

      try controller.writeTransferState(recovery(phase: "failed"))
      let missingManifest = root.appendingPathComponent("missing-manifest.json")
      let transferPath = root.appendingPathComponent("missing.laundry-transfer").path
      let blocked = try assertBlocked([
        (
          "install",
          { _ = try controller.install(manifestURL: missingManifest, setup: validSetup()) }
        ),
        ("recover", { _ = try controller.recover(manifestURL: missingManifest) }),
        ("commission", { _ = try controller.commission(validCommissionSetup()) }),
        ("backup_create", { _ = try controller.createBackup() }),
        ("maintenance", { _ = try controller.maintenance() }),
        ("upgrade", { _ = try controller.upgrade(manifestURL: missingManifest) }),
        (
          "rollback",
          {
            _ = try controller.rollback(RuntimeRollbackRequest(confirmation: "ROLLBACK-0.1.0"))
          }
        ),
        ("start", { _ = try controller.start() }),
        ("restart", { _ = try controller.restart() }),
        (
          "lan_configure",
          {
            _ = try controller.configureLan(
              RuntimeLanSetup(
                bindIPv4: "192.0.2.10", port: 8443, certificatePEM: "invalid",
                privateKeyPEM: "invalid"))
          }
        ),
        ("lan_enable", { _ = try controller.enableLan() }),
        ("launchd_install", { _ = try controller.installLaunchAgent(executable: "/bin/false") }),
        (
          "transfer_export",
          {
            _ = try controller.exportTransfer(
              RuntimeTransferExportRequest(
                backupID: safetyBackupID, path: transferPath,
                password: "correct horse battery"))
          }
        ),
        (
          "transfer_inspect",
          {
            _ = try controller.inspectTransfer(
              RuntimeTransferInspectRequest(path: transferPath, password: "correct horse battery"))
          }
        ),
        (
          "transfer_import",
          {
            _ = try controller.importTransfer(
              RuntimeTransferImportRequest(
                path: transferPath, password: "correct horse battery",
                confirmation: "TRANSFER-000000000000"))
          }
        ),
      ])

      let testState = RuntimeState(
        version: 1, status: "installed", release: "0.1.0",
        manifestSHA256: String(repeating: "0", count: 64),
        composeSHA256: String(repeating: "0", count: 64),
        instanceID: "CCCCCCCCCCCCCCCCCCCCCC",
        volumes: controller.runtimeVolumes.map(\.name))
      let exact = try controller.prepareForBackupRestore(safetyBackupID, state: testState)
      let exactRestoreRecovery =
        exact?.safetyBackupID == safetyBackupID
        && errorCode({
          _ = try controller.prepareForBackupRestore(
            "safety-20260808T120001Z-EEEEEEEEEEEEEEEEEEEEEE", state: testState)
        }) == recoveryCode

      let allowed = [
        ("stop", errorCode({ _ = try controller.stop() })),
        ("lan_disable", errorCode({ _ = try controller.disableLan() })),
        ("support_create", errorCode({ _ = try controller.createSupportBundle() })),
        ("backup_list", errorCode({ _ = try controller.listBackups() })),
        ("backup_verify", errorCode({ _ = try controller.verifyBackup(safetyBackupID) })),
      ]
      guard allowed.allSatisfy({ $0.1 != recoveryCode }),
        controller.diagnose().transferPhase == "failed"
      else { try runtimeFail("RUNTIME_TRANSFER_GATE_SELF_TEST_FAILED") }

      try controller.writeTransferState(recovery(phase: "starting"))
      let startingCode = errorCode({ try controller.prepareForRuntimeMutation() })
      let startingState = try controller.readTransferState()
      let startingFailClosed =
        startingCode == recoveryCode
        && startingState?.phase == "failed"
        && startingState?.faultCode == recoveryCode
        && RuntimeStorage.pathExists(log)
      try RuntimeStorage.removePrivateFile(paths.transferState)
      try RuntimeStorage.writeExclusive(Data("invalid\n".utf8), to: paths.transferState)
      let invalidStateCode = errorCode({ try controller.prepareForRuntimeMutation() })
      let invalidStateDiagnosis = controller.transferDiagnosis()
      let invalidStateFailClosed =
        invalidStateCode == "RUNTIME_TRANSFER_STATE_INVALID"
        && invalidStateDiagnosis.phase == "invalid"
        && invalidStateDiagnosis.faultCode == "RUNTIME_TRANSFER_STATE_INVALID"
      try RuntimeStorage.removePrivateFile(paths.transferState)
      try controller.writeTransferState(
        recovery(
          phase: "failed", safetyBackupID: safetyBackupID,
          exportID: runtimeManagedRestoreExportID))
      let mismatchedState = RuntimeState(
        version: testState.version, status: testState.status, release: testState.release,
        manifestSHA256: testState.manifestSHA256, composeSHA256: testState.composeSHA256,
        instanceID: "EEEEEEEEEEEEEEEEEEEEEE", volumes: testState.volumes)
      let mismatchedInstanceCode = errorCode {
        _ = try controller.prepareForBackupRestore(safetyBackupID, state: mismatchedState)
      }
      let streamSource = root.appendingPathComponent("stream-source")
      let mutationControl = URL(fileURLWithPath: log.path + ".mutate-stream-input-once")
      try RuntimeStorage.writeExclusive(Data("stream-source-one".utf8), to: streamSource)
      var digest = try RuntimeStorage.privateFileDigest(streamSource)
      try RuntimeStorage.writeExclusive(Data("rewrite\n".utf8), to: mutationControl)
      let rewriteCode = errorCode {
        try controller.stream(
          controller.command(["stream-version-test"]),
          input: RuntimeStreamInput(
            url: streamSource, size: digest.size, sha256: digest.sha256),
          discardOutput: true)
      }
      try RuntimeStorage.removePrivateFile(streamSource)
      try RuntimeStorage.writeExclusive(Data("stream-source-two".utf8), to: streamSource)
      digest = try RuntimeStorage.privateFileDigest(streamSource)
      try RuntimeStorage.writeExclusive(Data("replace\n".utf8), to: mutationControl)
      let replaceCode = errorCode {
        try controller.stream(
          controller.command(["--extract"]),
          input: RuntimeStreamInput(
            url: streamSource, size: digest.size, sha256: digest.sha256),
          discardOutput: true)
      }
      guard safeRecovery, exactRestoreRecovery, startingFailClosed, invalidStateFailClosed,
        mismatchedInstanceCode == "RUNTIME_TRANSFER_STATE_INVALID",
        rewriteCode == "RUNTIME_TRANSFER_SOURCE_INVALID",
        replaceCode == "RUNTIME_TRANSFER_SOURCE_INVALID",
        !RuntimeStorage.pathExists(URL(fileURLWithPath: log.path + ".restored-photos"))
      else {
        try runtimeFail("RUNTIME_TRANSFER_GATE_SELF_TEST_FAILED")
      }
      return RuntimeTransferRecoveryGateTestResult(
        status: "passed", blockedOperations: blocked,
        allowedOperations: allowed.map(\.0) + ["diagnose", "exact_pre_transfer_restore"],
        safeRecovery: safeRecovery, exactRestoreRecovery: exactRestoreRecovery,
        startingFailClosed: startingFailClosed,
        invalidStateFailClosed: invalidStateFailClosed)
    }
  }
#endif
