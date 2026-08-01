import CryptoKit
import Foundation

enum RuntimeManifestVerifier {
  private static let checksum = "^[0-9a-f]{64}$"
  private static let digest = "^sha256:[0-9a-f]{64}$"
  private static let digestReference =
    "^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)+[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$"
  private static let migration = "^[0-9]{4}_[a-z0-9_]+\\.sql$"
  private static let semver =
    "^(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,64})?$"

  private static let payloadKeys: Set<String> = [
    "schema_version", "product", "release", "contracts_major", "contracts_sha256",
    "server_version", "web_bundle_sha256", "minimum_app_version",
    "database_schema_sha256", "migrations_sha256", "migration_head",
    "maximum_compatible_schema", "rollback_target", "compose_sha256", "server_image",
    "postgres_major", "postgres_image",
  ]

  private static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }

  private static func exactKeys(_ value: Any, _ expected: Set<String>) -> Bool {
    guard let dictionary = value as? [String: Any] else { return false }
    return Set(dictionary.keys) == expected
  }

  private static func base64URL(_ value: String) -> Data? {
    var standard = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
    return Data(base64Encoded: standard)
  }

  private static func versionParts(_ value: String) throws -> [Int] {
    guard matches(value, semver) else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    let parts = value.split(whereSeparator: { $0 == "." || $0 == "-" }).prefix(3)
    let parsed = parts.compactMap { Int($0) }
    guard parsed.count == 3 else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    return parsed
  }

  static func compareVersions(_ left: String, _ right: String) throws -> Int {
    let lhs = try versionParts(left)
    let rhs = try versionParts(right)
    for index in 0..<3 {
      let difference = lhs[index] - rhs[index]
      if difference != 0 { return difference < 0 ? -1 : 1 }
    }
    return 0
  }

  private static func migrationNumber(_ value: String) -> Int {
    Int(value.prefix(4)) ?? -1
  }

  private static func validateStructure(_ root: [String: Any], payload: RuntimeManifestPayload)
    throws
  {
    guard Set(root.keys) == ["payload", "signature"],
      let rawPayload = root["payload"], exactKeys(rawPayload, payloadKeys),
      let server = (rawPayload as? [String: Any])?["server_image"],
      exactKeys(server, ["index", "linux_arm64", "linux_amd64"]),
      payload.schemaVersion == 1, payload.product == "laundry-desk-runtime",
      payload.contractsMajor > 0, payload.postgresMajor == 16,
      matches(payload.release, semver), payload.serverVersion == payload.release,
      matches(payload.minimumAppVersion, semver),
      matches(payload.contractsSHA256, checksum),
      matches(payload.webBundleSHA256, checksum),
      matches(payload.databaseSchemaSHA256, checksum),
      matches(payload.migrationsSHA256, checksum), matches(payload.composeSHA256, checksum),
      matches(payload.migrationHead, migration),
      matches(payload.maximumCompatibleSchema, migration),
      migrationNumber(payload.maximumCompatibleSchema) >= migrationNumber(payload.migrationHead),
      matches(payload.serverImage.index, digestReference),
      matches(payload.serverImage.linuxArm64, digest),
      matches(payload.serverImage.linuxAmd64, digest),
      matches(payload.postgresImage, digestReference)
    else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }

    if let rollback = payload.rollbackTarget {
      guard let rawRollback = (rawPayload as? [String: Any])?["rollback_target"],
        exactKeys(rawRollback, ["release", "server_image_index", "maximum_compatible_schema"]),
        try compareVersions(rollback.release, payload.release) < 0,
        matches(rollback.serverImageIndex, digestReference),
        matches(rollback.maximumCompatibleSchema, migration),
        migrationNumber(rollback.maximumCompatibleSchema) >= migrationNumber(payload.migrationHead)
      else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }
    }
  }

  static func verify(
    data: Data, trustedKeyText: String, appVersion: String,
    contractsMajor: Int
  ) throws -> RuntimeManifestPayload {
    guard data.count <= 65_536,
      let object = try? JSONSerialization.jsonObject(with: data),
      let root = object as? [String: Any],
      let rawPayload = root["payload"],
      let signatureText = root["signature"] as? String,
      signatureText.range(of: "^[A-Za-z0-9_-]{86}$", options: .regularExpression) != nil,
      let signature = base64URL(signatureText), signature.count == 64,
      trustedKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        .range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
      let keyData = base64URL(trustedKeyText.trimmingCharacters(in: .whitespacesAndNewlines)),
      keyData.count == 32,
      let envelope = try? JSONDecoder().decode(RuntimeManifestEnvelope.self, from: data)
    else { try runtimeFail("RUNTIME_MANIFEST_INVALID") }

    try validateStructure(root, payload: envelope.payload)
    let canonical = try JSONSerialization.data(
      withJSONObject: rawPayload,
      options: [.sortedKeys, .withoutEscapingSlashes])
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: keyData)
    guard key.isValidSignature(signature, for: canonical) else {
      try runtimeFail("RUNTIME_MANIFEST_SIGNATURE_INVALID")
    }
    guard try compareVersions(appVersion, envelope.payload.minimumAppVersion) >= 0,
      contractsMajor == envelope.payload.contractsMajor
    else { try runtimeFail("RUNTIME_MANIFEST_INCOMPATIBLE") }
    return envelope.payload
  }

  static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
