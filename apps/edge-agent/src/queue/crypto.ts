/**
 * AES-256-GCM helpers for queue payload encryption (Node crypto only).
 * Unique 96-bit nonce per seal; 16-byte auth tag; AAD binding required.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { QueueCryptoError } from "./types.js";

export const AES_256_GCM = "aes-256-gcm" as const;
export const KEY_BYTE_LENGTH = 32;
export const NONCE_BYTE_LENGTH = 12;
export const AUTH_TAG_BYTE_LENGTH = 16;

/** Wire packing version for sealed blobs stored by MemoryQueue / future SQLCipher rows. */
export const SEALED_BLOB_VERSION = 1 as const;

export type AesGcmSealed = Readonly<{
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}>;

export function assertKeyLength(key: Buffer, label: string): void {
  if (key.length !== KEY_BYTE_LENGTH) {
    throw new QueueCryptoError(
      "key_length_invalid",
      `${label} must be ${KEY_BYTE_LENGTH} bytes (AES-256)`,
    );
  }
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTE_LENGTH);
}

export function encryptAes256Gcm(key: Buffer, plaintext: Buffer, aad: Buffer): AesGcmSealed {
  assertKeyLength(key, "AES-256-GCM key");
  const nonce = randomBytes(NONCE_BYTE_LENGTH);
  const cipher = createCipheriv(AES_256_GCM, key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Object.freeze({ nonce, ciphertext, authTag });
}

/**
 * Decrypt AES-256-GCM. Fail-closed on bad MAC / wrong key / wrong AAD:
 * Node throws; we normalize to QueueCryptoError so callers never see partial plaintext.
 */
export function decryptAes256Gcm(key: Buffer, sealed: AesGcmSealed, aad: Buffer): Buffer {
  assertKeyLength(key, "AES-256-GCM key");
  if (sealed.nonce.length !== NONCE_BYTE_LENGTH) {
    throw new QueueCryptoError("malformed_blob", "nonce must be 12 bytes");
  }
  if (sealed.authTag.length !== AUTH_TAG_BYTE_LENGTH) {
    throw new QueueCryptoError("malformed_blob", "auth tag must be 16 bytes");
  }
  try {
    const decipher = createDecipheriv(AES_256_GCM, key, sealed.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    throw new QueueCryptoError("auth_tag_invalid", "AES-GCM authentication failed (fail closed)");
  }
}

/**
 * Pack sealed components into a single opaque blob:
 * `version(1) | nonce(12) | authTag(16) | ciphertext(*)`
 */
export function packSealedBlob(sealed: AesGcmSealed): Buffer {
  const header = Buffer.alloc(1 + NONCE_BYTE_LENGTH + AUTH_TAG_BYTE_LENGTH);
  header.writeUInt8(SEALED_BLOB_VERSION, 0);
  sealed.nonce.copy(header, 1);
  sealed.authTag.copy(header, 1 + NONCE_BYTE_LENGTH);
  return Buffer.concat([header, sealed.ciphertext]);
}

export function unpackSealedBlob(blob: Buffer): AesGcmSealed {
  const min = 1 + NONCE_BYTE_LENGTH + AUTH_TAG_BYTE_LENGTH;
  if (blob.length < min) {
    throw new QueueCryptoError("malformed_blob", "sealed blob too short");
  }
  const version = blob.readUInt8(0);
  if (version !== SEALED_BLOB_VERSION) {
    throw new QueueCryptoError("malformed_blob", `unsupported sealed blob version ${version}`);
  }
  const nonce = Buffer.from(blob.subarray(1, 1 + NONCE_BYTE_LENGTH));
  const authTag = Buffer.from(
    blob.subarray(1 + NONCE_BYTE_LENGTH, 1 + NONCE_BYTE_LENGTH + AUTH_TAG_BYTE_LENGTH),
  );
  const ciphertext = Buffer.from(blob.subarray(min));
  return Object.freeze({ nonce, ciphertext, authTag });
}

/** Constant-time buffer equality for tests / guards (not for AAD binding). */
export function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
