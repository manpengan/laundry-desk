import Foundation

final class NativeRuntimeController {
  static let defaultProject = "laundry-desk-runtime"
  static let defaultVolumes = [
    (logical: "pgdata-v2", name: "laundry-desk-runtime_pgdata-v2"),
    (logical: "photos", name: "laundry-desk-runtime_photos"),
  ]
  let paths: RuntimePaths
  let runner: RuntimeRunner
  let runtimeProject: String
  let runtimeVolumes: [(logical: String, name: String)]
  let testLocalServerImage: String?
  private let appVersion: String
  private let contractsMajor = 2

  init(
    paths: RuntimePaths, runner: RuntimeRunner, appVersion: String,
    testIsolationID: String? = nil, testLocalServerImage: String? = nil
  ) {
    self.paths = paths
    self.runner = runner
    self.appVersion = appVersion
    self.testLocalServerImage = testLocalServerImage
    if let testIsolationID {
      runtimeProject = "laundry-desk-runtime-test-\(testIsolationID)"
      runtimeVolumes = [
        ("pgdata-v2", "\(runtimeProject)_pgdata-v2"),
        ("photos", "\(runtimeProject)_photos"),
      ]
    } else {
      runtimeProject = Self.defaultProject
      runtimeVolumes = Self.defaultVolumes
    }
  }

  var photoVolumeName: String {
    runtimeVolumes.first(where: { $0.logical == "photos" })?.name
      ?? Self.defaultVolumes[1].name
  }

  func command(_ args: [String], environment: [String: String] = [:]) -> RuntimeCommandSpec {
    RuntimeCommandSpec(executable: runner.dockerPath, arguments: args, environment: environment)
  }

  func compose(_ args: [String], environment: [String: String]) -> RuntimeCommandSpec {
    command(
      ["compose", "--project-name", runtimeProject, "--file", paths.compose.path] + args,
      environment: environment)
  }

  @discardableResult func run(
    _ spec: RuntimeCommandSpec,
    accepting: Set<Int32> = [0]
  ) throws -> RuntimeCommandResult {
    try runner.run(spec, accepting: accepting)
  }

  private func trustedKey() throws -> String {
    guard let value = try? String(contentsOf: paths.trustedKey, encoding: .utf8)
    else { try runtimeFail("RUNTIME_TRUST_KEY_MISSING") }
    return value
  }

  func verifyManifest(_ data: Data) throws -> RuntimeManifestPayload {
    let payload = try RuntimeManifestVerifier.verify(
      data: data, trustedKeyText: trustedKey(),
      appVersion: appVersion,
      contractsMajor: contractsMajor)
    runner.setManifest(payload)
    return payload
  }

  func decodeState(_ data: Data) throws -> RuntimeState {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == [
        "version", "status", "release", "manifest_sha256",
        "compose_sha256", "instance_id", "volumes",
      ],
      let state = try? JSONDecoder().decode(RuntimeState.self, from: data),
      state.version == 1, state.volumes == runtimeVolumes.map({ $0.name }),
      ["prepared", "finalizing", "installed"].contains(state.status),
      state.instanceID.range(
        of: "^[A-Za-z0-9_-]{22,128}$",
        options: .regularExpression) != nil
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    return state
  }

  func encodedState(_ state: RuntimeState) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(state)
  }

  func environment(
    _ state: RuntimeState,
    _ payload: RuntimeManifestPayload
  ) -> [String: String] {
    [
      "LAUNDRY_RUNTIME_CONFIG_ROOT": paths.root.path,
      "LAUNDRY_RUNTIME_PGDATA_VOLUME": runtimeVolumes[0].name,
      "LAUNDRY_RUNTIME_PHOTOS_VOLUME": runtimeVolumes[1].name,
      "LAUNDRY_RUNTIME_INSTANCE_ID": state.instanceID,
      "LAUNDRY_RUNTIME_SERVER_IMAGE": runtimeServerImage(payload.serverImage.index),
      "LAUNDRY_RUNTIME_POSTGRES_IMAGE": payload.postgresImage,
      "LAUNDRY_RUNTIME_RELEASE": payload.release,
      "LAUNDRY_RUNTIME_CONTRACTS_SHA256": payload.contractsSHA256,
      "LAUNDRY_RUNTIME_SCHEMA_SHA256": payload.databaseSchemaSHA256,
      "LAUNDRY_RUNTIME_MIGRATIONS_SHA256": payload.migrationsSHA256,
      "LAUNDRY_RUNTIME_MIGRATION_HEAD": payload.migrationHead,
    ]
  }

  func loadSnapshot(allowRecovery: Bool = false, allowTransition: Bool = false) throws
    -> (state: RuntimeState, payload: RuntimeManifestPayload, stateData: Data, manifestData: Data)
  {
    try RuntimeStorage.validateDirectory(paths.root)
    guard
      allowTransition
        || (!RuntimeStorage.pathExists(paths.transition)
          && !RuntimeStorage.pathExists(paths.pendingManifest))
    else { try runtimeFail("RUNTIME_RELEASE_RECOVERY_REQUIRED") }
    let stateData = try RuntimeStorage.readPrivate(paths.state)
    let manifestData = try RuntimeStorage.readPrivate(paths.manifest)
    let state = try decodeState(stateData)
    let payload = try verifyManifest(manifestData)
    let composeData = try Data(contentsOf: paths.compose)
    guard allowRecovery || state.status == "installed",
      state.release == payload.release,
      state.manifestSHA256 == RuntimeManifestVerifier.sha256(manifestData),
      state.composeSHA256 == RuntimeManifestVerifier.sha256(composeData),
      payload.composeSHA256 == state.composeSHA256
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    try RuntimeStorage.validateSecrets(paths.secrets, phase: state.status)
    return (state, payload, stateData, manifestData)
  }

  func load(allowRecovery: Bool = false, allowTransition: Bool = false) throws
    -> (RuntimeState, RuntimeManifestPayload)
  {
    let snapshot = try loadSnapshot(
      allowRecovery: allowRecovery, allowTransition: allowTransition)
    return (snapshot.state, snapshot.payload)
  }

  private func inspectVolume(_ name: String) throws -> (exists: Bool, labels: [String: String]?) {
    let result = try run(
      command([
        "volume", "inspect", "--format", "{{json .Labels}}",
        name,
      ]), accepting: [0, 1])
    if result.code == 1 { return (false, nil) }
    guard let data = result.stdout.data(using: .utf8),
      let labels = try? JSONDecoder().decode([String: String].self, from: data)
    else { try runtimeFail("RUNTIME_VOLUME_INVALID") }
    return (true, labels)
  }

  private func volumeMatches(_ volume: (Bool, [String: String]?), state: RuntimeState) -> Bool {
    guard volume.0, let labels = volume.1 else { return false }
    return labels["com.laundry-desk.managed"] == "true"
      && labels["com.laundry-desk.project"] == runtimeProject
      && labels["com.laundry-desk.instance"] == state.instanceID
  }

  private func inspectVolumes() throws
    -> [(logical: String, name: String, exists: Bool, labels: [String: String]?)]
  {
    try runtimeVolumes.map { volume in
      let inspected = try inspectVolume(volume.name)
      return (volume.logical, volume.name, inspected.exists, inspected.labels)
    }
  }

  @discardableResult func assertVolumes(
    _ state: RuntimeState, allowMissing: Bool = false
  ) throws -> [(logical: String, name: String, exists: Bool, labels: [String: String]?)] {
    let volumes = try inspectVolumes()
    guard
      volumes.allSatisfy({
        (!$0.exists && allowMissing)
          || volumeMatches(($0.exists, $0.labels), state: state)
      })
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    return volumes
  }

  private func ensureVolumes(_ state: RuntimeState) throws {
    let labels = [
      "com.laundry-desk.managed": "true",
      "com.laundry-desk.project": runtimeProject,
      "com.laundry-desk.instance": state.instanceID,
    ]
    let labelArguments = labels.keys.sorted().flatMap { key in
      ["--label", "\(key)=\(labels[key] ?? "")"]
    }
    for volume in runtimeVolumes {
      try run(command(["volume", "create"] + labelArguments + [volume.name]))
    }
    try assertVolumes(state)
  }

  func gates(
    _ state: RuntimeState, _ payload: RuntimeManifestPayload,
    bootstrap: Bool
  ) throws {
    let env = environment(state, payload)
    try run(compose(["up", "-d", "--wait", "postgres"], environment: env))
    try run(compose(["run", "--rm", "roles"], environment: env))
    try run(compose(["run", "--rm", "migrate"], environment: env))
    if bootstrap { try run(compose(["run", "--rm", "bootstrap"], environment: env)) }
    try run(compose(["run", "--rm", "verify"], environment: env))
    if bootstrap {
      try run(
        compose(["run", "--rm", "verify", "verify-commissioned"], environment: env))
    }
    try run(compose(["up", "-d", "--wait", "server"], environment: env))
    let health = try run(
      RuntimeCommandSpec(
        executable: "/usr/bin/curl",
        arguments: [
          "--fail", "--silent", "--show-error", "--max-time", "3",
          "http://127.0.0.1:8787/health",
        ], environment: [:]))
    guard let data = health.stdout.data(using: .utf8),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      root["ok"] as? Bool == true,
      (root["data"] as? [String: Any])?["status"] as? String == "ready"
    else { try runtimeFail("RUNTIME_HEALTH_GATE_FAILED") }
  }

  private func finishInstall(_ state: RuntimeState) throws {
    try RuntimeStorage.atomicWrite(
      try encodedState(state.withStatus("finalizing")), to: paths.state)
    try RuntimeStorage.removeBootstrapSecrets(paths.secrets)
    try initializeMaintenanceBaseline()
    try RuntimeStorage.atomicWrite(try encodedState(state.withStatus("installed")), to: paths.state)
  }

  func install(manifestURL: URL, setup: RuntimeSetup) throws -> String {
    try validateRuntimeSetup(setup)
    try prepareForRuntimeMutationIfRootExists()
    let manifestData = try RuntimeStorage.readBounded(manifestURL)
    let payload = try verifyManifest(manifestData)
    let composeData = try Data(contentsOf: paths.compose)
    guard RuntimeManifestVerifier.sha256(composeData) == payload.composeSHA256
    else { try runtimeFail("RUNTIME_COMPOSE_CHECKSUM_MISMATCH") }
    try RuntimeStorage.ensureDirectory(paths.root)
    let entries = (try? FileManager.default.contentsOfDirectory(atPath: paths.secrets.path)) ?? []
    let existingVolumes = try inspectVolumes()
    let managedFiles = [
      paths.state, paths.manifest, paths.releaseHistory, paths.previousManifest,
      paths.pendingManifest, paths.transition,
    ]
    guard !managedFiles.contains(where: RuntimeStorage.pathExists), entries.isEmpty,
      !existingVolumes.contains(where: { $0.exists })
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    try RuntimeStorage.ensureDirectory(paths.secrets)
    let secrets = try RuntimeStorage.buildSecrets(setup)
    for name in RuntimeStorage.allSecrets {
      guard let value = secrets[name]?.data(using: .utf8) else {
        try runtimeFail("RUNTIME_SETUP_INVALID")
      }
      try RuntimeStorage.writeExclusive(value, to: paths.secrets.appendingPathComponent(name))
    }
    try RuntimeStorage.writeExclusive(manifestData, to: paths.manifest)
    let state = RuntimeState(
      version: 1, status: "prepared", release: payload.release,
      manifestSHA256: RuntimeManifestVerifier.sha256(manifestData),
      composeSHA256: payload.composeSHA256,
      instanceID: try RuntimeStorage.randomToken(), volumes: runtimeVolumes.map({ $0.name }))
    try RuntimeStorage.writeExclusive(try encodedState(state), to: paths.state)
    let history = RuntimeReleaseHistory(
      version: 1, highestAcceptedRelease: payload.release,
      previousRelease: nil, previousManifestSHA256: nil, preUpgradeBackupID: nil)
    try RuntimeStorage.writeExclusive(
      try RuntimeReleaseCodec.encode(history), to: paths.releaseHistory)
    try prepareImages(payload)
    try assertImage(payload)
    try ensureVolumes(state)
    try gates(state, payload, bootstrap: true)
    try assertVolumes(state)
    try finishInstall(state)
    return payload.release
  }

  func recover(manifestURL: URL) throws -> String {
    try RuntimeStorage.validateDirectory(paths.root)
    try prepareForRuntimeMutation()
    let requestedData = try RuntimeStorage.readBounded(manifestURL)
    let requested = try verifyManifest(requestedData)
    let (state, payload) = try load(allowRecovery: true)
    guard ["prepared", "finalizing"].contains(state.status),
      RuntimeManifestVerifier.sha256(requestedData) == state.manifestSHA256,
      requested.release == payload.release
    else { try runtimeFail("RUNTIME_RECOVERY_REQUIRED") }
    try assertVolumes(state, allowMissing: state.status == "prepared")
    if state.status == "prepared" {
      try prepareImages(payload)
      try assertImage(payload)
      try ensureVolumes(state)
      try gates(state, payload, bootstrap: true)
      try assertVolumes(state)
    }
    try finishInstall(state)
    return payload.release
  }

  func startUnlocked() throws -> String {
    try prepareForRuntimeMutation()
    let (state, payload) = try load()
    try initializeMaintenanceBaseline()
    try assertVolumes(state)
    try assertImage(payload)
    try gates(state, payload, bootstrap: false)
    try restoreEnabledLanAfterServerStart(state: state, payload: payload)
    return payload.release
  }

  func stopUnlocked() throws -> String {
    try emergencyStopLanGateway()
    let (state, payload) = try load()
    try assertVolumes(state)
    try run(compose(["stop", "server", "postgres"], environment: environment(state, payload)))
    return payload.release
  }

  func start() throws -> String {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) { try startUnlocked() }
  }

  func stop() throws -> String {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) { try stopUnlocked() }
  }

  func restart() throws -> String {
    try RuntimeStorage.validateDirectory(paths.root)
    return try RuntimeStorage.withMaintenanceLock(paths.root) {
      try prepareForRuntimeMutation()
      _ = try stopUnlocked()
      return try startUnlocked()
    }
  }

}
