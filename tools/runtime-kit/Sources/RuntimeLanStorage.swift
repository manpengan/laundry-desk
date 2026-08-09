import Darwin
import Foundation

extension RuntimePaths {
  var lanRoot: URL { root.appendingPathComponent("lan", isDirectory: true) }
  var lanGenerations: URL { lanRoot.appendingPathComponent("generations", isDirectory: true) }
  var lanState: URL { lanRoot.appendingPathComponent("state.json") }
  var lanUncertainState: URL { lanRoot.appendingPathComponent("state-commit-uncertain.json") }
  var lanPhysicalUncertainState: URL {
    lanRoot.appendingPathComponent("physical-state-uncertain.json")
  }
  var lanCompose: URL {
    compose.deletingLastPathComponent().appendingPathComponent(
      "docker-compose.runtime-lan.yml")
  }
  var supportRoot: URL { root.appendingPathComponent("support", isDirectory: true) }
  var supportBundle: URL { supportRoot.appendingPathComponent("runtime-support.json") }
}

struct RuntimeLanGeneration {
  let state: RuntimeLanState
  let profile: RuntimeLanProfile
  let root: URL
  let certificate: URL
  let privateKey: URL
  let config: URL
  let environment: URL
}

enum RuntimeLanStorage {
  private static let generationPattern = "^[A-Za-z0-9_-]{22,128}$"
  private static let stateKeys: Set<String> = [
    "version", "status", "generation", "profile_sha256",
  ]
  private static let profileKeys: Set<String> = [
    "version", "status", "generation", "bind_ipv4", "port", "certificate_sha256",
    "certificate_fingerprint_sha256", "valid_not_after", "ip_sans",
    "lan_compose_sha256", "owner_spa_sha256",
  ]

  private static func environmentData(
    generationRoot: URL, bindIPv4: String, port: Int
  ) throws -> Data {
    guard !generationRoot.path.contains("\n"), !generationRoot.path.contains("\r") else {
      try runtimeFail("RUNTIME_LAN_PROFILE_INVALID")
    }
    return Data(
      """
      LAUNDRY_RUNTIME_LAN_CONFIG_ROOT=\(generationRoot.path)
      LAUNDRY_RUNTIME_LAN_BIND_HOST=\(bindIPv4)
      LAUNDRY_RUNTIME_LAN_PORT=\(port)
      """.utf8)
  }

  static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }

  private static func exactObject(_ data: Data, keys: Set<String>) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return false }
    return Set(object.keys) == keys
  }

  private static func decodeState(_ data: Data) throws -> RuntimeLanState {
    guard exactObject(data, keys: stateKeys),
      let state = try? JSONDecoder().decode(RuntimeLanState.self, from: data),
      state.version == 1, ["configured", "enabled", "disabled"].contains(state.status),
      state.generation.range(of: generationPattern, options: .regularExpression) != nil,
      state.profileSHA256.range(
        of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
    return state
  }

  static func summary(_ generation: RuntimeLanGeneration, status: String? = nil)
    -> RuntimeLanSummary
  {
    RuntimeLanSummary(
      status: status ?? generation.state.status,
      generation: generation.profile.generation,
      bindIPv4: generation.profile.bindIPv4,
      port: generation.profile.port,
      certificateFingerprintSHA256: generation.profile.certificateFingerprintSHA256,
      validNotAfter: generation.profile.validNotAfter)
  }

  static func load(_ paths: RuntimePaths) throws -> RuntimeLanGeneration {
    guard RuntimeStorage.pathExists(paths.lanState) else {
      try runtimeFail("RUNTIME_LAN_PROFILE_MISSING")
    }
    try RuntimeStorage.validateDirectory(paths.lanRoot)
    try RuntimeStorage.validateDirectory(paths.lanGenerations)
    let stateData = try RuntimeStorage.readPrivate(paths.lanState, maximum: 4_096)
    let state = try decodeState(stateData)
    let root = paths.lanGenerations.appendingPathComponent(state.generation, isDirectory: true)
    try RuntimeStorage.validateDirectory(root)
    guard
      (try FileManager.default.contentsOfDirectory(atPath: root.path)).sorted() == [
        "certificate.pem", "compose.env", "config.json", "private-key.pem", "profile.json",
      ]
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
    let profileData = try RuntimeStorage.readPrivate(
      root.appendingPathComponent("profile.json"), maximum: 8_192)
    guard RuntimeManifestVerifier.sha256(profileData) == state.profileSHA256,
      exactObject(profileData, keys: profileKeys),
      let profile = try? JSONDecoder().decode(RuntimeLanProfile.self, from: profileData),
      profile.version == 1, profile.status == "configured",
      profile.generation == state.generation,
      profile.certificateSHA256.range(
        of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      profile.certificateFingerprintSHA256.range(
        of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      profile.lanComposeSHA256.range(
        of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      profile.ownerSPASHA256.range(
        of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
    let certificate = root.appendingPathComponent("certificate.pem")
    let privateKey = root.appendingPathComponent("private-key.pem")
    let config = root.appendingPathComponent("config.json")
    let environment = root.appendingPathComponent("compose.env")
    let certificateData = try RuntimeStorage.readPrivate(certificate, maximum: 16_384)
    guard RuntimeManifestVerifier.sha256(certificateData) == profile.certificateSHA256 else {
      try runtimeFail("RUNTIME_LAN_PROFILE_INVALID")
    }
    _ = try RuntimeStorage.readPrivate(privateKey, maximum: 16_384)
    let configData = try RuntimeStorage.readPrivate(config, maximum: 4_096)
    guard let configObject = try? JSONSerialization.jsonObject(with: configData) as? [String: Any],
      Set(configObject.keys) == [
        "schema_version", "public_host", "public_port", "owner_spa_sha256",
      ],
      configObject["schema_version"] as? Int == 1,
      configObject["public_host"] as? String == profile.bindIPv4,
      configObject["public_port"] as? Int == profile.port,
      configObject["owner_spa_sha256"] as? String == profile.ownerSPASHA256
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
    let environmentDataOnDisk = try RuntimeStorage.readPrivate(environment, maximum: 4_096)
    guard
      environmentDataOnDisk
        == (try environmentData(
          generationRoot: root, bindIPv4: profile.bindIPv4, port: profile.port))
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
    return RuntimeLanGeneration(
      state: state, profile: profile, root: root, certificate: certificate,
      privateKey: privateKey, config: config, environment: environment)
  }

  static func create(
    paths: RuntimePaths, setup: RuntimeLanSetup, certificate: RuntimeLanCertificateSummary,
    payload: RuntimeManifestPayload
  ) throws -> RuntimeLanGeneration {
    guard [1, 2].contains(payload.schemaVersion) else {
      try runtimeFail("RUNTIME_LAN_MANIFEST_V2_REQUIRED")
    }
    let lanComposeSHA256 = payload.lanComposeSHA256 ?? String(repeating: "0", count: 64)
    let ownerSPASHA256 = payload.ownerSPASHA256 ?? String(repeating: "0", count: 64)
    try RuntimeStorage.ensureDirectory(paths.lanRoot)
    try RuntimeStorage.ensureDirectory(paths.lanGenerations)
    let generation = try RuntimeStorage.randomToken(bytes: 18)
    let temporary = paths.lanGenerations.appendingPathComponent(".tmp-\(generation)")
    let destination = paths.lanGenerations.appendingPathComponent(generation)
    try RuntimeStorage.createExclusiveDirectory(temporary)
    var committed = false
    defer {
      if !committed { try? FileManager.default.removeItem(at: temporary) }
    }
    let profile = RuntimeLanProfile(
      version: 1, status: "configured", generation: generation,
      bindIPv4: setup.bindIPv4, port: setup.port,
      certificateSHA256: RuntimeManifestVerifier.sha256(Data(setup.certificatePEM.utf8)),
      certificateFingerprintSHA256: certificate.fingerprintSHA256,
      validNotAfter: certificate.validNotAfter, ipSANs: certificate.ipSANs,
      lanComposeSHA256: lanComposeSHA256, ownerSPASHA256: ownerSPASHA256)
    let profileData = try encode(profile)
    let config: [String: Any] = [
      "schema_version": 1, "public_host": setup.bindIPv4,
      "public_port": setup.port, "owner_spa_sha256": ownerSPASHA256,
    ]
    let configData = try JSONSerialization.data(
      withJSONObject: config, options: [.sortedKeys, .withoutEscapingSlashes])
    let files: [(String, Data)] = [
      ("profile.json", profileData),
      ("config.json", configData),
      ("certificate.pem", Data(setup.certificatePEM.utf8)),
      ("private-key.pem", Data(setup.privateKeyPEM.utf8)),
      (
        "compose.env",
        try environmentData(
          generationRoot: destination, bindIPv4: setup.bindIPv4, port: setup.port)
      ),
    ]
    for (name, data) in files {
      try RuntimeStorage.writeExclusive(data, to: temporary.appendingPathComponent(name))
    }
    guard Darwin.rename(temporary.path, destination.path) == 0 else {
      try runtimeFail("RUNTIME_PRIVATE_PATH_INVALID")
    }
    try RuntimeStorage.syncParent(of: destination)
    committed = true
    let state = RuntimeLanState(
      version: 1, status: "configured", generation: generation,
      profileSHA256: RuntimeManifestVerifier.sha256(profileData))
    do { try RuntimeStorage.atomicWrite(try encode(state), to: paths.lanState) } catch {
      try runtimeFail("RUNTIME_LAN_STATE_COMMIT_FAILED")
    }
    if RuntimeStorage.pathExists(paths.lanUncertainState) {
      try RuntimeStorage.removePrivateFile(paths.lanUncertainState)
    }
    if RuntimeStorage.pathExists(paths.lanPhysicalUncertainState) {
      try RuntimeStorage.removePrivateFile(paths.lanPhysicalUncertainState)
    }
    return try load(paths)
  }

  static func setStatus(_ value: String, paths: RuntimePaths) throws -> RuntimeLanGeneration {
    try writeStatus(value, paths: paths)
    return try load(paths)
  }

  static func writeStatus(_ value: String, paths: RuntimePaths) throws {
    guard ["configured", "enabled", "disabled"].contains(value) else {
      try runtimeFail("RUNTIME_LAN_PROFILE_INVALID")
    }
    let stateData = try RuntimeStorage.readPrivate(paths.lanState, maximum: 4_096)
    let current = try decodeState(stateData)
    do {
      try RuntimeStorage.atomicWrite(
        try encode(current.withStatus(value)), to: paths.lanState)
    } catch {
      try runtimeFail("RUNTIME_LAN_STATE_COMMIT_FAILED")
    }
  }

  static func persistDisabledAuthority(_ paths: RuntimePaths) throws {
    let candidates = [paths.lanState, paths.lanUncertainState, paths.lanPhysicalUncertainState]
    guard let source = candidates.first(where: RuntimeStorage.pathExists) else {
      try runtimeFail("RUNTIME_LAN_PROFILE_MISSING")
    }
    let state = try decodeState(RuntimeStorage.readPrivate(source, maximum: 4_096))
    do {
      try RuntimeStorage.atomicWrite(
        try encode(state.withStatus("disabled")), to: paths.lanState)
    } catch {
      try runtimeFail("RUNTIME_LAN_STATE_COMMIT_FAILED")
    }
    for marker in [paths.lanUncertainState, paths.lanPhysicalUncertainState]
    where RuntimeStorage.pathExists(marker) {
      try RuntimeStorage.removePrivateFile(marker)
    }
  }

  static func quarantineState(_ paths: RuntimePaths) throws {
    guard
      RuntimeStorage.pathExists(paths.lanState)
        || RuntimeStorage.pathExists(paths.lanUncertainState)
    else { return }
    try moveState(paths, to: paths.lanUncertainState)
  }

  static func quarantinePhysicalState(_ paths: RuntimePaths) throws {
    let source =
      RuntimeStorage.pathExists(paths.lanState) ? paths.lanState : paths.lanUncertainState
    try moveState(source, to: paths.lanPhysicalUncertainState)
  }

  private static func moveState(_ paths: RuntimePaths, to destination: URL) throws {
    try moveState(paths.lanState, to: destination)
  }

  private static func moveState(_ source: URL, to destination: URL) throws {
    let marker = Data(#"{"version":1,"status":"uncertain"}"#.utf8)
    if RuntimeStorage.pathExists(destination) {
      _ = try RuntimeStorage.readPrivate(destination, maximum: 4_096)
      if RuntimeStorage.pathExists(source) {
        try RuntimeStorage.removePrivateFile(source)
      }
      return
    }
    guard RuntimeStorage.pathExists(source) else {
      do { try RuntimeStorage.writeExclusive(marker, to: destination) } catch {
        try runtimeFail("RUNTIME_LAN_STATE_COMMIT_FAILED")
      }
      return
    }
    guard Darwin.rename(source.path, destination.path) == 0 else {
      let sourceData = (try? RuntimeStorage.readPrivate(source, maximum: 4_096)) ?? marker
      do { try RuntimeStorage.writeExclusive(sourceData, to: destination) } catch {
        try runtimeFail("RUNTIME_LAN_STATE_COMMIT_FAILED")
      }
      try RuntimeStorage.removePrivateFile(source)
      return
    }
    do { try RuntimeStorage.syncParent(of: destination) } catch {
      try runtimeFail("RUNTIME_LAN_STATE_COMMIT_FAILED")
    }
  }
}
