import { createHash, timingSafeEqual, type KeyObject } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";

const AuthorityTrustStateSchema = z.strictObject({
  version: z.literal(1),
  protected_fingerprint: z.base64(),
});

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
  return realpathSync(path);
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Authority trust state escaped its private root");
  }
}

function writePrivateState(root: string, path: string, protectedFingerprint: Buffer): void {
  const staging = join(root, ".authority-trust.staging");
  const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({
        version: 1,
        protected_fingerprint: protectedFingerprint.toString("base64"),
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

/** Keychain-protected, device-local pin for the stable server authority signer. */
export class SafeStorageAuthorityTrustStore implements AuthorityTrustStore {
  private readonly root: string;
  private readonly path: string;

  constructor(
    rootPath: string,
    private readonly safeStorage: SafeStorageSurface,
  ) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS Keychain encryption is unavailable");
    }
    this.root = prepareRoot(rootPath);
    this.path = join(this.root, "authority-trust.json");
    assertContained(this.root, this.path);
  }

  accept(publicKey: KeyObject): boolean {
    const candidate = fingerprint(publicKey);
    if (!existsSync(this.path)) {
      writePrivateState(
        this.root,
        this.path,
        this.safeStorage.encryptString(candidate.toString("base64")),
      );
      return true;
    }
    const meta = lstatSync(this.path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 64 * 1024) {
      throw new Error("Invalid authority trust state file");
    }
    const state = AuthorityTrustStateSchema.parse(
      JSON.parse(readFileSync(this.path, "utf8")) as unknown,
    );
    const pinned = Buffer.from(
      this.safeStorage.decryptString(Buffer.from(state.protected_fingerprint, "base64")),
      "base64",
    );
    return pinned.byteLength === candidate.byteLength && timingSafeEqual(pinned, candidate);
  }
}
