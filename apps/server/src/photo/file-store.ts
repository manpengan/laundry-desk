/**
 * Private local photo file store.
 *
 * Names are server-generated, writes are atomic/no-replace, and every read or
 * rollback revalidates the regular file plus its SHA-256 digest.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { flushDirectoryDurably, inspectPrivateFile, securePrivateFile } from "@laundry/platform-fs";

import { PhotoFileError } from "./file-store-error.js";
import { securePhotoStoreRoot } from "./file-store-root.js";

export { PhotoFileError } from "./file-store-error.js";
export const DEFAULT_MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_PHOTO_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_PHOTO_FILES = 10_000;
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1_000;

const FILE_MODE = 0o600;
const STORAGE_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/u;
const STORAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STAGING_NAME = /^\.[0-9a-f-]{36}\.(?:jpg|png|webp)\.[0-9a-f-]{36}\.staging$/u;

export type PhotoContentType = "image/jpeg" | "image/png" | "image/webp";

export type StoredPhoto = Readonly<{
  storage_key: string;
  content_type: PhotoContentType;
  content_sha256: string;
  byte_size: number;
}>;

export type PhotoFile = StoredPhoto & Readonly<{ bytes: Buffer }>;

export type PhotoFileSweep = Readonly<{
  removed: number;
  removed_bytes: number;
  retained: number;
  retained_bytes: number;
}>;

export type PhotoFileStore = Readonly<{
  rootPath: string;
  write: (bytes: Buffer, declaredType: string, storageId?: string) => Promise<StoredPhoto>;
  read: (metadata: StoredPhoto) => Promise<PhotoFile>;
  remove: (storageKey: string, expectedSha256: string) => Promise<boolean>;
  sweepOrphans: (referencedKeys: ReadonlySet<string>, nowMs?: number) => Promise<PhotoFileSweep>;
}>;

export type PhotoFileStoreOptions = Readonly<{
  rootPath: string;
  maxPhotoBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  orphanGraceMs?: number;
  newId?: () => string;
}>;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function detectedType(bytes: Buffer): PhotoContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function extension(contentType: PhotoContentType): "jpg" | "png" | "webp" {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  return "webp";
}

function assertContained(rootPath: string, candidate: string): void {
  const path = relative(rootPath, candidate);
  if (path === "" || path.startsWith("..") || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new PhotoFileError("PHOTO_PATH_ESCAPE", "photo path escaped its private root");
  }
}

function pathFor(rootPath: string, storageKey: string): string {
  if (!STORAGE_KEY.test(storageKey)) {
    throw new PhotoFileError("PHOTO_STORAGE_KEY_INVALID", "photo storage key is invalid");
  }
  const path = join(rootPath, storageKey);
  assertContained(rootPath, path);
  return path;
}

async function inspectOwned(rootPath: string) {
  const entries: Array<Readonly<{ name: string; bytes: number; mtimeMs: number }>> = [];
  for (const name of await readdir(rootPath)) {
    if (!STORAGE_KEY.test(name) && !STAGING_NAME.test(name)) continue;
    const metadata = await lstat(join(rootPath, name)).catch(() => null);
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) continue;
    if ((await inspectPrivateFile(join(rootPath, name)).catch(() => null)) === null) continue;
    entries.push(Object.freeze({ name, bytes: metadata.size, mtimeMs: metadata.mtimeMs }));
  }
  return Object.freeze(entries);
}

async function stage(
  rootPath: string,
  storageKey: string,
  bytes: Buffer,
  newId: () => string,
): Promise<string> {
  const path = join(rootPath, `.${storageKey}.${newId()}.staging`);
  assertContained(rootPath, path);
  try {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      FILE_MODE,
    );
    try {
      await securePrivateFile(path);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await inspectPrivateFile(path);
    return path;
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function readRegularPhoto(path: string) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PhotoFileError("PHOTO_FILE_UNAVAILABLE", "photo file is unavailable");
  }
  try {
    await inspectPrivateFile(path);
  } catch {
    throw new PhotoFileError("PHOTO_FILE_UNAVAILABLE", "photo file is unavailable");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    () => null,
  );
  if (handle === null) {
    throw new PhotoFileError("PHOTO_FILE_UNAVAILABLE", "photo file is unavailable");
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw new PhotoFileError("PHOTO_FILE_UNAVAILABLE", "photo file changed while opening");
    }
    const bytes = await handle.readFile();
    const current = await lstat(path).catch(() => null);
    if (
      current === null ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size
    ) {
      throw new PhotoFileError("PHOTO_FILE_UNAVAILABLE", "photo file changed while reading");
    }
    await inspectPrivateFile(path).catch(() => {
      throw new PhotoFileError("PHOTO_FILE_UNAVAILABLE", "photo file changed while reading");
    });
    return Object.freeze({
      bytes,
      device: opened.dev,
      inode: opened.ino,
    });
  } finally {
    await handle.close();
  }
}

async function readVerified(path: string, expectedBytes: number, expectedSha256: string) {
  const opened = await readRegularPhoto(path);
  if (opened.bytes.byteLength !== expectedBytes) {
    throw new PhotoFileError("PHOTO_FILE_UNAVAILABLE", "photo file is unavailable");
  }
  if (sha256(opened.bytes) !== expectedSha256) {
    throw new PhotoFileError("PHOTO_FILE_INTEGRITY", "photo file integrity check failed");
  }
  return opened.bytes;
}

async function removeVerified(path: string, expectedSha256: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null) return false;
  const opened = await readRegularPhoto(path);
  if (sha256(opened.bytes) !== expectedSha256) {
    throw new PhotoFileError("PHOTO_FILE_INTEGRITY", "photo rollback target changed");
  }
  const current = await lstat(path).catch(() => null);
  if (
    current === null ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== opened.device ||
    current.ino !== opened.inode
  ) {
    throw new PhotoFileError("PHOTO_FILE_UNAVAILABLE", "photo rollback target changed");
  }
  await unlink(path);
  return true;
}

export async function createPhotoFileStore(
  options: PhotoFileStoreOptions,
): Promise<PhotoFileStore> {
  if (!isAbsolute(options.rootPath)) {
    throw new PhotoFileError("PHOTO_ROOT_RELATIVE", "photo root must be absolute");
  }
  const rootPath = await securePhotoStoreRoot(options.rootPath);
  const maxPhotoBytes = options.maxPhotoBytes ?? DEFAULT_MAX_PHOTO_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_PHOTO_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_PHOTO_FILES;
  const orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const newId = options.newId ?? randomUUID;
  let writeTail: Promise<void> = Promise.resolve();

  const serializeWrite = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = writeTail;
    let release = (): void => undefined;
    writeTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return Object.freeze({
    rootPath,
    write: (bytes: Buffer, declaredType: string, storageId?: string) =>
      serializeWrite(async () => {
        if (bytes.byteLength < 1 || bytes.byteLength > maxPhotoBytes) {
          throw new PhotoFileError("PHOTO_SIZE_INVALID", "photo exceeds its per-file byte limit");
        }
        const contentType = detectedType(bytes);
        if (contentType === null || contentType !== declaredType) {
          throw new PhotoFileError("PHOTO_TYPE_INVALID", "photo bytes do not match content type");
        }
        if (storageId !== undefined && !STORAGE_ID.test(storageId)) {
          throw new PhotoFileError("PHOTO_STORAGE_KEY_INVALID", "photo upload id is invalid");
        }
        const storageKey = `${storageId ?? newId()}.${extension(contentType)}`;
        const finalPath = pathFor(rootPath, storageKey);
        const existing = await lstat(finalPath).catch(() => null);
        if (existing !== null) {
          const opened = await readRegularPhoto(finalPath);
          if (
            opened.bytes.byteLength !== bytes.byteLength ||
            sha256(opened.bytes) !== sha256(bytes) ||
            detectedType(opened.bytes) !== contentType
          ) {
            throw new PhotoFileError(
              "PHOTO_IDEMPOTENCY_CONFLICT",
              "photo upload id is already bound to different bytes",
            );
          }
          return Object.freeze({
            storage_key: storageKey,
            content_type: contentType,
            content_sha256: sha256(bytes),
            byte_size: bytes.byteLength,
          });
        }
        const entries = await inspectOwned(rootPath);
        const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        if (entries.length >= maxFiles || totalBytes + bytes.byteLength > maxTotalBytes) {
          throw new PhotoFileError("PHOTO_QUOTA_EXCEEDED", "photo store quota exceeded");
        }
        const temporaryPath = await stage(rootPath, storageKey, bytes, newId);
        try {
          await link(temporaryPath, finalPath);
          await unlink(temporaryPath);
          await inspectPrivateFile(finalPath);
          await flushDirectoryDurably(rootPath);
        } catch (error) {
          await unlink(temporaryPath).catch(() => undefined);
          throw error;
        }
        return Object.freeze({
          storage_key: storageKey,
          content_type: contentType,
          content_sha256: sha256(bytes),
          byte_size: bytes.byteLength,
        });
      }),
    read: async (metadata: StoredPhoto) => {
      const bytes = await readVerified(
        pathFor(rootPath, metadata.storage_key),
        metadata.byte_size,
        metadata.content_sha256,
      );
      if (detectedType(bytes) !== metadata.content_type) {
        throw new PhotoFileError("PHOTO_FILE_INTEGRITY", "photo content type no longer matches");
      }
      return Object.freeze({ ...metadata, bytes });
    },
    remove: async (storageKey: string, expectedSha256: string) => {
      const path = pathFor(rootPath, storageKey);
      const removed = await removeVerified(path, expectedSha256);
      if (!removed) return false;
      await flushDirectoryDurably(rootPath);
      return true;
    },
    sweepOrphans: async (referencedKeys: ReadonlySet<string>, nowMs = Date.now()) =>
      serializeWrite(async () => {
        const entries = await inspectOwned(rootPath);
        let removed = 0;
        let removedBytes = 0;
        let retained = 0;
        let retainedBytes = 0;
        for (const entry of entries) {
          const isReferenced = STORAGE_KEY.test(entry.name) && referencedKeys.has(entry.name);
          if (!isReferenced && nowMs - entry.mtimeMs >= orphanGraceMs) {
            await unlink(join(rootPath, entry.name));
            removed += 1;
            removedBytes += entry.bytes;
          } else {
            retained += 1;
            retainedBytes += entry.bytes;
          }
        }
        if (removed > 0) await flushDirectoryDurably(rootPath);
        return Object.freeze({
          removed,
          removed_bytes: removedBytes,
          retained,
          retained_bytes: retainedBytes,
        });
      }),
  });
}
