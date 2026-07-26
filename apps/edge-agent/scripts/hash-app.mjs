import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readlink, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const APP_SUFFIX = ".app";
const HASH_ALGORITHM = "sha256";
const MODE_MASK = 0o7777;

function updateFrame(hash, value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function updateEntryHeader(hash, path, type, mode) {
  updateFrame(hash, "entry");
  updateFrame(hash, path);
  updateFrame(hash, type);
  updateFrame(hash, (mode & MODE_MASK).toString(8).padStart(4, "0"));
}

function isWithinRoot(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function hashFile(hash, absolutePath, relativePath, metadata) {
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error(`app tree changed while hashing: ${relativePath}`);
    }

    updateEntryHeader(hash, relativePath, "file", openedMetadata.mode);
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(openedMetadata.size));
    hash.update(length);
    for await (const chunk of createReadStream(absolutePath, {
      autoClose: false,
      fd: handle.fd,
    })) {
      hash.update(chunk);
    }

    const finalMetadata = await handle.stat();
    if (
      finalMetadata.size !== openedMetadata.size ||
      finalMetadata.mode !== openedMetadata.mode ||
      finalMetadata.mtimeMs !== openedMetadata.mtimeMs
    ) {
      throw new Error(`app tree changed while hashing: ${relativePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function assertSafeSymlink(appRoot, realAppRoot, absolutePath, target) {
  if (isAbsolute(target)) {
    throw new Error(`symbolic link must be relative: ${absolutePath}`);
  }

  const lexicalTarget = resolve(dirname(absolutePath), target);
  if (!isWithinRoot(appRoot, lexicalTarget)) {
    throw new Error(`symbolic link escapes the app tree: ${absolutePath}`);
  }

  let resolvedTarget;
  try {
    resolvedTarget = await realpath(absolutePath);
  } catch {
    throw new Error(`symbolic link target is unavailable: ${absolutePath}`);
  }
  if (!isWithinRoot(realAppRoot, resolvedTarget)) {
    throw new Error(`symbolic link escapes the app tree: ${absolutePath}`);
  }
}

async function hashEntry(hash, appRoot, realAppRoot, absolutePath, relativePath) {
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    await assertSafeSymlink(appRoot, realAppRoot, absolutePath, target);
    updateEntryHeader(hash, relativePath, "symlink", metadata.mode);
    updateFrame(hash, target);
    return;
  }
  if (metadata.isFile()) {
    await hashFile(hash, absolutePath, relativePath, metadata);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`unsupported app tree entry type: ${relativePath}`);
  }

  updateEntryHeader(hash, relativePath, "directory", metadata.mode);
  const names = await readdir(absolutePath);
  names.sort();
  for (const name of names) {
    const childPath = relativePath === "." ? name : `${relativePath}/${name}`;
    await hashEntry(hash, appRoot, realAppRoot, resolve(absolutePath, name), childPath);
  }
}

/**
 * Hash a stable macOS application tree. The digest covers normalized relative
 * paths, entry types, permission modes, file bytes and safe relative symlinks.
 */
export async function hashAppTree(appPath) {
  if (typeof appPath !== "string" || !isAbsolute(appPath)) {
    throw new Error("hashAppTree requires an absolute macOS app path");
  }
  const appRoot = resolve(appPath);
  if (!appRoot.endsWith(APP_SUFFIX)) {
    throw new Error("macOS app path must end in .app");
  }

  const rootMetadata = await lstat(appRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("macOS app root must be a real directory");
  }

  const realAppRoot = await realpath(appRoot);
  const hash = createHash(HASH_ALGORITHM);
  updateFrame(hash, "laundry-desk-app-tree-v1");
  await hashEntry(hash, appRoot, realAppRoot, appRoot, ".");
  return hash.digest("hex");
}

async function runCli() {
  const appPath = process.argv[2];
  if (process.argv.length !== 3 || appPath === undefined) {
    throw new Error("usage: node scripts/hash-app.mjs /absolute/path/to/application.app");
  }
  console.log(await hashAppTree(appPath));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown hashing error";
    console.error(`[hash:app] ${message}`);
    process.exitCode = 1;
  });
}
