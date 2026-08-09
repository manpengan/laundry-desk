import Darwin
import Foundation

extension RuntimeStorage {
  static func removeBootstrapSecrets(_ root: URL) throws {
    #if RUNTIME_TESTING
      try failRuntimeCommissionCleanupIfRequested("unlink")
    #endif
    for name in bootstrapSecrets {
      let path = root.appendingPathComponent(name).path
      if Darwin.unlink(path) != 0 && errno != ENOENT {
        try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
      }
    }
    #if RUNTIME_TESTING
      try failRuntimeCommissionCleanupIfRequested("fsync")
    #endif
    try fsyncDirectory(root)
  }

  static func buildCommissionSecrets(_ setup: RuntimeCommissionSetup) -> [String: String] {
    [
      "bootstrap-approver-username": setup.approverUsername,
      "bootstrap-approver-display-name": setup.approverDisplayName,
      "bootstrap-approver-password": setup.approverPassword,
      "bootstrap-approver-pin": setup.approverPin,
    ]
  }
}
