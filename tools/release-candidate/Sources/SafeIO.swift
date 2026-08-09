import CryptoKit
import Darwin
import Foundation

let maximumArtifactBytes: Int64 = 8 * 1024 * 1024 * 1024
let maximumJSONBytes: Int64 = 1024 * 1024

struct FileSnapshot: Equatable {
  let device: UInt64
  let inode: UInt64
  let mode: UInt16
  let links: UInt64
  let size: Int64
  let modifiedSeconds: Int64
  let modifiedNanoseconds: Int64
  let changedSeconds: Int64
  let changedNanoseconds: Int64
}

private func snapshot(_ value: stat) -> FileSnapshot {
  FileSnapshot(
    device: UInt64(value.st_dev),
    inode: UInt64(value.st_ino),
    mode: UInt16(value.st_mode & 0o7777),
    links: UInt64(value.st_nlink),
    size: value.st_size,
    modifiedSeconds: Int64(value.st_mtimespec.tv_sec),
    modifiedNanoseconds: Int64(value.st_mtimespec.tv_nsec),
    changedSeconds: Int64(value.st_ctimespec.tv_sec),
    changedNanoseconds: Int64(value.st_ctimespec.tv_nsec)
  )
}

private func pathStat(_ path: String) throws -> stat {
  var value = stat()
  let result = path.withCString { pointer in Darwin.lstat(pointer, &value) }
  guard result == 0 else { try fail("RC_PATH_UNAVAILABLE") }
  return value
}

private func descriptorStat(_ descriptor: Int32) throws -> stat {
  var value = stat()
  guard Darwin.fstat(descriptor, &value) == 0 else { try fail("RC_FILE_UNAVAILABLE") }
  return value
}

private func isFile(_ value: stat) -> Bool { value.st_mode & S_IFMT == S_IFREG }
private func isDirectory(_ value: stat) -> Bool { value.st_mode & S_IFMT == S_IFDIR }
private func isLink(_ value: stat) -> Bool { value.st_mode & S_IFMT == S_IFLNK }

func canonicalPath(_ path: String, _ code: String) throws -> String {
  let parts = path.split(separator: "/", omittingEmptySubsequences: false)
  guard path.hasPrefix("/"), path != "/", !path.hasSuffix("/"),
    parts.first?.isEmpty == true,
    !parts.dropFirst().contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
  else {
    try fail(code)
  }
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard path.withCString({ Darwin.realpath($0, &buffer) }) != nil else { try fail(code) }
  let resolved = String(cString: buffer)
  guard resolved == path else { try fail(code) }
  return path
}

func packageFile(_ root: String, _ relative: String) throws -> String {
  guard !relative.hasPrefix("/"), !relative.isEmpty else { try fail("RC_PACKAGE_PATH_INVALID") }
  let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
  guard !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
    try fail("RC_PACKAGE_PATH_INVALID")
  }
  let path = root + "/" + relative
  return path
}

func readRealFile(
  _ path: String,
  maximum: Int64,
  allowEmpty: Bool = false,
  canonical: Bool = true
) throws -> Data {
  if canonical { _ = try canonicalPath(path, "RC_FILE_PATH_INVALID") }
  let before = try pathStat(path)
  guard isFile(before), !isLink(before), before.st_nlink == 1,
    allowEmpty || before.st_size > 0, before.st_size <= maximum
  else { try fail("RC_FILE_UNSAFE") }
  let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else { try fail("RC_FILE_UNSAFE") }
  defer { Darwin.close(descriptor) }
  let opened = try descriptorStat(descriptor)
  guard snapshot(before) == snapshot(opened) else { try fail("RC_FILE_CHANGED") }
  var output = Data()
  output.reserveCapacity(Int(opened.st_size))
  var buffer = [UInt8](repeating: 0, count: 256 * 1024)
  while output.count < opened.st_size {
    let count = Darwin.read(
      descriptor, &buffer, min(buffer.count, Int(opened.st_size) - output.count))
    guard count > 0 else { try fail("RC_FILE_CHANGED") }
    output.append(buffer, count: count)
  }
  guard snapshot(opened) == snapshot(try descriptorStat(descriptor)),
    snapshot(opened) == snapshot(try pathStat(path))
  else { try fail("RC_FILE_CHANGED") }
  return output
}

func hashRealFile(_ path: String, maximum: Int64 = maximumArtifactBytes) throws -> (Int, String) {
  let before = try pathStat(path)
  guard isFile(before), !isLink(before), before.st_nlink == 1,
    before.st_size > 0, before.st_size <= maximum
  else { try fail("RC_ARTIFACT_UNSAFE") }
  let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else { try fail("RC_ARTIFACT_UNSAFE") }
  defer { Darwin.close(descriptor) }
  let opened = try descriptorStat(descriptor)
  guard snapshot(before) == snapshot(opened) else { try fail("RC_ARTIFACT_CHANGED") }
  var digest = SHA256()
  var total: Int64 = 0
  var buffer = [UInt8](repeating: 0, count: 256 * 1024)
  while total < opened.st_size {
    let count = Darwin.read(descriptor, &buffer, min(buffer.count, Int(opened.st_size - total)))
    guard count > 0 else { try fail("RC_ARTIFACT_CHANGED") }
    digest.update(data: Data(buffer[0..<count]))
    total += Int64(count)
  }
  guard snapshot(opened) == snapshot(try descriptorStat(descriptor)),
    snapshot(opened) == snapshot(try pathStat(path))
  else { try fail("RC_ARTIFACT_CHANGED") }
  let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
  return (Int(total), hash)
}

private func relativePath(_ root: String, _ path: String) throws -> String {
  guard path.hasPrefix(root + "/") else { try fail("RC_APP_PATH_INVALID") }
  return String(path.dropFirst(root.count + 1))
}

private func linkTarget(_ path: String) throws -> String {
  var buffer = [UInt8](repeating: 0, count: Int(PATH_MAX))
  let count = path.withCString { pointer in
    Darwin.readlink(pointer, &buffer, buffer.count)
  }
  guard count > 0, count < buffer.count else { try fail("RC_APP_SYMLINK_UNSAFE") }
  guard let value = String(bytes: buffer[0..<count], encoding: .utf8) else {
    try fail("RC_APP_SYMLINK_UNSAFE")
  }
  return value
}

private func lexicalComponents(_ path: String) -> [Substring]? {
  var output: [Substring] = []
  for component in path.split(separator: "/", omittingEmptySubsequences: false) {
    if component.isEmpty || component == "." { continue }
    if component == ".." {
      guard !output.isEmpty else { return nil }
      output.removeLast()
    } else {
      output.append(component)
    }
  }
  return output
}

private func validateLink(_ root: String, _ path: String, _ before: stat) throws -> String {
  let target = try linkTarget(path)
  guard !target.hasPrefix("/"),
    let rootParts = lexicalComponents(root),
    let targetParts = lexicalComponents(
      (path as NSString).deletingLastPathComponent + "/" + target),
    targetParts.starts(with: rootParts)
  else { try fail("RC_APP_SYMLINK_UNSAFE") }
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard path.withCString({ Darwin.realpath($0, &buffer) }) != nil else {
    try fail("RC_APP_SYMLINK_UNSAFE")
  }
  let resolved = String(cString: buffer)
  guard resolved == root || resolved.hasPrefix(root + "/"),
    snapshot(before) == snapshot(try pathStat(path))
  else { try fail("RC_APP_SYMLINK_UNSAFE") }
  return target
}

private func fileRecord(_ root: String, _ path: String, _ before: stat) throws -> (String, Int) {
  guard before.st_nlink == 1 else { try fail("RC_APP_HARD_LINK_FORBIDDEN") }
  let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else { try fail("RC_APP_FILE_UNSAFE") }
  defer { Darwin.close(descriptor) }
  let opened = try descriptorStat(descriptor)
  guard snapshot(before) == snapshot(opened), isFile(opened), opened.st_size <= maximumArtifactBytes
  else { try fail("RC_APP_CHANGED") }
  var digest = SHA256()
  var total: Int64 = 0
  var buffer = [UInt8](repeating: 0, count: 256 * 1024)
  while total < opened.st_size {
    let count = Darwin.read(descriptor, &buffer, min(buffer.count, Int(opened.st_size - total)))
    guard count > 0 else { try fail("RC_APP_CHANGED") }
    digest.update(data: Data(buffer[0..<count]))
    total += Int64(count)
  }
  guard snapshot(opened) == snapshot(try descriptorStat(descriptor)),
    snapshot(opened) == snapshot(try pathStat(path))
  else { try fail("RC_APP_CHANGED") }
  let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
  let relative = try canonicalJSON(relativePath(root, path))
  let record =
    "{\"path\":\(relative),\"type\":\"file\",\"mode\":\(opened.st_mode & 0o7777),"
    + "\"size_bytes\":\(total),\"sha256\":\(try canonicalJSON(hash))}"
  return (record, Int(total))
}

private func collectTree(_ root: String, _ directory: String, _ records: inout [String]) throws
  -> Int
{
  let directoryBefore = try pathStat(directory)
  let names = try FileManager.default.contentsOfDirectory(atPath: directory).sorted {
    $0.utf16.lexicographicallyPrecedes($1.utf16)
  }
  var total = 0
  for name in names {
    guard !name.contains("/") else { try fail("RC_APP_PATH_INVALID") }
    let path = directory + "/" + name
    let before = try pathStat(path)
    if isLink(before) {
      let relative = try canonicalJSON(relativePath(root, path))
      let target = try canonicalJSON(validateLink(root, path, before))
      records.append(
        "{\"path\":\(relative),\"type\":\"symlink\",\"mode\":\(before.st_mode & 0o7777),"
          + "\"target\":\(target)}"
      )
    } else if isDirectory(before) {
      let relative = try canonicalJSON(relativePath(root, path))
      records.append(
        "{\"path\":\(relative),\"type\":\"directory\",\"mode\":\(before.st_mode & 0o7777)}"
      )
      total += try collectTree(root, path, &records)
      guard snapshot(before) == snapshot(try pathStat(path)) else { try fail("RC_APP_CHANGED") }
    } else if isFile(before) {
      let record = try fileRecord(root, path, before)
      records.append(record.0)
      total += record.1
    } else {
      try fail("RC_APP_SPECIAL_FILE_FORBIDDEN")
    }
  }
  guard snapshot(directoryBefore) == snapshot(try pathStat(directory)) else {
    try fail("RC_APP_CHANGED")
  }
  return total
}

struct AppTree {
  let entryCount: Int
  let name: String
  let rootMode: Int
  let sizeBytes: Int
  let treeSHA256: String
}

func describeApp(_ path: String) throws -> AppTree {
  _ = try canonicalPath(path, "RC_APP_PATH_INVALID")
  guard path.hasSuffix(".app") else { try fail("RC_APP_PATH_INVALID") }
  let before = try pathStat(path)
  guard isDirectory(before), !isLink(before) else { try fail("RC_APP_ROOT_UNSAFE") }
  var records: [String] = []
  let total = try collectTree(path, path, &records)
  guard total > 0, Int64(total) <= maximumArtifactBytes,
    snapshot(before) == snapshot(try pathStat(path))
  else { try fail("RC_APP_CHANGED") }
  return AppTree(
    entryCount: records.count,
    name: (path as NSString).lastPathComponent,
    rootMode: Int(before.st_mode & 0o7777),
    sizeBytes: total,
    treeSHA256: sha256Hex(Data(("[" + records.joined(separator: ",") + "]").utf8))
  )
}
