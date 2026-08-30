import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync,
  fstatSync,
  fsyncSync,
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
  replaceFileWriteThroughSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
  type PrivateFileSecurity,
} from "@laundry/platform-fs";
import { z } from "zod";

import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import {
  exportPrivateKeyPkcs8Base64Url,
  generateEd25519Material,
  importPrivateKeyPkcs8Base64Url,
  type DeviceKeyMaterial,
  type DeviceKeyStore,
} from "./device-keys.js";

const DeviceKeyStateSchema = z.strictObject({
  version: z.literal(1),
  protected_private_key: z.base64(),
});

const PRIVATE_FILE_MODE = 0o600;
const MAX_STATE_BYTES = 64 * 1024;
const STAGING_ID = /^[0-9a-f]{24}$/u;

export type SafeStorageDeviceKeyStoreOptions = Readonly<{
  randomStagingId?: () => string;
  /** Deterministic race seam; omitted by production. */
  afterReadBytes?: () => void;
  /** Deterministic clear-race seam; omitted by production. */
  beforeClearRevalidate?: () => void;
}>;

function prepareRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("Device key root must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const meta = lstatSync(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new Error("Device key root must be a real directory");
  }
  securePrivateDirectorySync(path);
  const root = realpathSync(path);
  const canonical = lstatSync(root);
  if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
    throw new Error("Device key root must be private");
  }
  try {
    inspectPrivateDirectorySync(root);
  } catch (error) {
    throw new Error("Device key root must be private", { cause: error });
  }
  return root;
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Device key state escaped its private root");
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
    throw new Error("Invalid private device key state file");
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
    throw new Error("Invalid private device key state file", { cause: error });
  }
}

function syncRoot(root: string): void {
  flushDirectoryDurablySync(root);
}

function writePrivateState(
  root: string,
  path: string,
  protectedKey: Buffer,
  randomStagingId?: () => string,
): void {
  const serialized = `${JSON.stringify({
    version: 1,
    protected_private_key: protectedKey.toString("base64"),
  })}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Protected device key state is too large");
  }
  const randomId = randomStagingId?.() ?? randomBytes(12).toString("hex");
  if (!STAGING_ID.test(randomId)) throw new Error("Invalid device key staging id");
  const staging = join(root, `.device-signing-key.json.${randomId}.staging`);
  assertContained(root, staging);
  let fd: number | null = null;
  let created = false;
  let renamed = false;
  try {
    fd = openSync(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    created = true;
    securePrivateFileSync(staging);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    replaceFileWriteThroughSync(staging, path);
    renamed = true;
    syncRoot(root);
    inspectPrivateStateFile(path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    if (created && !renamed) {
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

type ReadPrivateState = Readonly<{
  state: z.output<typeof DeviceKeyStateSchema>;
  identity: Readonly<{ dev: number; ino: number }>;
}>;

function readPrivateState(path: string, afterReadBytes?: () => void): ReadPrivateState | null {
  let expected;
  try {
    expected = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (expected.isSymbolicLink()) throw new Error("Device key state cannot be a symlink");
  assertPrivateStateFile(expected);
  const securityBefore = inspectPrivateStateFile(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertPrivateStateFile(opened);
    if (!sameFile(expected, opened)) throw new Error("Device key state changed before open");
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
      throw new Error("Device key state changed while reading");
    }
    const pathAfter = lstatSync(path);
    if (pathAfter.isSymbolicLink()) throw new Error("Device key state cannot be a symlink");
    assertPrivateStateFile(pathAfter);
    if (
      !sameFile(final, pathAfter) ||
      pathAfter.size !== final.size ||
      pathAfter.mtimeMs !== final.mtimeMs
    ) {
      throw new Error("Device key state path changed while reading");
    }
    const securityAfter = inspectPrivateStateFile(path);
    if (!sameSecurity(securityBefore, securityAfter)) {
      throw new Error("Device key state security changed while reading");
    }
    return Object.freeze({
      state: DeviceKeyStateSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown),
      identity: Object.freeze({ dev: final.dev, ino: final.ino }),
    });
  } finally {
    closeSync(fd);
  }
}

/** Ed25519 private key encrypted by Electron safeStorage (OS protected storage). */
export class SafeStorageDeviceKeyStore implements DeviceKeyStore {
  private readonly root: string;
  private readonly path: string;
  private readonly safeStorage: SafeStorageSurface;
  private readonly options: SafeStorageDeviceKeyStoreOptions;

  constructor(
    rootPath: string,
    safeStorage: SafeStorageSurface,
    options: SafeStorageDeviceKeyStoreOptions = {},
  ) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS protected storage encryption is unavailable");
    }
    this.root = prepareRoot(rootPath);
    this.path = join(this.root, "device-signing-key.json");
    assertContained(this.root, this.path);
    this.safeStorage = safeStorage;
    this.options = options;
  }

  generate(): DeviceKeyMaterial {
    const material = generateEd25519Material();
    const protectedKey = this.safeStorage.encryptString(exportPrivateKeyPkcs8Base64Url(material));
    writePrivateState(this.root, this.path, protectedKey, this.options.randomStagingId);
    return material;
  }

  load(): DeviceKeyMaterial | null {
    const observed = readPrivateState(this.path, this.options.afterReadBytes);
    if (observed === null) return null;
    const plaintext = this.safeStorage.decryptString(
      Buffer.from(observed.state.protected_private_key, "base64"),
    );
    return importPrivateKeyPkcs8Base64Url(plaintext);
  }

  clear(): void {
    const observed = readPrivateState(this.path, this.options.afterReadBytes);
    if (observed === null) return;
    this.options.beforeClearRevalidate?.();
    const current = lstatSync(this.path);
    if (current.isSymbolicLink()) throw new Error("Device key state cannot be a symlink");
    assertPrivateStateFile(current);
    try {
      inspectPrivateStateFile(this.path);
    } catch (error) {
      throw new Error("Device key state changed before clear", { cause: error });
    }
    if (!sameFile(observed.identity, current)) {
      throw new Error("Device key state changed before clear");
    }
    unlinkSync(this.path);
    syncRoot(this.root);
  }
}
