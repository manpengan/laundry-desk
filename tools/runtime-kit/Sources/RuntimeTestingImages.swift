import Foundation

extension NativeRuntimeController {
  func runtimeServerImage(_ signedReference: String) -> String {
    testLocalServerImage ?? signedReference
  }

  func prepareImages(_ payload: RuntimeManifestPayload) throws {
    if testLocalServerImage == nil {
      try run(command(["pull", payload.serverImage.index]))
      try run(command(["pull", payload.postgresImage]))
    } else {
      try assertCachedTestingPostgres(payload.postgresImage)
    }
  }

  private func assertCachedTestingPostgres(_ signedReference: String) throws {
    #if RUNTIME_TESTING
      let prefix = "docker.io/library/postgres@"
      guard signedReference.hasPrefix(prefix) else {
        try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID")
      }
      let digest = String(signedReference.dropFirst(prefix.count))
      let result = try run(
        command(["image", "inspect", "--format", "{{json .RepoDigests}}", "postgres:16"]))
      guard let data = result.stdout.data(using: .utf8),
        let repoDigests = try? JSONDecoder().decode([String].self, from: data),
        repoDigests.contains("postgres@\(digest)")
      else { try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID") }
    #else
      try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID")
    #endif
  }

  func assertImage(_ payload: RuntimeManifestPayload) throws {
    let reference = runtimeServerImage(payload.serverImage.index)
    let result = try run(
      command(["image", "inspect", "--format", "{{json .Config.Labels}}", reference]))
    guard let data = result.stdout.data(using: .utf8),
      let labels = try? JSONDecoder().decode([String: String].self, from: data)
    else { try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID") }
    let expected = [
      "com.laundry-desk.runtime.release": payload.release,
      "com.laundry-desk.runtime.contracts-major": String(payload.contractsMajor),
      "com.laundry-desk.runtime.contracts-sha256": payload.contractsSHA256,
      "com.laundry-desk.runtime.server-version": payload.serverVersion,
      "com.laundry-desk.runtime.web-bundle-sha256": payload.webBundleSHA256,
      "com.laundry-desk.runtime.schema-sha256": payload.databaseSchemaSHA256,
      "com.laundry-desk.runtime.migrations-sha256": payload.migrationsSHA256,
      "com.laundry-desk.runtime.migration-head": payload.migrationHead,
    ]
    guard expected.allSatisfy({ labels[$0.key] == $0.value }) else {
      try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID")
    }
    let architectureResult = try run(
      command(["image", "inspect", "--format", "{{json .Architecture}}", reference]))
    guard let architectureData = architectureResult.stdout.data(using: .utf8),
      let architecture = try? JSONDecoder().decode(String.self, from: architectureData),
      ["arm64", "amd64"].contains(architecture)
    else { try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID") }
    if testLocalServerImage != nil {
      guard let digest = payload.serverImage.index.split(separator: "@").last else {
        try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID")
      }
      let idResult = try run(
        command(["image", "inspect", "--format", "{{json .Id}}", reference]))
      let expectedID = String(digest)
      guard let idData = idResult.stdout.data(using: .utf8),
        let imageID = try? JSONDecoder().decode(String.self, from: idData),
        imageID == expectedID
      else { try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID") }
      return
    }
    let digestsResult = try run(
      command(["image", "inspect", "--format", "{{json .RepoDigests}}", reference]))
    guard let digestsData = digestsResult.stdout.data(using: .utf8),
      let repoDigests = try? JSONDecoder().decode([String].self, from: digestsData),
      repoDigests.contains(payload.serverImage.index)
    else { try runtimeFail("RUNTIME_IMAGE_METADATA_INVALID") }
  }
}
