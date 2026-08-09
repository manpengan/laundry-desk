import Foundation

struct FileEvidence {
  let path: String
  let sha256: String
  let sizeBytes: Int

  init(_ value: Any) throws {
    let object = try dictionary(
      value, keys: ["path", "sha256", "size_bytes"], "RC_FILE_DESCRIPTOR_INVALID")
    path = try string(object, "path", "RC_FILE_DESCRIPTOR_INVALID")
    sha256 = try string(object, "sha256", "RC_FILE_DESCRIPTOR_INVALID")
    sizeBytes = try integer(object, "size_bytes", "RC_FILE_DESCRIPTOR_INVALID")
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.hasPrefix("/"),
      !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
      matches(sha256, shaPattern), sizeBytes > 0, Int64(sizeBytes) <= maximumArtifactBytes
    else { try fail("RC_FILE_DESCRIPTOR_INVALID") }
  }

  func verify(root: String, maximum: Int64 = maximumArtifactBytes) throws {
    let actual = try hashRealFile(packageFile(root, path), maximum: maximum)
    guard actual.0 == sizeBytes, actual.1 == sha256 else {
      try fail("RC_ARTIFACT_MISMATCH")
    }
  }
}

struct AppEvidence {
  let entryCount: Int
  let name: String
  let path: String
  let rootMode: Int
  let sizeBytes: Int
  let treeSHA256: String

  init(_ value: Any) throws {
    let object = try dictionary(
      value,
      keys: ["entry_count", "name", "path", "root_mode", "size_bytes", "tree_sha256"],
      "RC_APP_DESCRIPTOR_INVALID"
    )
    entryCount = try integer(object, "entry_count", "RC_APP_DESCRIPTOR_INVALID")
    name = try string(object, "name", "RC_APP_DESCRIPTOR_INVALID")
    path = try string(object, "path", "RC_APP_DESCRIPTOR_INVALID")
    rootMode = try integer(object, "root_mode", "RC_APP_DESCRIPTOR_INVALID")
    sizeBytes = try integer(object, "size_bytes", "RC_APP_DESCRIPTOR_INVALID")
    treeSHA256 = try string(object, "tree_sha256", "RC_APP_DESCRIPTOR_INVALID")
    guard name.hasSuffix(".app"), path.hasSuffix("/" + name), !path.hasPrefix("/"),
      entryCount > 0, rootMode >= 0, rootMode <= 0o7777, sizeBytes > 0,
      Int64(sizeBytes) <= maximumArtifactBytes, matches(treeSHA256, shaPattern)
    else { try fail("RC_APP_DESCRIPTOR_INVALID") }
  }

  func verify(root: String) throws {
    let tree = try describeApp(packageFile(root, path))
    guard tree.entryCount == entryCount, tree.name == name, tree.rootMode == rootMode,
      tree.sizeBytes == sizeBytes, tree.treeSHA256 == treeSHA256
    else { try fail("RC_APP_TREE_MISMATCH") }
  }
}

struct ProductEvidence {
  let app: AppEvidence
  let bundleIdentifier: String
  let dmg: FileEvidence
  let keyDigest: String
  let manifest: FileEvidence
  let teamIdentifier: String
  let version: String
  let zip: FileEvidence

  init(_ value: Any, kind: String) throws {
    let keyName = kind == "counter" ? "public_key_spki_sha256" : "public_key_raw_sha256"
    let object = try dictionary(
      value,
      keys: [
        "app", "bundle_identifier", "dmg", keyName, "manifest", "team_identifier", "version", "zip",
      ],
      "RC_PRODUCT_DESCRIPTOR_INVALID"
    )
    app = try AppEvidence(object["app"] as Any)
    bundleIdentifier = try string(object, "bundle_identifier", "RC_PRODUCT_DESCRIPTOR_INVALID")
    dmg = try FileEvidence(object["dmg"] as Any)
    keyDigest = try string(object, keyName, "RC_PRODUCT_DESCRIPTOR_INVALID")
    manifest = try FileEvidence(object["manifest"] as Any)
    teamIdentifier = try string(object, "team_identifier", "RC_PRODUCT_DESCRIPTOR_INVALID")
    version = try string(object, "version", "RC_PRODUCT_DESCRIPTOR_INVALID")
    zip = try FileEvidence(object["zip"] as Any)
    let expected = kind == "counter" ? "com.laundry-desk.v2" : "com.laundry-desk.runtime"
    guard bundleIdentifier == expected, matches(keyDigest, shaPattern),
      matches(version, semverPattern),
      teamIdentifier == "software_only" || matches(teamIdentifier, teamPattern)
    else { try fail("RC_PRODUCT_DESCRIPTOR_INVALID") }
  }

  func verify(root: String) throws {
    try app.verify(root: root)
    try dmg.verify(root: root)
    try zip.verify(root: root)
    try manifest.verify(root: root, maximum: maximumJSONBytes)
  }
}

struct OCIEvidence {
  let digest: String
  let index: FileEvidence

  init(_ value: Any) throws {
    let object = try dictionary(value, keys: ["digest", "index"], "RC_OCI_DESCRIPTOR_INVALID")
    digest = try string(object, "digest", "RC_OCI_DESCRIPTOR_INVALID")
    index = try FileEvidence(object["index"] as Any)
    guard matches(digest, digestPattern), index.sha256 == String(digest.dropFirst(7)) else {
      try fail("RC_OCI_DESCRIPTOR_INVALID")
    }
  }
}

struct VerifierEvidence {
  let app: AppEvidence
  let bundleIdentifier: String
  let teamIdentifier: String
  let version: String

  init(_ value: Any) throws {
    let object = try dictionary(
      value,
      keys: ["app", "bundle_identifier", "team_identifier", "version"],
      "RC_VERIFIER_DESCRIPTOR_INVALID"
    )
    app = try AppEvidence(object["app"] as Any)
    bundleIdentifier = try string(object, "bundle_identifier", "RC_VERIFIER_DESCRIPTOR_INVALID")
    teamIdentifier = try string(object, "team_identifier", "RC_VERIFIER_DESCRIPTOR_INVALID")
    version = try string(object, "version", "RC_VERIFIER_DESCRIPTOR_INVALID")
    guard bundleIdentifier == "com.laundry-desk.release-candidate-verifier",
      teamIdentifier == "software_only" || matches(teamIdentifier, teamPattern),
      matches(version, semverPattern)
    else { try fail("RC_VERIFIER_DESCRIPTOR_INVALID") }
  }
}

struct ReleaseAuthority {
  let raw: [String: Any]
  let assurance: String
  let counter: ProductEvidence
  let gitSHA: String
  let postgres: OCIEvidence
  let productVersion: String
  let runtime: ProductEvidence
  let server: OCIEvidence
  let transfer: FileEvidence
  let verifier: VerifierEvidence

  init(_ value: Any) throws {
    raw = try dictionary(
      value,
      keys: [
        "assurance", "counter", "git", "oci", "product_version",
        "real_container_transfer", "runtime", "schema_version", "verifier",
      ],
      "RC_RELEASE_AUTHORITY_INVALID"
    )
    guard try integer(raw, "schema_version", "RC_RELEASE_AUTHORITY_INVALID") == 1 else {
      try fail("RC_RELEASE_AUTHORITY_INVALID")
    }
    assurance = try string(raw, "assurance", "RC_RELEASE_AUTHORITY_INVALID")
    productVersion = try string(raw, "product_version", "RC_RELEASE_AUTHORITY_INVALID")
    let git = try dictionary(
      raw["git"] as Any, keys: ["clean", "sha"], "RC_RELEASE_AUTHORITY_INVALID")
    gitSHA = try string(git, "sha", "RC_RELEASE_AUTHORITY_INVALID")
    guard try boolean(git, "clean", "RC_RELEASE_AUTHORITY_INVALID"),
      ["formal", "software_only"].contains(assurance), matches(gitSHA, gitPattern),
      matches(productVersion, semverPattern)
    else { try fail("RC_RELEASE_AUTHORITY_INVALID") }
    counter = try ProductEvidence(raw["counter"] as Any, kind: "counter")
    runtime = try ProductEvidence(raw["runtime"] as Any, kind: "runtime")
    let oci = try dictionary(
      raw["oci"] as Any, keys: ["postgres", "server"], "RC_RELEASE_AUTHORITY_INVALID")
    postgres = try OCIEvidence(oci["postgres"] as Any)
    server = try OCIEvidence(oci["server"] as Any)
    transfer = try FileEvidence(raw["real_container_transfer"] as Any)
    verifier = try VerifierEvidence(raw["verifier"] as Any)
    guard counter.version == productVersion, runtime.version == productVersion,
      verifier.version == productVersion
    else { try fail("RC_PRODUCT_VERSION_MISMATCH") }
  }
}

struct FieldAuthority {
  let raw: [String: Any]
  let assurance: String
  let cleanMac: FileEvidence
  let gitSHA: String
  let productVersion: String
  let releaseAuthoritySHA256: String
  let xp58: FileEvidence

  init(_ value: Any) throws {
    raw = try dictionary(
      value,
      keys: [
        "assurance", "clean_second_mac", "git_sha", "product_version",
        "release_authority_sha256", "schema_version", "xp58",
      ],
      "RC_FIELD_AUTHORITY_INVALID"
    )
    assurance = try string(raw, "assurance", "RC_FIELD_AUTHORITY_INVALID")
    cleanMac = try FileEvidence(raw["clean_second_mac"] as Any)
    gitSHA = try string(raw, "git_sha", "RC_FIELD_AUTHORITY_INVALID")
    productVersion = try string(raw, "product_version", "RC_FIELD_AUTHORITY_INVALID")
    releaseAuthoritySHA256 = try string(
      raw, "release_authority_sha256", "RC_FIELD_AUTHORITY_INVALID")
    xp58 = try FileEvidence(raw["xp58"] as Any)
    guard try integer(raw, "schema_version", "RC_FIELD_AUTHORITY_INVALID") == 1,
      ["formal", "software_only"].contains(assurance), matches(gitSHA, gitPattern),
      matches(productVersion, semverPattern), matches(releaseAuthoritySHA256, shaPattern)
    else { try fail("RC_FIELD_AUTHORITY_INVALID") }
  }
}

struct EvidenceEnvelope {
  let authority: [String: Any]
  let counterSignature: String
  let runtimeSignature: String

  init(_ value: Any) throws {
    let object = try dictionary(
      value,
      keys: ["authority", "counter_signature", "runtime_signature", "schema_version"],
      "RC_EVIDENCE_ENVELOPE_INVALID"
    )
    guard try integer(object, "schema_version", "RC_EVIDENCE_ENVELOPE_INVALID") == 1,
      let rawAuthority = object["authority"] as? [String: Any]
    else { try fail("RC_EVIDENCE_ENVELOPE_INVALID") }
    authority = rawAuthority
    counterSignature = try string(object, "counter_signature", "RC_EVIDENCE_ENVELOPE_INVALID")
    runtimeSignature = try string(object, "runtime_signature", "RC_EVIDENCE_ENVELOPE_INVALID")
    guard matches(counterSignature, "[A-Za-z0-9_-]{86}"),
      matches(runtimeSignature, "[A-Za-z0-9_-]{86}")
    else { try fail("RC_EVIDENCE_ENVELOPE_INVALID") }
  }
}

func validateAssurance(_ release: ReleaseAuthority, _ field: FieldAuthority) throws {
  #if RUNTIME_TESTING
    let expected = "software_only"
  #else
    let expected = "formal"
  #endif
  guard release.assurance == expected, field.assurance == expected else {
    try fail("RC_ASSURANCE_MISMATCH")
  }
  if expected == "formal" {
    guard release.counter.teamIdentifier == release.runtime.teamIdentifier,
      release.counter.teamIdentifier == release.verifier.teamIdentifier
    else { try fail("RC_TEAM_IDENTIFIER_MISMATCH") }
  } else {
    guard release.counter.teamIdentifier == expected,
      release.runtime.teamIdentifier == expected,
      release.verifier.teamIdentifier == expected
    else { try fail("RC_ASSURANCE_MISMATCH") }
  }
}
