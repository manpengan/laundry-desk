import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/u;

function validFileMetadata(metadata, maximumBytes, requiredMode) {
  const mode = metadata.mode & 0o777;
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.size >= 1 &&
    metadata.size <= maximumBytes &&
    (requiredMode === undefined ? (mode & 0o022) === 0 : mode === requiredMode)
  );
}

export async function readBoundedRealFile(
  path,
  label,
  maximumBytes,
  { requiredMode, afterOpen } = {},
) {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(`${label} path must be canonical`);
  const metadata = await lstat(path);
  if (!validFileMetadata(metadata, maximumBytes, requiredMode)) {
    throw new Error(`${label} metadata is unsafe`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!validFileMetadata(opened, maximumBytes, requiredMode) || !sameSnapshot(metadata, opened)) {
      throw new Error(`${label} changed while opening`);
    }
    await afterOpen?.();
    const bytes = await handle.readFile();
    const [final, pathFinal] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      bytes.byteLength !== opened.size ||
      !validFileMetadata(final, maximumBytes, requiredMode) ||
      !validFileMetadata(pathFinal, maximumBytes, requiredMode) ||
      !sameSnapshot(opened, final) ||
      !sameSnapshot(final, pathFinal)
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function describeReleaseArtifact(path, kind) {
  const metadata = await lstat(path);
  if (!validFileMetadata(metadata, Number.MAX_SAFE_INTEGER, undefined)) {
    throw new Error("release artifact is unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !validFileMetadata(opened, Number.MAX_SAFE_INTEGER, undefined) ||
      !sameSnapshot(metadata, opened)
    ) {
      throw new Error("release artifact changed while opening");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { autoClose: false, fd: handle.fd }))
      hash.update(chunk);
    const [final, pathFinal] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameSnapshot(opened, final) || !sameSnapshot(final, pathFinal)) {
      throw new Error("release artifact changed while hashing");
    }
    return Object.freeze({
      kind,
      name: basename(path),
      size_bytes: opened.size,
      sha256: hash.digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

function insideRoot(root, candidate) {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sameSnapshot(left, right) {
  return ["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].every(
    (key) => left[key] === right[key],
  );
}

async function describeFile(root, path, metadata) {
  if (metadata.nlink !== 1) throw new Error("application tree contains a hard-linked file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameSnapshot(metadata, opened)) {
      throw new Error("application tree file changed while opening");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { autoClose: false, fd: handle.fd })) {
      hash.update(chunk);
    }
    const [final, pathFinal] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameSnapshot(opened, final) || !sameSnapshot(final, pathFinal)) {
      throw new Error("application tree file changed while hashing");
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

async function describeLink(root, realRoot, path, metadata) {
  const target = await readlink(path);
  if (isAbsolute(target)) throw new Error("application tree contains an absolute symlink");
  if (!insideRoot(root, resolve(dirname(path), target))) {
    throw new Error("application tree symlink escapes its root");
  }
  let resolvedTarget;
  try {
    resolvedTarget = await realpath(path);
  } catch {
    throw new Error("application tree contains a broken symlink");
  }
  if (!insideRoot(realRoot, resolvedTarget)) {
    throw new Error("application tree symlink escapes its root");
  }
  const final = await lstat(path);
  if (!sameSnapshot(metadata, final))
    throw new Error("application tree symlink changed while reading");
  return Object.freeze({
    path: relative(root, path),
    type: "symlink",
    mode: metadata.mode & 0o7777,
    target,
  });
}

async function collectEntries(root, realRoot, directory, records) {
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      records.push(await describeLink(root, realRoot, path, metadata));
    } else if (metadata.isDirectory()) {
      records.push(
        Object.freeze({
          path: relative(root, path),
          type: "directory",
          mode: metadata.mode & 0o7777,
        }),
      );
      await collectEntries(root, realRoot, path, records);
      const final = await lstat(path);
      if (!sameSnapshot(metadata, final)) {
        throw new Error("application tree directory changed while hashing");
      }
    } else if (metadata.isFile()) {
      records.push(await describeFile(root, path, metadata));
    } else {
      throw new Error("application tree contains an unsupported filesystem entry");
    }
  }
}

export async function describeCanonicalAppTree(appPath) {
  if (!isAbsolute(appPath) || resolve(appPath) !== appPath) {
    throw new Error("application tree path must be canonical");
  }
  const rootMetadata = await lstat(appPath);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("application tree root must be a real directory");
  }
  const realRoot = await realpath(appPath);
  const records = [];
  await collectEntries(appPath, realRoot, appPath, records);
  const finalRoot = await lstat(appPath);
  if (!sameSnapshot(rootMetadata, finalRoot)) {
    throw new Error("application tree root changed while hashing");
  }
  const totalBytes = records.reduce(
    (total, record) => total + (record.type === "file" ? record.size_bytes : 0),
    0,
  );
  return Object.freeze({
    name: basename(appPath),
    root_mode: rootMetadata.mode & 0o7777,
    entry_count: records.length,
    size_bytes: totalBytes,
    tree_sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  });
}

async function sealPermissions(path) {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink()) return;
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new Error("release tree contains an unsupported filesystem entry");
  }
  if (metadata.isFile() && metadata.nlink !== 1n) {
    throw new Error("release tree contains a hard-linked file");
  }
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (metadata.isDirectory() ? (constants.O_DIRECTORY ?? 0) : 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    const version = (value) =>
      ["dev", "ino", "size", "mode", "nlink", "mtimeNs", "ctimeNs"].map((key) =>
        value[key].toString(),
      );
    if (JSON.stringify(version(metadata)) !== JSON.stringify(version(opened))) {
      throw new Error("release tree entry changed while sealing");
    }
    if (opened.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await sealPermissions(join(path, name));
    }
    const current = await lstat(path, { bigint: true });
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("release tree entry changed while sealing");
    }
    const sealedMode = current.mode & 0o555n;
    await handle.chmod(Number(sealedMode));
    const [sealedHandle, sealedPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      JSON.stringify(version(sealedHandle)) !== JSON.stringify(version(sealedPath)) ||
      sealedHandle.dev !== current.dev ||
      sealedHandle.ino !== current.ino ||
      sealedHandle.nlink !== current.nlink ||
      sealedHandle.size !== current.size ||
      sealedHandle.mtimeNs !== current.mtimeNs ||
      (sealedHandle.mode & 0o777n) !== sealedMode
    ) {
      throw new Error("release tree entry changed while sealing");
    }
  } finally {
    await handle.close();
  }
}

export async function sealReleaseTreePermissions(paths) {
  for (const path of paths) await sealPermissions(path);
}

function metadataVersion(metadata) {
  return Object.freeze({
    ctime_ns: metadata.ctimeNs.toString(),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    mtime_ns: metadata.mtimeNs.toString(),
    nlink: metadata.nlink.toString(),
    size: metadata.size.toString(),
  });
}

async function collectTreeVersions(root, path, records) {
  const before = await lstat(path, { bigint: true });
  const name = relative(root, path) || ".";
  if (before.isSymbolicLink()) {
    records.push(
      Object.freeze({
        name,
        type: "symlink",
        target: await readlink(path),
        version: metadataVersion(before),
      }),
    );
    return;
  }
  if (name !== "." && (before.mode & 0o222n) !== 0n) {
    throw new Error("release tree entry remains writable after sealing");
  }
  if (!before.isDirectory() && !before.isFile()) {
    throw new Error("release tree contains an unsupported filesystem entry");
  }
  if (before.isFile() && before.nlink !== 1n) {
    throw new Error("release tree contains a hard-linked file");
  }
  records.push(
    Object.freeze({
      name,
      type: before.isDirectory() ? "directory" : "file",
      version: metadataVersion(before),
    }),
  );
  if (before.isDirectory()) {
    for (const child of (await readdir(path)).sort()) {
      await collectTreeVersions(root, join(path, child), records);
    }
  }
  const after = await lstat(path, { bigint: true });
  if (JSON.stringify(metadataVersion(before)) !== JSON.stringify(metadataVersion(after))) {
    throw new Error("release tree changed while binding the commit object");
  }
}

export async function createReleaseTreeVersion(root) {
  const records = [];
  await collectTreeVersions(root, root, records);
  return Object.freeze(records);
}

export async function assertReleaseTreeVersion(root, expected) {
  const current = await createReleaseTreeVersion(root);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("release tree changed after final verification");
  }
}

export function isCanonicalAppTreeDescriptor(candidate) {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    typeof candidate.name === "string" &&
    candidate.name.endsWith(".app") &&
    Number.isSafeInteger(candidate.root_mode) &&
    candidate.root_mode >= 0 &&
    candidate.root_mode <= 0o7777 &&
    Number.isSafeInteger(candidate.entry_count) &&
    candidate.entry_count >= 1 &&
    Number.isSafeInteger(candidate.size_bytes) &&
    candidate.size_bytes >= 1 &&
    typeof candidate.tree_sha256 === "string" &&
    SHA256.test(candidate.tree_sha256)
  );
}
