import Foundation

private let releaseDomain = "laundry-desk/release-candidate/release/v1\n"
private let fieldDomain = "laundry-desk/release-candidate/field/v1\n"

private func exactDirectory(_ path: String, names: Set<String>, _ code: String) throws {
  let actual: Set<String>
  do {
    actual = Set(try FileManager.default.contentsOfDirectory(atPath: path))
  } catch {
    try fail(code)
  }
  guard actual == names else { try fail(code) }
}

private func validatePackageShape(_ root: String, release: ReleaseAuthority) throws {
  try exactDirectory(
    root,
    names: ["artifacts", "evidence", "field-evidence.json", "release-evidence.json", "verifier"],
    "RC_PACKAGE_SHAPE_INVALID"
  )
  try exactDirectory(
    root + "/artifacts", names: ["counter", "runtime"], "RC_PACKAGE_SHAPE_INVALID")
  try exactDirectory(
    root + "/artifacts/counter",
    names: [
      (release.counter.app.path as NSString).lastPathComponent,
      (release.counter.dmg.path as NSString).lastPathComponent,
      (release.counter.zip.path as NSString).lastPathComponent,
    ],
    "RC_PACKAGE_SHAPE_INVALID"
  )
  try exactDirectory(
    root + "/artifacts/runtime",
    names: [
      (release.runtime.app.path as NSString).lastPathComponent,
      (release.runtime.dmg.path as NSString).lastPathComponent,
      (release.runtime.zip.path as NSString).lastPathComponent,
    ],
    "RC_PACKAGE_SHAPE_INVALID"
  )
  try exactDirectory(
    root + "/evidence",
    names: [
      "clean-second-mac.json", "counter-update-manifest.json", "postgres-oci-index.json",
      "real-container-transfer.json", "runtime-manifest.json", "server-oci-index.json", "xp58.json",
    ],
    "RC_PACKAGE_SHAPE_INVALID"
  )
  try exactDirectory(
    root + "/verifier",
    names: [(release.verifier.app.path as NSString).lastPathComponent],
    "RC_PACKAGE_SHAPE_INVALID"
  )
}

private func readEnvelope(_ root: String, _ name: String) throws -> EvidenceEnvelope {
  let path = try packageFile(root, name)
  let data = try readRealFile(path, maximum: maximumJSONBytes)
  return try EvidenceEnvelope(parseJSON(data, canonical: true))
}

private func readReport(_ root: String, _ evidence: FileEvidence) throws -> Any {
  try evidence.verify(root: root, maximum: maximumJSONBytes)
  return try parseJSON(readRealFile(packageFile(root, evidence.path), maximum: maximumJSONBytes))
}

func verifyCandidate(at rawRoot: String) throws -> [String: Any] {
  let root = try canonicalPath(rawRoot, "RC_PACKAGE_ROOT_INVALID")
  let releaseEnvelope = try readEnvelope(root, "release-evidence.json")
  let release = try ReleaseAuthority(releaseEnvelope.authority)
  let fieldEnvelope = try readEnvelope(root, "field-evidence.json")
  let field = try FieldAuthority(fieldEnvelope.authority)
  try validateAssurance(release, field)
  guard field.assurance == release.assurance, field.gitSHA == release.gitSHA,
    field.productVersion == release.productVersion,
    field.releaseAuthoritySHA256 == sha256Hex(Data(try canonicalJSON(release.raw).utf8))
  else { try fail("RC_FIELD_RELEASE_BINDING_INVALID") }
  try validatePackageShape(root, release: release)
  let keys = try loadCandidateKeys(root: root, release: release)
  guard keys.counterSPKISHA256 == release.counter.keyDigest,
    keys.runtimeRawSHA256 == release.runtime.keyDigest
  else { try fail("RC_PUBLIC_KEY_DIGEST_MISMATCH") }
  try verifyEnvelope(releaseEnvelope, domain: releaseDomain, keys: keys)
  try verifyEnvelope(fieldEnvelope, domain: fieldDomain, keys: keys)
  try validateFormalStrings([release.raw, field.raw])
  try verifyPlatform(root: root, release: release)

  try release.counter.verify(root: root)
  try release.runtime.verify(root: root)
  try release.verifier.app.verify(root: root)
  try verifyCounterManifest(root: root, release: release, key: keys.counter)
  let runtime = try verifyRuntimeManifest(root: root, release: release, key: keys.runtime)
  try verifyOCIIndex(
    root: root,
    evidence: release.server,
    expectedPlatforms: ["amd64": runtime.serverAMD64, "arm64": runtime.serverARM64]
  )
  try verifyOCIIndex(
    root: root,
    evidence: release.postgres,
    expectedPlatforms: ["amd64": nil, "arm64": nil]
  )
  try release.transfer.verify(root: root, maximum: maximumJSONBytes)
  let transfer = try readReport(root, release.transfer)
  let cleanMac = try readReport(root, field.cleanMac)
  let xp58 = try readReport(root, field.xp58)
  try validateTransferReport(transfer, release: release)
  try validateCleanMacReport(cleanMac, release: release)
  try validateXP58Report(xp58, release: release)
  try validateFormalStrings([transfer, cleanMac, xp58])
  return [
    "assurance": release.assurance,
    "git_sha": release.gitSHA,
    "ok": true,
    "product_version": release.productVersion,
    "release_authority_sha256": field.releaseAuthoritySHA256,
  ]
}
