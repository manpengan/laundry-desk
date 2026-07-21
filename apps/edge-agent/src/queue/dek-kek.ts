/**
 * Queue DEK / KEK separation (ADR-01 §5, ADR-04, architecture §10).
 *
 * - DEK: random 32-byte AES-256 key for queue ciphertext (and future SQLCipher key).
 * - KEK: wraps DEK; lives in OS credential store (Windows DPAPI / macOS Keychain / keytar).
 * - NEVER derive DEK from the device Ed25519 signing private key (signing ≠ encryption).
 * - Browser / renderer never holds DEK or KEK (IPC returns status only).
 */

import { assertKeyLength, decryptAes256Gcm, encryptAes256Gcm, randomKey } from "./crypto.js";

export type Dek = Buffer;
export type Kek = Buffer;

export type WrappedDek = Readonly<{
  /** Increments on KEK rotation (rewrap). Queue rows stay under the same DEK. */
  keyVersion: number;
  algorithm: "AES-256-GCM";
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}>;

/**
 * Port for KEK + wrapped-DEK persistence.
 * Production: DPAPI/keytar adapter. Tests: MemoryKekStore.
 */
export interface KekStore {
  getOrCreateKek(): Kek;
  saveWrappedDek(wrapped: WrappedDek): void;
  loadWrappedDek(): WrappedDek | null;
  /** Best-effort erase on device unbind (server revoke is atomic; local wipe best-effort). */
  clear(): void;
  currentKeyVersion(): number;
}

/** AAD binds wrap ciphertext to this product purpose (not reusable as generic secret wrap). */
const WRAP_AAD = Buffer.from("laundry.edge.queue.dek-wrap.v1", "utf8");

export function generateDek(): Dek {
  return randomKey();
}

export function generateKek(): Kek {
  return randomKey();
}

export function wrapDek(dek: Dek, kek: Kek, keyVersion: number): WrappedDek {
  assertKeyLength(dek, "DEK");
  assertKeyLength(kek, "KEK");
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error("keyVersion must be a positive integer");
  }
  const sealed = encryptAes256Gcm(kek, dek, WRAP_AAD);
  return Object.freeze({
    keyVersion,
    algorithm: "AES-256-GCM" as const,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
  });
}

export function unwrapDek(wrapped: WrappedDek, kek: Kek): Dek {
  assertKeyLength(kek, "KEK");
  return decryptAes256Gcm(
    kek,
    {
      nonce: wrapped.nonce,
      ciphertext: wrapped.ciphertext,
      authTag: wrapped.authTag,
    },
    WRAP_AAD,
  );
}

/**
 * KEK rotation path: unwrap DEK with old KEK, rewrap under new KEK.
 * Does **not** re-encrypt queue row ciphertext (DEK unchanged).
 */
export function rewrapDek(
  wrapped: WrappedDek,
  oldKek: Kek,
  newKek: Kek,
  newKeyVersion: number,
): WrappedDek {
  const dek = unwrapDek(wrapped, oldKek);
  try {
    return wrapDek(dek, newKek, newKeyVersion);
  } finally {
    dek.fill(0);
  }
}

/** In-memory store for tests and ephemeral local dev only. */
export class MemoryKekStore implements KekStore {
  private kek: Kek | null = null;
  private wrapped: WrappedDek | null = null;
  private keyVersion = 1;

  getOrCreateKek(): Kek {
    if (!this.kek) {
      this.kek = generateKek();
    }
    return this.kek;
  }

  saveWrappedDek(wrapped: WrappedDek): void {
    this.wrapped = wrapped;
    this.keyVersion = wrapped.keyVersion;
  }

  loadWrappedDek(): WrappedDek | null {
    return this.wrapped;
  }

  clear(): void {
    if (this.kek) this.kek.fill(0);
    this.kek = null;
    this.wrapped = null;
  }

  currentKeyVersion(): number {
    return this.keyVersion;
  }

  /** Test helper: swap KEK bytes in place (caller owns rewrap). */
  replaceKek(next: Kek): void {
    assertKeyLength(next, "KEK");
    if (this.kek) this.kek.fill(0);
    this.kek = Buffer.from(next);
  }
}

/**
 * Production placeholder for OS credential store (keytar + DPAPI/Keychain).
 * Intentionally throws so CI never depends on native credential APIs.
 *
 * Adapter checklist when wiring:
 * - Service name e.g. `laundry-desk.edge`; accounts `queue-kek` / `queue-dek-wrapped`
 * - KEK and wrapped-DEK **not** co-located with SQLite on disk as plaintext
 * - Never derive DEK/KEK from device signing private key
 * - clear() on unbind is best-effort; server revoke remains the atomic authority
 */
export class UnimplementedOsKekStore implements KekStore {
  getOrCreateKek(): Kek {
    throw new Error("OsKekStore not implemented: persist KEK via keytar/DPAPI/Keychain");
  }

  saveWrappedDek(wrapped: WrappedDek): void {
    void wrapped;
    throw new Error("OsKekStore not implemented: persist wrapped DEK via keytar/DPAPI");
  }

  loadWrappedDek(): WrappedDek | null {
    throw new Error("OsKekStore not implemented: load wrapped DEK via keytar/DPAPI");
  }

  clear(): void {
    throw new Error("OsKekStore not implemented: clear KEK/wrapped DEK via keytar/DPAPI");
  }

  currentKeyVersion(): number {
    throw new Error("OsKekStore not implemented: key version via keytar/DPAPI");
  }
}
