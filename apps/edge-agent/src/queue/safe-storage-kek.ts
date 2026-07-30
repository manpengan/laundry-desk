import { randomBytes } from "node:crypto";
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

import { type Kek, type KekStore, type WrappedDek } from "./dek-kek.js";

const KeyStateSchema = z.strictObject({
  version: z.literal(1),
  protected_kek: z.base64(),
  wrapped_dek: z
    .strictObject({
      key_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      algorithm: z.literal("AES-256-GCM"),
      nonce: z.base64(),
      ciphertext: z.base64(),
      auth_tag: z.base64(),
    })
    .nullable(),
});

type KeyState = z.output<typeof KeyStateSchema>;

export type SafeStorageSurface = Readonly<{
  isEncryptionAvailable: () => boolean;
  encryptString: (plaintext: string) => Buffer;
  decryptString: (ciphertext: Buffer) => string;
}>;

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Queue key state escaped its private root");
  }
}

function prepareRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("Queue key root must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const meta = lstatSync(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new Error("Queue key root must be a real directory");
  }
  return realpathSync(path);
}

function freezeState(state: KeyState): KeyState {
  return Object.freeze({
    version: 1,
    protected_kek: state.protected_kek,
    wrapped_dek: state.wrapped_dek === null ? null : Object.freeze({ ...state.wrapped_dek }),
  });
}

function writePrivateJson(root: string, path: string, state: KeyState): void {
  const temp = join(root, ".queue-key.staging");
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(KeyStateSchema.parse(state))}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dirFd = openSync(root, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function serializeWrapped(wrapped: WrappedDek): NonNullable<KeyState["wrapped_dek"]> {
  return Object.freeze({
    key_version: wrapped.keyVersion,
    algorithm: wrapped.algorithm,
    nonce: wrapped.nonce.toString("base64"),
    ciphertext: wrapped.ciphertext.toString("base64"),
    auth_tag: wrapped.authTag.toString("base64"),
  });
}

function parseWrapped(wrapped: NonNullable<KeyState["wrapped_dek"]>): WrappedDek {
  return Object.freeze({
    keyVersion: wrapped.key_version,
    algorithm: wrapped.algorithm,
    nonce: Buffer.from(wrapped.nonce, "base64"),
    ciphertext: Buffer.from(wrapped.ciphertext, "base64"),
    authTag: Buffer.from(wrapped.auth_tag, "base64"),
  });
}

export class SafeStorageKekStore implements KekStore {
  private readonly root: string;
  private readonly path: string;
  private readonly safeStorage: SafeStorageSurface;
  private state: KeyState | null = null;

  constructor(rootPath: string, safeStorage: SafeStorageSurface) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS Keychain encryption is unavailable");
    }
    this.root = prepareRoot(rootPath);
    this.path = join(this.root, "queue-key.json");
    assertContained(this.root, this.path);
    this.safeStorage = safeStorage;
  }

  private loadState(): KeyState | null {
    if (this.state !== null) return this.state;
    if (!existsSync(this.path)) return null;
    const meta = lstatSync(this.path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 64 * 1024) {
      throw new Error("Invalid queue key state file");
    }
    const parsed = KeyStateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")) as unknown);
    this.state = freezeState(parsed);
    return this.state;
  }

  private saveState(state: KeyState): void {
    const frozen = freezeState(state);
    writePrivateJson(this.root, this.path, frozen);
    this.state = frozen;
  }

  getOrCreateKek(): Kek {
    const existing = this.loadState();
    if (existing !== null) {
      const plaintext = this.safeStorage.decryptString(
        Buffer.from(existing.protected_kek, "base64"),
      );
      const kek = Buffer.from(plaintext, "base64");
      if (kek.byteLength !== 32) throw new Error("Protected queue KEK has invalid length");
      return kek;
    }
    const kek = randomBytes(32);
    const protectedKek = this.safeStorage.encryptString(kek.toString("base64"));
    this.saveState({
      version: 1,
      protected_kek: protectedKek.toString("base64"),
      wrapped_dek: null,
    });
    return kek;
  }

  saveWrappedDek(wrapped: WrappedDek): void {
    const current = this.loadState();
    if (current === null) throw new Error("Queue KEK must exist before the wrapped DEK");
    this.saveState(
      Object.freeze({
        ...current,
        wrapped_dek: serializeWrapped(wrapped),
      }),
    );
  }

  loadWrappedDek(): WrappedDek | null {
    const wrapped = this.loadState()?.wrapped_dek ?? null;
    return wrapped === null ? null : parseWrapped(wrapped);
  }

  clear(): void {
    const current = this.loadState();
    if (current === null) return;
    this.saveState(
      Object.freeze({
        version: 1,
        protected_kek: this.safeStorage
          .encryptString(randomBytes(32).toString("base64"))
          .toString("base64"),
        wrapped_dek: null,
      }),
    );
  }

  currentKeyVersion(): number {
    return this.loadState()?.wrapped_dek?.key_version ?? 1;
  }
}
