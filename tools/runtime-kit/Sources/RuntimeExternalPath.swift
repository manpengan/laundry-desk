import Darwin
import Foundation

private struct RuntimeExternalDirectory {
  let url: URL
  let descriptor: Int32
  let snapshot: RuntimeExternalSnapshot

  func isCurrent() -> Bool {
    guard let current = try? RuntimeExternalPath.openDirectory(url) else { return false }
    defer { Darwin.close(current.descriptor) }
    return snapshot.directoryIdentityMatches(current.metadata)
  }

  func sync() -> Bool { Darwin.fsync(descriptor) == 0 }
}

final class RuntimeExternalInput {
  let handle: FileHandle
  let size: Int64
  private let name: String
  private var directory: RuntimeExternalDirectory?
  private let snapshot: RuntimeExternalSnapshot
  private var finished = false

  fileprivate init(
    name: String, directory: RuntimeExternalDirectory, handle: FileHandle, metadata: stat
  ) {
    self.name = name
    self.directory = directory
    self.handle = handle
    self.size = metadata.st_size
    self.snapshot = RuntimeExternalSnapshot(metadata)
  }

  func finish() throws {
    guard !finished, let directory else { return }
    var descriptorMetadata = stat()
    guard Darwin.fstat(handle.fileDescriptor, &descriptorMetadata) == 0,
      let pathMetadata = RuntimeExternalPath.metadata(at: directory.descriptor, name: name),
      snapshot.matches(descriptorMetadata), snapshot.matches(pathMetadata), directory.isCurrent()
    else {
      closeHandles()
      try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
    }
    do { try handle.close() } catch {
      closeDirectory()
      try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
    }
    closeDirectory()
    finished = true
  }

  private func closeDirectory() {
    guard let directory else { return }
    Darwin.close(directory.descriptor)
    self.directory = nil
  }

  private func closeHandles() {
    try? handle.close()
    closeDirectory()
  }

  deinit { closeHandles() }
}

final class RuntimeExternalOutput {
  let handle: FileHandle
  private let destinationName: String
  private let temporaryName: String
  private var directory: RuntimeExternalDirectory?
  private var published = false

  fileprivate init(
    destinationName: String, temporaryName: String, directory: RuntimeExternalDirectory,
    handle: FileHandle
  ) {
    self.destinationName = destinationName
    self.temporaryName = temporaryName
    self.directory = directory
    self.handle = handle
  }

  func publish() throws -> Int64 {
    guard !published, let directory else { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
    do { try handle.synchronize() } catch { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
    var metadata = stat()
    guard Darwin.fstat(handle.fileDescriptor, &metadata) == 0,
      RuntimeExternalPath.isPrivateRegular(metadata), metadata.st_size > 0,
      let temporaryMetadata = RuntimeExternalPath.metadata(
        at: directory.descriptor, name: temporaryName),
      RuntimeExternalSnapshot(metadata).matches(temporaryMetadata),
      RuntimeExternalPath.isMissing(at: directory.descriptor, name: destinationName),
      directory.isCurrent()
    else { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
    let renamed = temporaryName.withCString { source in
      destinationName.withCString { destination in
        Darwin.renameatx_np(
          directory.descriptor, source, directory.descriptor, destination, UInt32(RENAME_EXCL))
      }
    }
    guard renamed == 0 else { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
    var publishedMetadata = stat()
    let validPublishedFile =
      Darwin.fstat(handle.fileDescriptor, &publishedMetadata) == 0
      && RuntimeExternalPath.metadata(at: directory.descriptor, name: destinationName).map {
        RuntimeExternalSnapshot(publishedMetadata).matches($0)
      } == true
      && directory.isCurrent()
    guard validPublishedFile, directory.sync() else {
      let removed = removePublishedFileIfOwned()
      closeHandles()
      if removed { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
      try runtimeFail("RUNTIME_TRANSFER_PUBLISH_UNCERTAIN")
    }
    published = true
    closeHandles()
    return publishedMetadata.st_size
  }

  private func removePublishedFileIfOwned() -> Bool {
    guard let directory else { return false }
    var descriptorMetadata = stat()
    guard Darwin.fstat(handle.fileDescriptor, &descriptorMetadata) == 0,
      RuntimeExternalPath.metadata(at: directory.descriptor, name: destinationName).map({
        RuntimeExternalSnapshot(descriptorMetadata).identityMatches($0)
      }) == true
    else { return false }
    let removed = destinationName.withCString {
      Darwin.unlinkat(directory.descriptor, $0, 0)
    }
    return removed == 0 && directory.sync()
  }

  private func removeTemporaryIfOwned() {
    guard let directory else { return }
    var descriptorMetadata = stat()
    guard Darwin.fstat(handle.fileDescriptor, &descriptorMetadata) == 0,
      RuntimeExternalPath.metadata(at: directory.descriptor, name: temporaryName).map({
        RuntimeExternalSnapshot(descriptorMetadata).identityMatches($0)
      }) == true
    else { return }
    _ = temporaryName.withCString { Darwin.unlinkat(directory.descriptor, $0, 0) }
    _ = directory.sync()
  }

  private func closeHandles() {
    try? handle.close()
    guard let directory else { return }
    Darwin.close(directory.descriptor)
    self.directory = nil
  }

  deinit {
    if !published { removeTemporaryIfOwned() }
    closeHandles()
  }
}

enum RuntimeExternalPath {
  static let maximumTransferBytes = RuntimePortableArchive.maximumArchiveBytes
  static let capacityReserveBytes: Int64 = 67_108_864

  enum CapacityDomain {
    case runtime
    case external

    #if RUNTIME_TESTING
      var testingEnvironmentKey: String {
        switch self {
        case .runtime: return "LAUNDRY_RUNTIME_TEST_ROOT_CAPACITY_BYTES"
        case .external: return "LAUNDRY_RUNTIME_TEST_EXTERNAL_CAPACITY_BYTES"
        }
      }
    #endif
  }

  private static func url(_ path: String) throws -> URL {
    guard isCanonicalAbsolute(path), !path.contains("\0"), path.utf8.count <= 2_048,
      path.hasSuffix(".laundry-transfer")
    else { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
    let value = URL(fileURLWithPath: path)
    guard value.path == path, value.lastPathComponent.utf8.count <= 255 else {
      try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
    }
    return value
  }

  fileprivate static func openDirectory(_ url: URL) throws
    -> (descriptor: Int32, metadata: stat)
  {
    guard isCanonicalAbsolute(url.path) else { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
    let components = Array(url.pathComponents.dropFirst())
    var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
    for component in components {
      guard component != ".", component != "..", !component.contains("/") else {
        Darwin.close(descriptor)
        try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
      }
      let next = component.withCString {
        Darwin.openat(descriptor, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      }
      Darwin.close(descriptor)
      guard next >= 0 else { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
      descriptor = next
    }
    var metadata = stat()
    guard Darwin.fstat(descriptor, &metadata) == 0,
      (metadata.st_mode & S_IFMT) == S_IFDIR
    else {
      Darwin.close(descriptor)
      try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
    }
    return (descriptor, metadata)
  }

  fileprivate static func metadata(at directory: Int32, name: String) -> stat? {
    var value = stat()
    let result = name.withCString {
      Darwin.fstatat(directory, $0, &value, AT_SYMLINK_NOFOLLOW)
    }
    return result == 0 ? value : nil
  }

  fileprivate static func isMissing(at directory: Int32, name: String) -> Bool {
    var value = stat()
    errno = 0
    let result = name.withCString {
      Darwin.fstatat(directory, $0, &value, AT_SYMLINK_NOFOLLOW)
    }
    return result != 0 && errno == ENOENT
  }

  fileprivate static func isPrivateRegular(_ value: stat) -> Bool {
    (value.st_mode & S_IFMT) == S_IFREG && (value.st_mode & 0o777) == 0o600
      && value.st_nlink == 1
  }

  private static func isCanonicalAbsolute(_ path: String) -> Bool {
    guard path.hasPrefix("/"), !path.contains("//") else { return false }
    let components = path.split(separator: "/")
    return "/\(components.joined(separator: "/"))" == path
      && components.allSatisfy { $0 != "." && $0 != ".." }
  }

  static func openInput(_ path: String) throws -> RuntimeExternalInput {
    let value = try url(path)
    let directory = try openExternalParent(value)
    let name = value.lastPathComponent
    guard let before = metadata(at: directory.descriptor, name: name),
      isPrivateRegular(before), before.st_size > 0, before.st_size <= maximumTransferBytes
    else {
      Darwin.close(directory.descriptor)
      try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
    }
    let descriptor = name.withCString {
      Darwin.openat(directory.descriptor, $0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    }
    guard descriptor >= 0 else {
      Darwin.close(directory.descriptor)
      try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
    }
    var opened = stat()
    guard Darwin.fstat(descriptor, &opened) == 0,
      RuntimeExternalSnapshot(before).matches(opened), directory.isCurrent()
    else {
      Darwin.close(descriptor)
      Darwin.close(directory.descriptor)
      try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
    }
    return RuntimeExternalInput(
      name: name, directory: directory,
      handle: FileHandle(fileDescriptor: descriptor, closeOnDealloc: true), metadata: opened)
  }

  static func assertCapacity(
    at directoryURL: URL, requiredBytes: Int64, domain: CapacityDomain
  ) throws {
    let directory = try openDirectory(directoryURL)
    defer { Darwin.close(directory.descriptor) }
    try assertCapacity(
      descriptor: directory.descriptor, requiredBytes: requiredBytes, domain: domain)
  }

  static func createOutput(_ path: String, requiredBytes: Int64) throws
    -> RuntimeExternalOutput
  {
    let destination = try url(path)
    let directory = try openExternalParent(destination)
    let destinationName = destination.lastPathComponent
    do {
      guard isMissing(at: directory.descriptor, name: destinationName) else {
        try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
      }
      try assertCapacity(
        descriptor: directory.descriptor, requiredBytes: requiredBytes, domain: .external)
      let temporaryName =
        ".\(destinationName).\(try RuntimeStorage.randomToken(bytes: 12)).tmp"
      let descriptor = temporaryName.withCString {
        Darwin.openat(
          directory.descriptor, $0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
          0o600)
      }
      guard descriptor >= 0 else { try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID") }
      var created = stat()
      guard Darwin.fstat(descriptor, &created) == 0, isPrivateRegular(created),
        directory.isCurrent()
      else {
        Darwin.close(descriptor)
        _ = temporaryName.withCString { Darwin.unlinkat(directory.descriptor, $0, 0) }
        try runtimeFail("RUNTIME_TRANSFER_PATH_INVALID")
      }
      return RuntimeExternalOutput(
        destinationName: destinationName, temporaryName: temporaryName, directory: directory,
        handle: FileHandle(fileDescriptor: descriptor, closeOnDealloc: true))
    } catch {
      Darwin.close(directory.descriptor)
      throw error
    }
  }

  private static func openExternalParent(_ value: URL) throws -> RuntimeExternalDirectory {
    let url = value.deletingLastPathComponent()
    let opened = try openDirectory(url)
    return RuntimeExternalDirectory(
      url: url, descriptor: opened.descriptor, snapshot: RuntimeExternalSnapshot(opened.metadata))
  }

  private static func assertCapacity(
    descriptor: Int32, requiredBytes: Int64, domain: CapacityDomain
  ) throws {
    guard requiredBytes > 0 else { try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW") }
    #if RUNTIME_TESTING
      if let raw = ProcessInfo.processInfo.environment[domain.testingEnvironmentKey] {
        guard let available = Int64(raw), available >= requiredBytes else {
          try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW")
        }
        return
      }
    #endif
    var fileSystem = statfs()
    guard Darwin.fstatfs(descriptor, &fileSystem) == 0,
      fileSystem.f_bsize > 0, fileSystem.f_bavail > 0,
      fileSystem.f_bavail <= UInt64(Int64.max) / UInt64(fileSystem.f_bsize),
      Int64(fileSystem.f_bavail) * Int64(fileSystem.f_bsize) >= requiredBytes
    else { try runtimeFail("RUNTIME_TRANSFER_CAPACITY_LOW") }
  }
}
