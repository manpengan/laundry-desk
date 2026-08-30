import { createHash, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  flushDirectoryDurablySync,
  inspectPrivateDirectorySync,
  inspectPrivateFileSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
  type PrivateFileSecurity,
} from "@laundry/platform-fs";
import { z } from "zod";

import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";

const AuthorityTrustStateSchema = z.strictObject({
  version: z.literal(1),
  protected_fingerprint: z.base64(),
});

const PRIVATE_FILE_MODE = 0o600;
const MAX_STATE_BYTES = 64 * 1024;
const STAGING_ID = /^[0-9a-f]{24}$/u;

export type SafeStorageAuthorityTrustStoreOptions = Readonly<{
  randomStagingId?: () => string;
  /** Deterministic read-race seam; omitted by production. */
  afterReadBytes?: () => void;
}>;

export interface AuthorityTrustStore {
  accept(publicKey: KeyObject): boolean;
}

function fingerprint(publicKey: KeyObject): Buffer {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Edge authority trust requires an Ed25519 public key");
  }
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest();
}

function prepareRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("Authority trust root must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const meta = lstatSync(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new Error("Authority trust root must be a real directory");
  }
  securePrivateDirectorySync(path);
  const root = realpathSync(path);
  const canonical = lstatSync(root);
  if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
    throw new Error("Authority trust root must be private");
  }
  try {
    inspectPrivateDirectorySync(root);
  } catch (error) {
    throw new Error("Authority trust root must be private", { cause: error });
  }
  return root;
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Authority trust state escaped its private root");
  }
}

function assertPrivateStateFile(
  metadata: Readonly<{
    dev: number;
    ino: number;
    nlink: number;
    size: number;
    isFile: () => boolean;
  }>,
): void {
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_STATE_BYTES) {
    throw new Error("Invalid private authority trust state file");
  }
}

function sameFile(
  expected: Readonly<{ dev: number; ino: number }>,
  observed: Readonly<{ dev: number; ino: number }>,
): boolean {
  return expected.dev === observed.dev && expected.ino === observed.ino;
}

function sameSecurity(left: PrivateFileSecurity, right: PrivateFileSecurity): boolean {
  return left.scheme === right.scheme && left.descriptorSha256 === right.descriptorSha256;
}

function inspectPrivateStateFile(path: string): PrivateFileSecurity {
  try {
    return inspectPrivateFileSync(path);
  } catch (error) {
    throw new Error("Invalid private authority trust state file", { cause: error });
  }
}

function syncRoot(root: string): void {
  flushDirectoryDurablySync(root);
}

function writePrivateState(
  root: string,
  path: string,
  protectedFingerprint: Buffer,
  randomStagingId?: () => string,
): boolean {
  const serialized = `${JSON.stringify({
    version: 1,
    protected_fingerprint: protectedFingerprint.toString("base64"),
  })}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Protected authority trust state is too large");
  }
  const randomId = randomStagingId?.() ?? randomBytes(12).toString("hex");
  if (!STAGING_ID.test(randomId)) throw new Error("Invalid authority trust staging id");
  const staging = join(root, `.authority-trust.json.${randomId}.staging`);
  assertContained(root, staging);
  let fd: number | null = null;
  let createdStaging = false;
  try {
    fd = openSync(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    createdStaging = true;
    securePrivateFileSync(staging);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(staging, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    } finally {
      unlinkSync(staging);
      createdStaging = false;
      syncRoot(root);
    }
    inspectPrivateStateFile(path);
    return true;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    if (createdStaging) {
      try {
        unlinkSync(staging);
        syncRoot(root);
      } catch {
        // Preserve the original write error.
      }
    }
    throw error;
  }
}

function readPrivateState(
  path: string,
  afterReadBytes?: () => void,
): z.output<typeof AuthorityTrustStateSchema> | null {
  let expected;
  try {
    expected = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (expected.isSymbolicLink()) throw new Error("Authority trust state cannot be a symlink");
  assertPrivateStateFile(expected);
  const securityBefore = inspectPrivateStateFile(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertPrivateStateFile(opened);
    if (!sameFile(expected, opened)) throw new Error("Authority trust state changed before open");
    const bytes = readFileSync(fd);
    afterReadBytes?.();
    const final = fstatSync(fd);
    assertPrivateStateFile(final);
    if (
      !sameFile(opened, final) ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      bytes.byteLength !== final.size
    ) {
      throw new Error("Authority trust state changed while reading");
    }
    const pathAfter = lstatSync(path);
    if (pathAfter.isSymbolicLink()) throw new Error("Authority trust state cannot be a symlink");
    assertPrivateStateFile(pathAfter);
    if (
      !sameFile(final, pathAfter) ||
      pathAfter.size !== final.size ||
      pathAfter.mtimeMs !== final.mtimeMs
    ) {
      throw new Error("Authority trust state path changed while reading");
    }
    const securityAfter = inspectPrivateStateFile(path);
    if (!sameSecurity(securityBefore, securityAfter)) {
      throw new Error("Authority trust state security changed while reading");
    }
    return AuthorityTrustStateSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  } finally {
    closeSync(fd);
  }
}

/** Process-local trust-on-first-use adapter for focused tests. */
export class MemoryAuthorityTrustStore implements AuthorityTrustStore {
  private pinned: Buffer | null = null;

  accept(publicKey: KeyObject): boolean {
    const candidate = fingerprint(publicKey);
    if (this.pinned === null) {
      this.pinned = Buffer.from(candidate);
      return true;
    }
    return timingSafeEqual(this.pinned, candidate);
  }
}

/** OS-protected, device-local pin for the stable server authority signer. */
export class SafeStorageAuthorityTrustStore implements AuthorityTrustStore {
  private readonly root: string;
  private readonly path: string;

  constructor(
    rootPath: string,
    private readonly safeStorage: SafeStorageSurface,
    private readonly options: SafeStorageAuthorityTrustStoreOptions = {},
  ) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS protected storage encryption is unavailable");
    }
    this.root = prepareRoot(rootPath);
    this.path = join(this.root, "authority-trust.json");
    assertContained(this.root, this.path);
  }

  accept(publicKey: KeyObject): boolean {
    const candidate = fingerprint(publicKey);
    let state = readPrivateState(this.path, this.options.afterReadBytes);
    if (state === null) {
      const created = writePrivateState(
        this.root,
        this.path,
        this.safeStorage.encryptString(candidate.toString("base64")),
        this.options.randomStagingId,
      );
      if (created) return true;
      state = readPrivateState(this.path, this.options.afterReadBytes);
      if (state === null) throw new Error("Authority trust state disappeared during pinning");
    }
    const pinned = Buffer.from(
      this.safeStorage.decryptString(Buffer.from(state.protected_fingerprint, "base64")),
      "base64",
    );
    return pinned.byteLength === candidate.byteLength && timingSafeEqual(pinned, candidate);
  }
}
