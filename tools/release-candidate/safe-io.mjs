import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256 } from "./schema.mjs";

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_JSON_BYTES = 1024 * 1024;

export function canonicalAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label}_PATH_INVALID`);
  }
  return value;
}

function snapshot(metadata) {
  return ["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].map((key) => metadata[key]);
}

function sameSnapshot(left, right) {
  return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right));
}

function validFile(metadata, maximumBytes, allowEmpty) {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    (allowEmpty || metadata.size >= 1) &&
    metadata.size <= maximumBytes
  );
}

export async function readBoundedRealFile(
  path,
  label,
  maximumBytes = MAX_JSON_BYTES,
  { allowEmpty = false } = {},
) {
  canonicalAbsolutePath(path, label);
  if ((await realpath(path)) !== path) throw new Error(`${label}_PATH_INVALID`);
  const before = await lstat(path);
  if (!validFile(before, maximumBytes, allowEmpty)) throw new Error(`${label}_FILE_UNSAFE`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!validFile(opened, maximumBytes, allowEmpty) || !sameSnapshot(before, opened)) {
      throw new Error(`${label}_FILE_CHANGED`);
    }
    const bytes = await handle.readFile();
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      bytes.length !== opened.size ||
      !sameSnapshot(opened, afterHandle) ||
      !sameSnapshot(afterHandle, afterPath)
    ) {
      throw new Error(`${label}_FILE_CHANGED`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readStrictJson(path, label, maximumBytes = MAX_JSON_BYTES) {
  const bytes = await readBoundedRealFile(path, label, maximumBytes);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label}_JSON_INVALID`);
  }
  return Object.freeze({ bytes, value });
}

export async function readCanonicalJson(path, label, maximumBytes = MAX_JSON_BYTES) {
  const result = await readStrictJson(path, label, maximumBytes);
  if (result.bytes.toString("utf8") !== canonicalJson(result.value)) {
    throw new Error(`${label}_JSON_NOT_CANONICAL`);
  }
  return result.value;
}

export async function describeFile(path, packagePath, maximumBytes = MAX_ARTIFACT_BYTES) {
  canonicalAbsolutePath(path, "RC_ARTIFACT");
  if ((await realpath(path)) !== path) throw new Error("RC_ARTIFACT_PATH_INVALID");
  const before = await lstat(path);
  if (!validFile(before, maximumBytes, false)) throw new Error("RC_ARTIFACT_FILE_UNSAFE");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!validFile(opened, maximumBytes, false) || !sameSnapshot(before, opened)) {
      throw new Error("RC_ARTIFACT_FILE_CHANGED");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error("RC_ARTIFACT_FILE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameSnapshot(opened, afterHandle) || !sameSnapshot(afterHandle, afterPath)) {
      throw new Error("RC_ARTIFACT_FILE_CHANGED");
    }
    return Object.freeze({
      path: packagePath,
      sha256: hash.digest("hex"),
      size_bytes: opened.size,
    });
  } finally {
    await handle.close();
  }
}

function insideRoot(root, candidate) {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function describeTreeFile(root, path, metadata) {
  if (metadata.nlink !== 1) throw new Error("RC_APP_HARD_LINK_FORBIDDEN");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameSnapshot(metadata, opened)) {
      throw new Error("RC_APP_CHANGED");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error("RC_APP_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameSnapshot(opened, afterHandle) || !sameSnapshot(afterHandle, afterPath)) {
      throw new Error("RC_APP_CHANGED");
    }
    return Object.freeze({
      path: relative(root, path),
      type: "file",
      mode: opened.mode & 0o7777,
      size_bytes: opened.size,
      sha256: hash.digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function describeTreeLink(root, realRoot, path, metadata) {
  const target = await readlink(path);
  if (isAbsolute(target) || !insideRoot(root, resolve(dirname(path), target))) {
    throw new Error("RC_APP_SYMLINK_UNSAFE");
  }
  let resolved;
  try {
    resolved = await realpath(path);
  } catch {
    throw new Error("RC_APP_SYMLINK_UNSAFE");
  }
  if (!insideRoot(realRoot, resolved) || !sameSnapshot(metadata, await lstat(path))) {
    throw new Error("RC_APP_SYMLINK_UNSAFE");
  }
  return Object.freeze({
    path: relative(root, path),
    type: "symlink",
    mode: metadata.mode & 0o7777,
    target,
  });
}

async function collectTree(root, realRoot, directory, records) {
  const before = await lstat(directory);
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      records.push(await describeTreeLink(root, realRoot, path, metadata));
    } else if (metadata.isDirectory()) {
      records.push(
        Object.freeze({
          path: relative(root, path),
          type: "directory",
          mode: metadata.mode & 0o7777,
        }),
      );
      await collectTree(root, realRoot, path, records);
      if (!sameSnapshot(metadata, await lstat(path))) throw new Error("RC_APP_CHANGED");
    } else if (metadata.isFile()) {
      records.push(await describeTreeFile(root, path, metadata));
    } else {
      throw new Error("RC_APP_SPECIAL_FILE_FORBIDDEN");
    }
  }
  if (!sameSnapshot(before, await lstat(directory))) throw new Error("RC_APP_CHANGED");
}

export async function describeAppTree(appPath, packagePath) {
  canonicalAbsolutePath(appPath, "RC_APP");
  if (!appPath.endsWith(".app")) throw new Error("RC_APP_PATH_INVALID");
  const rootMetadata = await lstat(appPath);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("RC_APP_ROOT_UNSAFE");
  }
  if ((await realpath(appPath)) !== appPath) throw new Error("RC_APP_PATH_INVALID");
  const records = [];
  await collectTree(appPath, appPath, appPath, records);
  if (!sameSnapshot(rootMetadata, await lstat(appPath))) throw new Error("RC_APP_CHANGED");
  const size = records.reduce(
    (total, record) => total + (record.type === "file" ? record.size_bytes : 0),
    0,
  );
  if (size < 1 || size > MAX_ARTIFACT_BYTES) throw new Error("RC_APP_SIZE_INVALID");
  return Object.freeze({
    entry_count: records.length,
    name: basename(appPath),
    path: packagePath,
    root_mode: rootMetadata.mode & 0o7777,
    size_bytes: size,
    tree_sha256: sha256(Buffer.from(JSON.stringify(records), "utf8")),
  });
}

export async function ensureRealDirectory(path, label) {
  canonicalAbsolutePath(path, label);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error(`${label}_DIRECTORY_UNSAFE`);
  }
}

export async function copySafeFile(source, destination, maximumBytes = MAX_ARTIFACT_BYTES) {
  canonicalAbsolutePath(source, "RC_COPY_SOURCE");
  if ((await realpath(source)) !== source) throw new Error("RC_COPY_SOURCE_PATH_INVALID");
  const before = await lstat(source);
  if (!validFile(before, maximumBytes, false)) throw new Error("RC_COPY_SOURCE_UNSAFE");
  await ensureRealDirectory(dirname(destination), "RC_COPY_PARENT");
  const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destinationHandle;
  try {
    const opened = await sourceHandle.stat();
    if (!sameSnapshot(before, opened)) throw new Error("RC_COPY_SOURCE_CHANGED");
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      before.mode & 0o777,
    );
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error("RC_COPY_SOURCE_CHANGED");
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
    const [afterHandle, afterPath] = await Promise.all([sourceHandle.stat(), lstat(source)]);
    if (!sameSnapshot(opened, afterHandle) || !sameSnapshot(afterHandle, afterPath)) {
      throw new Error("RC_COPY_SOURCE_CHANGED");
    }
  } finally {
    await sourceHandle.close();
    await destinationHandle?.close();
  }
  const [sourceDescription, destinationDescription] = await Promise.all([
    describeFile(source, "source", maximumBytes),
    describeFile(destination, "destination", maximumBytes),
  ]);
  if (
    sourceDescription.sha256 !== destinationDescription.sha256 ||
    sourceDescription.size_bytes !== destinationDescription.size_bytes
  ) {
    throw new Error("RC_COPY_MISMATCH");
  }
}

export async function copyAppTree(source, destination, execute) {
  const before = await describeAppTree(source, "source.app");
  await ensureRealDirectory(dirname(destination), "RC_COPY_PARENT");
  await execute("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", source, destination]);
  const [after, copied] = await Promise.all([
    describeAppTree(source, "source.app"),
    describeAppTree(destination, "destination.app"),
  ]);
  for (const key of ["entry_count", "root_mode", "size_bytes", "tree_sha256"]) {
    if (before[key] !== after[key] || before[key] !== copied[key]) {
      throw new Error("RC_APP_COPY_MISMATCH");
    }
  }
}

export function packagePath(root, relativePath) {
  const path = join(root, relativePath);
  if (!insideRoot(root, path) || path === root) throw new Error("RC_PACKAGE_PATH_INVALID");
  return path;
}
