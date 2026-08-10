import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";

import { fail } from "./hk-vps-release-core.mjs";

function decodeUtf8(buffer, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    fail(code, error);
  }
}

export async function readPrivateFile(path, options) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) fail(options.code);
  if (!Number.isInteger(constants.O_NOFOLLOW)) fail(options.code);
  const canonical = await realpath(path).catch(() => null);
  if (canonical !== path) fail(options.code);
  let handle;
  let buffer;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== options.uid ||
      (options.gid !== undefined && metadata.gid !== options.gid) ||
      (metadata.mode & 0o7777) !== 0o600 ||
      metadata.size < 1 ||
      metadata.size > options.maximumBytes
    ) {
      fail(options.code);
    }
    buffer = await handle.readFile();
    if (buffer.byteLength !== metadata.size) fail(options.code);
    return decodeUtf8(buffer, options.code);
  } catch (error) {
    if (error?.code === options.code) throw error;
    fail(options.code, error);
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

function exactBytes(left, right) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  try {
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  } finally {
    leftBuffer.fill(0);
    rightBuffer.fill(0);
  }
}

async function syncDirectory(path, code) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isDirectory()) fail(code);
    await handle.sync();
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeStaleFiles(path, options) {
  const directory = dirname(path);
  const prefix = `.${basename(path)}.tmp-`;
  let removed = false;
  const names = await readdir(directory).catch((error) => fail(options.code, error));
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^[0-9a-f]{32}$/u.test(name.slice(prefix.length))) continue;
    const stalePath = join(directory, name);
    const metadata = await lstat(stalePath).catch((error) => fail(options.code, error));
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== options.uid ||
      metadata.gid !== options.gid ||
      (metadata.mode & 0o7177) !== 0 ||
      metadata.size > options.maximumBytes
    ) {
      fail(options.code);
    }
    await unlink(stalePath).catch((error) => fail(options.code, error));
    removed = true;
  }
  if (removed) await syncDirectory(directory, options.code);
  return Object.freeze({ directory, prefix });
}

async function verifyExactFile(path, value, options) {
  const existing = await readPrivateFile(path, options);
  if (!exactBytes(existing, value)) fail(options.mismatchCode);
}

export async function writeOrVerifyPrivateFile(path, value, options) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) fail(options.code);
  if (!Number.isInteger(constants.O_NOFOLLOW)) fail(options.code);
  const { directory, prefix } = await removeStaleFiles(path, options);
  const temporaryPath = join(directory, `${prefix}${randomBytes(16).toString("hex")}`);
  let handle;
  let created = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(value, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await verifyExactFile(temporaryPath, value, options);
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        fail(options.code, error);
      }
      await verifyExactFile(path, value, options);
    }
  } catch (error) {
    if (error?.code === options.code || error?.code === options.mismatchCode) throw error;
    fail(options.code, error);
  } finally {
    await handle?.close().catch(() => undefined);
    if (created) {
      await unlink(temporaryPath).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          fail(options.code, error);
        }
      });
      await syncDirectory(directory, options.code);
    }
  }
}
