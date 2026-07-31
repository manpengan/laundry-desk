import { constants } from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
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

function prepareRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("Device key root must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const meta = lstatSync(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new Error("Device key root must be a real directory");
  }
  return realpathSync(path);
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Device key state escaped its private root");
  }
}

function writePrivateState(root: string, path: string, protectedKey: Buffer): void {
  const staging = join(root, ".device-key.staging");
  const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({
        version: 1,
        protected_private_key: protectedKey.toString("base64"),
      })}\n`,
      "utf8",
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staging, path);
  const dirFd = openSync(root, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Ed25519 private key encrypted by Electron safeStorage (macOS Keychain backed). */
export class SafeStorageDeviceKeyStore implements DeviceKeyStore {
  private readonly root: string;
  private readonly path: string;
  private readonly safeStorage: SafeStorageSurface;

  constructor(rootPath: string, safeStorage: SafeStorageSurface) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS Keychain encryption is unavailable");
    }
    this.root = prepareRoot(rootPath);
    this.path = join(this.root, "device-signing-key.json");
    assertContained(this.root, this.path);
    this.safeStorage = safeStorage;
  }

  generate(): DeviceKeyMaterial {
    const material = generateEd25519Material();
    const protectedKey = this.safeStorage.encryptString(exportPrivateKeyPkcs8Base64Url(material));
    writePrivateState(this.root, this.path, protectedKey);
    return material;
  }

  load(): DeviceKeyMaterial | null {
    if (!existsSync(this.path)) return null;
    const meta = lstatSync(this.path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 64 * 1024) {
      throw new Error("Invalid device key state file");
    }
    const state = DeviceKeyStateSchema.parse(
      JSON.parse(readFileSync(this.path, "utf8")) as unknown,
    );
    const plaintext = this.safeStorage.decryptString(
      Buffer.from(state.protected_private_key, "base64"),
    );
    return importPrivateKeyPkcs8Base64Url(plaintext);
  }

  clear(): void {
    if (existsSync(this.path)) {
      const meta = lstatSync(this.path);
      if (!meta.isFile() || meta.isSymbolicLink()) {
        throw new Error("Invalid device key state file");
      }
      unlinkSync(this.path);
    }
  }
}
