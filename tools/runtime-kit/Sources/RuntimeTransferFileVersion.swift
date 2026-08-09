import Darwin
import Foundation

struct RuntimeExternalSnapshot {
  let device: dev_t
  let inode: ino_t
  let mode: mode_t
  let links: nlink_t
  let size: off_t
  let modifiedSeconds: Int
  let modifiedNanos: Int
  let changedSeconds: Int
  let changedNanos: Int

  init(_ value: stat) {
    device = value.st_dev
    inode = value.st_ino
    mode = value.st_mode
    links = value.st_nlink
    size = value.st_size
    modifiedSeconds = value.st_mtimespec.tv_sec
    modifiedNanos = value.st_mtimespec.tv_nsec
    changedSeconds = value.st_ctimespec.tv_sec
    changedNanos = value.st_ctimespec.tv_nsec
  }

  func matches(_ value: stat) -> Bool {
    identityMatches(value) && size == value.st_size
      && modifiedSeconds == value.st_mtimespec.tv_sec
      && modifiedNanos == value.st_mtimespec.tv_nsec
      && changedSeconds == value.st_ctimespec.tv_sec
      && changedNanos == value.st_ctimespec.tv_nsec
  }

  func identityMatches(_ value: stat) -> Bool {
    device == value.st_dev && inode == value.st_ino && mode == value.st_mode
      && links == value.st_nlink
  }

  func directoryIdentityMatches(_ value: stat) -> Bool {
    device == value.st_dev && inode == value.st_ino && mode == value.st_mode
      && (value.st_mode & S_IFMT) == S_IFDIR
  }
}

struct RuntimeTransferFileVersion {
  private let value: stat

  init(handle: FileHandle, url: URL) throws {
    var descriptor = stat()
    var path = stat()
    guard Darwin.fstat(handle.fileDescriptor, &descriptor) == 0,
      Darwin.lstat(url.path, &path) == 0, Self.matches(descriptor, path),
      (descriptor.st_mode & S_IFMT) == S_IFREG,
      (descriptor.st_mode & 0o777) == 0o600, descriptor.st_nlink == 1
    else { try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID") }
    value = descriptor
  }

  func verify(handle: FileHandle, url: URL) throws {
    var descriptor = stat()
    var path = stat()
    guard Darwin.fstat(handle.fileDescriptor, &descriptor) == 0,
      Darwin.lstat(url.path, &path) == 0, Self.matches(value, descriptor),
      Self.matches(descriptor, path)
    else { try runtimeFail("RUNTIME_TRANSFER_SOURCE_INVALID") }
  }

  private static func matches(_ left: stat, _ right: stat) -> Bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
      && left.st_mode == right.st_mode && left.st_nlink == right.st_nlink
      && left.st_size == right.st_size
      && left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec
      && left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec
      && left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec
      && left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec
  }
}
