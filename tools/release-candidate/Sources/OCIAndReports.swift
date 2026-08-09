import Foundation

private func stringMap(_ value: Any, _ code: String) throws {
  guard let object = value as? [String: Any], object.count <= 128 else { try fail(code) }
  for (key, child) in object {
    guard matches(key, "[A-Za-z0-9][A-Za-z0-9._/-]{0,255}"),
      let text = child as? String, text.utf8.count <= 4096
    else { try fail(code) }
  }
}

private func ociPlatform(_ value: Any) throws -> [String: Any] {
  let object = try optionalDictionary(
    value,
    required: ["architecture", "os"],
    optional: ["os.features", "os.version", "variant"],
    "RC_OCI_INDEX_INVALID"
  )
  guard
    matches(
      try string(object, "architecture", "RC_OCI_INDEX_INVALID"), "[a-z0-9][a-z0-9._-]{0,31}"),
    matches(try string(object, "os", "RC_OCI_INDEX_INVALID"), "[a-z0-9][a-z0-9._-]{0,31}")
  else { try fail("RC_OCI_INDEX_INVALID") }
  return object
}

private func ociDescriptor(_ value: Any) throws -> [String: Any] {
  let object = try optionalDictionary(
    value,
    required: ["digest", "mediaType", "size"],
    optional: ["annotations", "artifactType", "data", "platform", "urls"],
    "RC_OCI_INDEX_INVALID"
  )
  let mediaType = try string(object, "mediaType", "RC_OCI_INDEX_INVALID")
  let size = try integer(object, "size", "RC_OCI_INDEX_INVALID")
  guard matches(try string(object, "digest", "RC_OCI_INDEX_INVALID"), digestPattern),
    mediaType.hasPrefix("application/vnd."), size > 0, Int64(size) <= maximumArtifactBytes
  else { try fail("RC_OCI_INDEX_INVALID") }
  if let platform = object["platform"] { _ = try ociPlatform(platform) }
  if let annotations = object["annotations"] { try stringMap(annotations, "RC_OCI_INDEX_INVALID") }
  if let urls = object["urls"] {
    guard let array = urls as? [Any], array.count <= 32,
      array.allSatisfy({ ($0 as? String)?.utf8.count ?? 4097 <= 2048 })
    else { try fail("RC_OCI_INDEX_INVALID") }
  }
  return object
}

func verifyOCIIndex(
  root: String,
  evidence: OCIEvidence,
  expectedPlatforms: [String: String?]
) throws {
  try evidence.index.verify(root: root, maximum: 8 * 1024 * 1024)
  let path = try packageFile(root, evidence.index.path)
  let bytes = try readRealFile(path, maximum: 8 * 1024 * 1024)
  guard "sha256:" + sha256Hex(bytes) == evidence.digest else {
    try fail("RC_OCI_INDEX_DIGEST_MISMATCH")
  }
  let value = try parseJSON(bytes)
  let index = try optionalDictionary(
    value,
    required: ["manifests", "schemaVersion"],
    optional: ["annotations", "artifactType", "mediaType", "subject"],
    "RC_OCI_INDEX_INVALID"
  )
  guard try integer(index, "schemaVersion", "RC_OCI_INDEX_INVALID") == 2,
    let rawManifests = index["manifests"] as? [Any],
    rawManifests.count >= 2, rawManifests.count <= 256
  else { try fail("RC_OCI_INDEX_INVALID") }
  if let annotations = index["annotations"] { try stringMap(annotations, "RC_OCI_INDEX_INVALID") }
  let manifests = try rawManifests.map(ociDescriptor)
  for (architecture, expectedDigest) in expectedPlatforms {
    let matching = try manifests.filter { descriptor in
      guard let raw = descriptor["platform"] else { return false }
      let platform = try ociPlatform(raw)
      return try string(platform, "os", "RC_OCI_INDEX_INVALID") == "linux"
        && string(platform, "architecture", "RC_OCI_INDEX_INVALID") == architecture
    }
    guard matching.count == 1 else { try fail("RC_OCI_PLATFORM_MISMATCH") }
    if let digest = expectedDigest {
      guard try string(matching[0], "digest", "RC_OCI_INDEX_INVALID") == digest else {
        try fail("RC_OCI_PLATFORM_MISMATCH")
      }
    }
  }
  #if !RUNTIME_TESTING
    try rejectPlaceholderStrings(value)
  #endif
}

private func rejectPlaceholderStrings(_ value: Any) throws {
  if let text = value as? String {
    let pattern =
      "(?i)(^|[^a-z])(ad[ -]?hoc|example|placeholder|software[ _-]?only|testing)($|[^a-z])"
    guard !matchesSubstring(text, pattern) else {
      try fail("RC_FORMAL_PLACEHOLDER_EVIDENCE_FORBIDDEN")
    }
  } else if let array = value as? [Any] {
    for child in array { try rejectPlaceholderStrings(child) }
  } else if let object = value as? [String: Any] {
    for child in object.values { try rejectPlaceholderStrings(child) }
  }
}

private func matchesSubstring(_ value: String, _ pattern: String) -> Bool {
  guard let expression = try? NSRegularExpression(pattern: pattern) else { return true }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return expression.firstMatch(in: value, range: range) != nil
}

func validateTransferReport(_ value: Any, release: ReleaseAuthority) throws {
  let object = try dictionary(
    value,
    keys: [
      "assurance", "cleanup", "completed_at", "database_sha256", "git_sha", "kind",
      "photos_sha256", "postgres_image_digest", "product_version", "roots", "schema_version",
      "server_image_digest", "status",
    ],
    "RC_TRANSFER_REPORT_INVALID"
  )
  #if RUNTIME_TESTING
    let assurance = "software_only"
  #else
    let assurance = "real_container"
  #endif
  guard try integer(object, "schema_version", "RC_TRANSFER_REPORT_INVALID") == 1,
    try string(object, "kind", "RC_TRANSFER_REPORT_INVALID") == "runtime_real_container_transfer",
    try string(object, "status", "RC_TRANSFER_REPORT_INVALID") == "passed",
    try string(object, "cleanup", "RC_TRANSFER_REPORT_INVALID") == "clean",
    try integer(object, "roots", "RC_TRANSFER_REPORT_INVALID") == 2,
    try string(object, "assurance", "RC_TRANSFER_REPORT_INVALID") == assurance,
    try string(object, "git_sha", "RC_TRANSFER_REPORT_INVALID") == release.gitSHA,
    try string(object, "product_version", "RC_TRANSFER_REPORT_INVALID") == release.productVersion,
    try string(object, "server_image_digest", "RC_TRANSFER_REPORT_INVALID")
      == release.server.digest,
    try string(object, "postgres_image_digest", "RC_TRANSFER_REPORT_INVALID")
      == release.postgres.digest,
    matches(try string(object, "completed_at", "RC_TRANSFER_REPORT_INVALID"), isoPattern),
    matches(try string(object, "database_sha256", "RC_TRANSFER_REPORT_INVALID"), shaPattern),
    matches(try string(object, "photos_sha256", "RC_TRANSFER_REPORT_INVALID"), shaPattern)
  else { try fail("RC_TRANSFER_REPORT_INVALID") }
}

private func validatePassedChecks(_ value: Any) throws {
  let keys: Set<String> = [
    "counter_codesign", "counter_gatekeeper", "counter_stapler", "runtime_codesign",
    "runtime_gatekeeper", "runtime_stapler", "verifier_codesign", "verifier_gatekeeper",
    "verifier_stapler",
  ]
  let object = try dictionary(value, keys: keys, "RC_CLEAN_MAC_REPORT_INVALID")
  for key in keys where try !boolean(object, key, "RC_CLEAN_MAC_REPORT_INVALID") {
    try fail("RC_CLEAN_MAC_REPORT_INVALID")
  }
}

func validateCleanMacReport(_ value: Any, release: ReleaseAuthority) throws {
  let object = try dictionary(
    value,
    keys: [
      "assurance", "checks", "counter_app_tree_sha256", "git_sha", "kind",
      "machine_fingerprint_sha256", "no_repository", "node_or_pnpm_invoked", "os_version",
      "product_version", "runtime_app_tree_sha256", "schema_version", "status",
      "team_identifier", "verified_at", "verifier_app_tree_sha256",
    ],
    "RC_CLEAN_MAC_REPORT_INVALID"
  )
  try validatePassedChecks(object["checks"] as Any)
  #if RUNTIME_TESTING
    let assurance = "software_only"
    let team = "software_only"
  #else
    let assurance = "clean_physical_mac"
    let team = release.counter.teamIdentifier
  #endif
  guard try integer(object, "schema_version", "RC_CLEAN_MAC_REPORT_INVALID") == 1,
    try string(object, "kind", "RC_CLEAN_MAC_REPORT_INVALID") == "clean_second_mac",
    try string(object, "status", "RC_CLEAN_MAC_REPORT_INVALID") == "passed",
    try string(object, "assurance", "RC_CLEAN_MAC_REPORT_INVALID") == assurance,
    try string(object, "team_identifier", "RC_CLEAN_MAC_REPORT_INVALID") == team,
    try string(object, "git_sha", "RC_CLEAN_MAC_REPORT_INVALID") == release.gitSHA,
    try string(object, "product_version", "RC_CLEAN_MAC_REPORT_INVALID") == release.productVersion,
    try string(object, "counter_app_tree_sha256", "RC_CLEAN_MAC_REPORT_INVALID")
      == release.counter.app.treeSHA256,
    try string(object, "runtime_app_tree_sha256", "RC_CLEAN_MAC_REPORT_INVALID")
      == release.runtime.app.treeSHA256,
    try string(object, "verifier_app_tree_sha256", "RC_CLEAN_MAC_REPORT_INVALID")
      == release.verifier.app.treeSHA256,
    matches(
      try string(object, "machine_fingerprint_sha256", "RC_CLEAN_MAC_REPORT_INVALID"), shaPattern),
    matches(try string(object, "verified_at", "RC_CLEAN_MAC_REPORT_INVALID"), isoPattern),
    try boolean(object, "no_repository", "RC_CLEAN_MAC_REPORT_INVALID"),
    try !boolean(object, "node_or_pnpm_invoked", "RC_CLEAN_MAC_REPORT_INVALID")
  else { try fail("RC_CLEAN_MAC_REPORT_INVALID") }
  let osVersion = try string(object, "os_version", "RC_CLEAN_MAC_REPORT_INVALID")
  guard matches(osVersion, "[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}") else {
    try fail("RC_CLEAN_MAC_REPORT_INVALID")
  }
}

func validateXP58Report(_ value: Any, release: ReleaseAuthority) throws {
  let object = try dictionary(
    value,
    keys: [
      "accepted_at", "app_version", "cups_job_fingerprint", "job_fingerprint",
      "operator_confirmation", "platform", "printer_family", "queue_fingerprint", "receipt_seq",
      "schema_version", "snapshot_sha256",
    ],
    "RC_XP58_REPORT_INVALID"
  )
  let confirmationKeys: Set<String> = [
    "amounts_correct", "barcode_scanned", "chinese_clear", "cut_or_tear_ok",
    "disconnect_no_duplicate", "explicit_reprint_one_copy", "feed_ok",
  ]
  let confirmation = try dictionary(
    object["operator_confirmation"] as Any,
    keys: confirmationKeys,
    "RC_XP58_REPORT_INVALID"
  )
  for key in confirmationKeys where try !boolean(confirmation, key, "RC_XP58_REPORT_INVALID") {
    try fail("RC_XP58_REPORT_INVALID")
  }
  guard try integer(object, "schema_version", "RC_XP58_REPORT_INVALID") == 2,
    try string(object, "platform", "RC_XP58_REPORT_INVALID") == "darwin",
    try string(object, "printer_family", "RC_XP58_REPORT_INVALID") == "xp58",
    try string(object, "app_version", "RC_XP58_REPORT_INVALID") == release.productVersion,
    matches(try string(object, "accepted_at", "RC_XP58_REPORT_INVALID"), isoPattern),
    try integer(object, "receipt_seq", "RC_XP58_REPORT_INVALID") > 0
  else { try fail("RC_XP58_REPORT_INVALID") }
  for name in ["cups_job_fingerprint", "job_fingerprint", "queue_fingerprint", "snapshot_sha256"] {
    guard matches(try string(object, name, "RC_XP58_REPORT_INVALID"), shaPattern) else {
      try fail("RC_XP58_REPORT_INVALID")
    }
  }
}

func validateFormalStrings(_ values: [Any]) throws {
  #if !RUNTIME_TESTING
    for value in values { try rejectPlaceholderStrings(value) }
  #endif
}
