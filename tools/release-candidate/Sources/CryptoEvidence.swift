import CryptoKit
import Foundation

private let spkiPrefix = Data([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

private func base64URL(_ value: String) throws -> Data {
  guard matches(value, "[A-Za-z0-9_-]+") else { try fail("RC_SIGNATURE_INVALID") }
  var standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
    of: "_", with: "/")
  standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
  guard let data = Data(base64Encoded: standard) else { try fail("RC_SIGNATURE_INVALID") }
  return data
}

private func publicKey(_ raw: Data) throws -> Curve25519.Signing.PublicKey {
  guard raw.count == 32 else { try fail("RC_PUBLIC_KEY_INVALID") }
  do {
    return try Curve25519.Signing.PublicKey(rawRepresentation: raw)
  } catch {
    try fail("RC_PUBLIC_KEY_INVALID")
  }
}

struct CandidateKeys {
  let counter: Curve25519.Signing.PublicKey
  let runtime: Curve25519.Signing.PublicKey
  let counterSPKISHA256: String
  let runtimeRawSHA256: String
}

func loadCandidateKeys(root: String, release: ReleaseAuthority) throws -> CandidateKeys {
  let counterApp = try packageFile(root, release.counter.app.path)
  let runtimeApp = try packageFile(root, release.runtime.app.path)
  let counterPath = counterApp + "/Contents/Resources/update/update-public-key.pem"
  let runtimePath = runtimeApp + "/Contents/Resources/trusted-manifest-public-key.txt"
  let counterBytes = try readRealFile(counterPath, maximum: 16 * 1024)
  guard let counterText = String(data: counterBytes, encoding: .utf8) else {
    try fail("RC_COUNTER_PUBLIC_KEY_INVALID")
  }
  let lines = counterText.split(whereSeparator: \.isNewline).map(String.init)
  guard lines.count >= 3, lines.first == "-----BEGIN PUBLIC KEY-----",
    lines.last == "-----END PUBLIC KEY-----",
    let der = Data(base64Encoded: lines.dropFirst().dropLast().joined()),
    der.count == spkiPrefix.count + 32, der.prefix(spkiPrefix.count) == spkiPrefix
  else { try fail("RC_COUNTER_PUBLIC_KEY_INVALID") }
  let runtimeBytes = try readRealFile(runtimePath, maximum: 16 * 1024)
  guard
    let runtimeText = String(data: runtimeBytes, encoding: .utf8)?.trimmingCharacters(
      in: .whitespacesAndNewlines),
    matches(runtimeText, "[A-Za-z0-9_-]{43}")
  else { try fail("RC_RUNTIME_PUBLIC_KEY_INVALID") }
  let runtimeRaw = try base64URL(runtimeText)
  let counterRaw = Data(der.suffix(32))
  guard counterRaw != runtimeRaw else { try fail("RC_EVIDENCE_KEYS_NOT_DISTINCT") }
  return CandidateKeys(
    counter: try publicKey(counterRaw),
    runtime: try publicKey(runtimeRaw),
    counterSPKISHA256: sha256Hex(der),
    runtimeRawSHA256: sha256Hex(runtimeRaw)
  )
}

func verifyEnvelope(_ envelope: EvidenceEnvelope, domain: String, keys: CandidateKeys) throws {
  let bytes = Data((domain + (try canonicalJSON(envelope.authority)) + "\n").utf8)
  let counterSignature = try base64URL(envelope.counterSignature)
  let runtimeSignature = try base64URL(envelope.runtimeSignature)
  guard counterSignature.count == 64, runtimeSignature.count == 64,
    keys.counter.isValidSignature(counterSignature, for: bytes),
    keys.runtime.isValidSignature(runtimeSignature, for: bytes)
  else { try fail("RC_EVIDENCE_SIGNATURE_INVALID") }
}

struct RuntimeManifestSummary {
  let postgresDigest: String
  let serverAMD64: String
  let serverARM64: String
  let serverDigest: String
}

private func validateArtifact(_ value: Any) throws -> [String: Any] {
  let object = try dictionary(
    value,
    keys: ["kind", "name", "sha256", "size_bytes"],
    "RC_COUNTER_MANIFEST_INVALID"
  )
  let kind = try string(object, "kind", "RC_COUNTER_MANIFEST_INVALID")
  let name = try string(object, "name", "RC_COUNTER_MANIFEST_INVALID")
  guard ["dmg", "zip"].contains(kind), name.hasSuffix("." + kind),
    matches(try string(object, "sha256", "RC_COUNTER_MANIFEST_INVALID"), shaPattern),
    try integer(object, "size_bytes", "RC_COUNTER_MANIFEST_INVALID") > 0
  else { try fail("RC_COUNTER_MANIFEST_INVALID") }
  return object
}

func verifyCounterManifest(
  root: String, release: ReleaseAuthority, key: Curve25519.Signing.PublicKey
) throws {
  let path = try packageFile(root, release.counter.manifest.path)
  let value = try parseJSON(readRealFile(path, maximum: maximumJSONBytes))
  let manifest = try dictionary(
    value, keys: ["authority", "signature"], "RC_COUNTER_MANIFEST_INVALID")
  let authority = try dictionary(
    manifest["authority"] as Any,
    keys: [
      "artifacts", "channel", "contracts_major", "local_schema", "minimum_secure_version",
      "minimum_upgradable_version", "protocol_version", "published_at", "rollback", "version",
    ],
    "RC_COUNTER_MANIFEST_INVALID"
  )
  guard try integer(authority, "protocol_version", "RC_COUNTER_MANIFEST_INVALID") == 1,
    try string(authority, "version", "RC_COUNTER_MANIFEST_INVALID") == release.productVersion,
    matches(
      try string(authority, "minimum_secure_version", "RC_COUNTER_MANIFEST_INVALID"), semverPattern),
    matches(
      try string(authority, "minimum_upgradable_version", "RC_COUNTER_MANIFEST_INVALID"),
      semverPattern),
    try integer(authority, "contracts_major", "RC_COUNTER_MANIFEST_INVALID") >= 0,
    try integer(authority, "local_schema", "RC_COUNTER_MANIFEST_INVALID") >= 0,
    matches(try string(authority, "published_at", "RC_COUNTER_MANIFEST_INVALID"), isoPattern),
    let artifacts = authority["artifacts"] as? [Any], artifacts.count == 2
  else { try fail("RC_COUNTER_MANIFEST_INVALID") }
  #if RUNTIME_TESTING
    let channels = ["beta", "stable", "lts"]
  #else
    let channels = ["stable", "lts"]
  #endif
  guard channels.contains(try string(authority, "channel", "RC_COUNTER_MANIFEST_INVALID")) else {
    try fail("RC_COUNTER_MANIFEST_INVALID")
  }
  if !(authority["rollback"] is NSNull) {
    let rollback = try dictionary(
      authority["rollback"] as Any,
      keys: ["artifact_sha256", "max_compatible_local_schema", "target_version"],
      "RC_COUNTER_MANIFEST_INVALID"
    )
    guard
      matches(try string(rollback, "artifact_sha256", "RC_COUNTER_MANIFEST_INVALID"), shaPattern),
      matches(try string(rollback, "target_version", "RC_COUNTER_MANIFEST_INVALID"), semverPattern),
      try integer(rollback, "max_compatible_local_schema", "RC_COUNTER_MANIFEST_INVALID") >= 0
    else { try fail("RC_COUNTER_MANIFEST_INVALID") }
  }
  var seen: Set<String> = []
  for candidate in artifacts {
    let artifact = try validateArtifact(candidate)
    let kind = try string(artifact, "kind", "RC_COUNTER_MANIFEST_INVALID")
    guard !seen.contains(kind) else { try fail("RC_COUNTER_MANIFEST_INVALID") }
    seen.insert(kind)
    let expected = kind == "dmg" ? release.counter.dmg : release.counter.zip
    guard
      try string(artifact, "name", "RC_COUNTER_MANIFEST_INVALID")
        == (expected.path as NSString).lastPathComponent,
      try string(artifact, "sha256", "RC_COUNTER_MANIFEST_INVALID") == expected.sha256,
      try integer(artifact, "size_bytes", "RC_COUNTER_MANIFEST_INVALID") == expected.sizeBytes
    else { try fail("RC_COUNTER_ARTIFACT_MISMATCH") }
  }
  let signatureText = try string(manifest, "signature", "RC_COUNTER_MANIFEST_INVALID")
  guard matches(signatureText, "[A-Za-z0-9+/]{86}=="),
    let signature = Data(base64Encoded: signatureText), signature.count == 64
  else { try fail("RC_COUNTER_MANIFEST_INVALID") }
  let signed = Data(
    ("laundry-desk/update-manifest/v1\n" + (try canonicalJSON(authority)) + "\n").utf8)
  guard key.isValidSignature(signature, for: signed) else {
    try fail("RC_COUNTER_MANIFEST_SIGNATURE_INVALID")
  }
}

private func exactRuntimePayload(_ value: Any) throws -> [String: Any] {
  guard let probe = value as? [String: Any] else { try fail("RC_RUNTIME_MANIFEST_INVALID") }
  let base: Set<String> = [
    "compose_sha256", "contracts_major", "contracts_sha256", "database_schema_sha256",
    "maximum_compatible_schema", "migration_head", "migrations_sha256", "minimum_app_version",
    "postgres_image", "postgres_major", "product", "release", "rollback_target", "schema_version",
    "server_image", "server_version", "web_bundle_sha256",
  ]
  let version = try integer(probe, "schema_version", "RC_RUNTIME_MANIFEST_INVALID")
  let keys = version == 2 ? base.union(["lan_compose_sha256", "owner_spa_sha256"]) : base
  guard version == 1 || version == 2 else { try fail("RC_RUNTIME_MANIFEST_INVALID") }
  return try dictionary(value, keys: keys, "RC_RUNTIME_MANIFEST_INVALID")
}

func verifyRuntimeManifest(
  root: String, release: ReleaseAuthority, key: Curve25519.Signing.PublicKey
) throws -> RuntimeManifestSummary {
  let path = try packageFile(root, release.runtime.manifest.path)
  let value = try parseJSON(readRealFile(path, maximum: maximumJSONBytes))
  let manifest = try dictionary(
    value, keys: ["payload", "signature"], "RC_RUNTIME_MANIFEST_INVALID")
  let payload = try exactRuntimePayload(manifest["payload"] as Any)
  let image = try dictionary(
    payload["server_image"] as Any,
    keys: ["index", "linux_amd64", "linux_arm64"],
    "RC_RUNTIME_MANIFEST_INVALID"
  )
  let releaseVersion = try string(payload, "release", "RC_RUNTIME_MANIFEST_INVALID")
  let serverVersion = try string(payload, "server_version", "RC_RUNTIME_MANIFEST_INVALID")
  let serverReference = try string(image, "index", "RC_RUNTIME_MANIFEST_INVALID")
  let postgresReference = try string(payload, "postgres_image", "RC_RUNTIME_MANIFEST_INVALID")
  let serverDigest = serverReference.split(separator: "@").last.map(String.init)
  let postgresDigest = postgresReference.split(separator: "@").last.map(String.init)
  guard try string(payload, "product", "RC_RUNTIME_MANIFEST_INVALID") == "laundry-desk-runtime",
    releaseVersion == release.productVersion, serverVersion == releaseVersion,
    try integer(payload, "contracts_major", "RC_RUNTIME_MANIFEST_INVALID") > 0,
    try integer(payload, "postgres_major", "RC_RUNTIME_MANIFEST_INVALID") == 16,
    serverDigest == release.server.digest, postgresDigest == release.postgres.digest,
    matches(try string(image, "linux_amd64", "RC_RUNTIME_MANIFEST_INVALID"), digestPattern),
    matches(try string(image, "linux_arm64", "RC_RUNTIME_MANIFEST_INVALID"), digestPattern)
  else { try fail("RC_RUNTIME_MANIFEST_INVALID") }
  for name in [
    "compose_sha256", "contracts_sha256", "database_schema_sha256", "migrations_sha256",
    "web_bundle_sha256",
  ] {
    guard matches(try string(payload, name, "RC_RUNTIME_MANIFEST_INVALID"), shaPattern) else {
      try fail("RC_RUNTIME_MANIFEST_INVALID")
    }
  }
  if try integer(payload, "schema_version", "RC_RUNTIME_MANIFEST_INVALID") == 2 {
    for name in ["lan_compose_sha256", "owner_spa_sha256"] {
      guard matches(try string(payload, name, "RC_RUNTIME_MANIFEST_INVALID"), shaPattern) else {
        try fail("RC_RUNTIME_MANIFEST_INVALID")
      }
    }
  }
  let signature = try base64URL(string(manifest, "signature", "RC_RUNTIME_MANIFEST_INVALID"))
  guard signature.count == 64,
    key.isValidSignature(signature, for: Data((try canonicalJSON(payload)).utf8))
  else { try fail("RC_RUNTIME_MANIFEST_SIGNATURE_INVALID") }
  return RuntimeManifestSummary(
    postgresDigest: release.postgres.digest,
    serverAMD64: try string(image, "linux_amd64", "RC_RUNTIME_MANIFEST_INVALID"),
    serverARM64: try string(image, "linux_arm64", "RC_RUNTIME_MANIFEST_INVALID"),
    serverDigest: release.server.digest
  )
}
