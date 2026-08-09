#if RUNTIME_TESTING
  import Foundation

  private var runtimeCommissionCleanupCounts: [String: Int] = [:]

  func failRuntimeAtomicWriteIfRequested(_ url: URL) throws {
    guard
      ProcessInfo.processInfo.environment["LAUNDRY_RUNTIME_TEST_FAIL_ATOMIC_WRITE"]
        == "lan/state.json",
      url.path.hasSuffix("/lan/state.json")
    else { return }
    try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
  }

  func failRuntimeCommissionCleanupIfRequested(_ phase: String) throws {
    guard
      let control =
        ProcessInfo.processInfo.environment["LAUNDRY_RUNTIME_TEST_FAIL_COMMISSION_SECRET_CLEANUP"]
    else { return }
    let parts = control.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 1 || parts.count == 2, parts[0] == phase else { return }
    let occurrence = parts.count == 1 ? 1 : (Int(parts[1]) ?? 0)
    guard (1...16).contains(occurrence) else { return }
    let count = (runtimeCommissionCleanupCounts[phase] ?? 0) + 1
    runtimeCommissionCleanupCounts[phase] = count
    guard count == occurrence else { return }
    try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
  }
#endif
