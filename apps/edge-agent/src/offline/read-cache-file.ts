import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  flushDirectoryDurablySync,
  inspectPrivateDirectorySync,
  inspectPrivateFileSync,
  replaceFileWriteThroughSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
  type PrivateFileSecurity,
} from "@laundry/platform-fs";
import { z } from "zod";

import { decryptAes256Gcm, encryptAes256Gcm } from "../queue/crypto.js";
import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";

const CACHE_AAD = Buffer.from("laundry.edge.offline-read-cache.v1", "utf8");
const MAX_CACHE_FILE_BYTES = 4 * 1_024 * 1_024;
export const MAX_CACHE_PLAINTEXT_BYTES = 3 * 1_024 * 1_024;

const CacheFileSchema = z.strictObject({
  version: z.literal(1),
  protected_key: z.base64(),
  nonce: z.base64(),
  ciphertext: z.base64(),
  auth_tag: z.base64(),
});
const STAGING_NAME = /^\.offline-read-cache\.[a-f0-9]{24}\.staging$/u;

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Offline read cache escaped its private root");
  }
}

function preparePrivateRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("Offline read cache root must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const meta = lstatSync(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new Error("Offline read cache root must be a real directory");
  }
  securePrivateDirectorySync(path);
  const root = realpathSync(path);
  inspectPrivateDirectorySync(root);
  return root;
}

type CacheMetadata = Readonly<{
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}>;

function assertPrivateCacheFile(metadata: CacheMetadata): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > MAX_CACHE_FILE_BYTES
  ) {
    throw new Error("Invalid offline read cache file");
  }
}

function sameFile(left: CacheMetadata, right: CacheMetadata): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameSecurity(left: PrivateFileSecurity, right: PrivateFileSecurity): boolean {
  return left.scheme === right.scheme && left.descriptorSha256 === right.descriptorSha256;
}

function inspectCacheFile(path: string): PrivateFileSecurity {
  try {
    return inspectPrivateFileSync(path);
  } catch (error) {
    throw new Error("Invalid offline read cache file", { cause: error });
  }
}

export class OfflineReadCacheFile {
  private readonly root: string;
  private readonly path: string;

  constructor(
    rootPath: string,
    private readonly safeStorage: SafeStorageSurface,
  ) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS protected storage encryption is unavailable");
    }
    this.root = preparePrivateRoot(rootPath);
    this.path = join(this.root, "offline-read-cache.json");
    assertContained(this.root, this.path);
    this.cleanupInterruptedWrites();
  }

  read(): unknown | null {
    if (!existsSync(this.path)) return null;
    const expected = lstatSync(this.path);
    assertPrivateCacheFile(expected);
    const securityBefore = inspectCacheFile(this.path);
    const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      assertPrivateCacheFile(opened);
      if (!sameFile(expected, opened)) throw new Error("Invalid offline read cache file");
      bytes = readFileSync(fd);
      const final = fstatSync(fd);
      const pathAfter = lstatSync(this.path);
      assertPrivateCacheFile(final);
      assertPrivateCacheFile(pathAfter);
      const securityAfter = inspectCacheFile(this.path);
      if (
        !sameFile(opened, final) ||
        !sameFile(final, pathAfter) ||
        bytes.byteLength !== final.size ||
        !sameSecurity(securityBefore, securityAfter)
      ) {
        throw new Error("Invalid offline read cache file");
      }
    } finally {
      closeSync(fd);
    }
    const file = CacheFileSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    const keyText = this.safeStorage.decryptString(Buffer.from(file.protected_key, "base64"));
    const key = Buffer.from(keyText, "base64");
    try {
      const plaintext = decryptAes256Gcm(
        key,
        {
          nonce: Buffer.from(file.nonce, "base64"),
          ciphertext: Buffer.from(file.ciphertext, "base64"),
          authTag: Buffer.from(file.auth_tag, "base64"),
        },
        CACHE_AAD,
      );
      try {
        if (plaintext.byteLength > MAX_CACHE_PLAINTEXT_BYTES) {
          throw new Error("Offline read cache plaintext is too large");
        }
        return JSON.parse(plaintext.toString("utf8")) as unknown;
      } finally {
        plaintext.fill(0);
      }
    } finally {
      key.fill(0);
    }
  }

  write(value: unknown): void {
    this.assertWritableDestination();
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    if (plaintext.byteLength > MAX_CACHE_PLAINTEXT_BYTES) {
      throw new Error("Offline read cache exceeds its size limit");
    }
    const key = randomBytes(32);
    try {
      const sealed = encryptAes256Gcm(key, plaintext, CACHE_AAD);
      const protectedKey = this.safeStorage.encryptString(key.toString("base64"));
      const file = CacheFileSchema.parse({
        version: 1,
        protected_key: protectedKey.toString("base64"),
        nonce: sealed.nonce.toString("base64"),
        ciphertext: sealed.ciphertext.toString("base64"),
        auth_tag: sealed.authTag.toString("base64"),
      });
      this.atomicWrite(file);
    } finally {
      key.fill(0);
      plaintext.fill(0);
    }
  }

  clear(): void {
    if (!existsSync(this.path)) return;
    const meta = lstatSync(this.path);
    assertPrivateCacheFile(meta);
    inspectCacheFile(this.path);
    unlinkSync(this.path);
    this.syncRoot();
  }

  private assertWritableDestination(): void {
    if (!existsSync(this.path)) return;
    const meta = lstatSync(this.path);
    assertPrivateCacheFile(meta);
    inspectCacheFile(this.path);
  }

  private cleanupInterruptedWrites(): void {
    let removed = false;
    for (const name of readdirSync(this.root)) {
      if (!STAGING_NAME.test(name)) continue;
      const staging = join(this.root, name);
      assertContained(this.root, staging);
      const meta = lstatSync(staging);
      try {
        assertPrivateCacheFile(meta);
        inspectPrivateFileSync(staging);
      } catch (error) {
        throw new Error("Invalid offline read cache staging file", { cause: error });
      }
      unlinkSync(staging);
      removed = true;
    }
    if (removed) this.syncRoot();
  }

  private atomicWrite(file: z.output<typeof CacheFileSchema>): void {
    const staging = join(
      this.root,
      `.offline-read-cache.${randomBytes(12).toString("hex")}.staging`,
    );
    assertContained(this.root, staging);
    const fd = openSync(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      securePrivateFileSync(staging);
      writeFileSync(fd, `${JSON.stringify(file)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    replaceFileWriteThroughSync(staging, this.path);
    this.syncRoot();
  }

  private syncRoot(): void {
    flushDirectoryDurablySync(this.root);
  }
}
