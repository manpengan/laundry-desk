import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { AiCredentialRefSchema, AiProviderCodeSchema } from "@laundry/contracts";

import type { ByokKmsContext, ByokKmsPort } from "./byok-kms.js";

export const BYOK_ENVELOPE_SCHEMA_VERSION = 1 as const;
const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_WRAPPED_KEY_BYTES = 16_384;

export type CredentialEnvelope = Readonly<{
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  kmsKeyId: string;
  kmsKeyVersion: string;
  schemaVersion: typeof BYOK_ENVELOPE_SCHEMA_VERSION;
}>;

export type EnvelopeIdentity = Readonly<{
  orgId: string;
  providerCode: string;
  credentialId: string;
}>;

type RandomBytesPort = (size: number) => Buffer;

function kmsContext(identity: EnvelopeIdentity): ByokKmsContext {
  return Object.freeze({
    ...identity,
    envelopeSchemaVersion: BYOK_ENVELOPE_SCHEMA_VERSION,
  });
}

export function credentialAad(identity: EnvelopeIdentity): Buffer {
  const orgId = AiCredentialRefSchema.parse(identity.orgId);
  const credentialId = AiCredentialRefSchema.parse(identity.credentialId);
  const providerCode = AiProviderCodeSchema.parse(identity.providerCode);
  return Buffer.from(
    `${orgId}|${providerCode}|${credentialId}|${BYOK_ENVELOPE_SCHEMA_VERSION}`,
    "utf8",
  );
}

function requireDataKey(value: Buffer): Buffer {
  if (value.byteLength !== DATA_KEY_BYTES) {
    value.fill(0);
    throw new Error("KMS returned an invalid data key");
  }
  return value;
}

function requireWrappedKey(value: Buffer): Buffer {
  if (value.byteLength < 16 || value.byteLength > MAX_WRAPPED_KEY_BYTES) {
    throw new Error("KMS returned an invalid wrapped data key");
  }
  return Buffer.from(value);
}

function requireKmsMetadata(value: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("KMS returned invalid key metadata");
  }
  return value;
}

/** Takes ownership of plaintext and zeroes it on every exit path. */
export async function encryptCredential(
  kms: ByokKmsPort,
  identity: EnvelopeIdentity,
  plaintext: Buffer,
  random: RandomBytesPort = randomBytes,
): Promise<CredentialEnvelope> {
  if (plaintext.byteLength < 8 || plaintext.byteLength > 8_192) {
    plaintext.fill(0);
    throw new Error("Credential plaintext length is invalid");
  }
  let dek: Buffer = Buffer.alloc(0);
  let aad: Buffer = Buffer.alloc(0);
  try {
    aad = credentialAad(identity);
    dek = random(DATA_KEY_BYTES);
    const nonce = random(NONCE_BYTES);
    if (dek.byteLength !== DATA_KEY_BYTES || nonce.byteLength !== NONCE_BYTES) {
      nonce.fill(0);
      throw new Error("Secure random source returned an invalid length");
    }
    const cipher = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const wrapped = await kms.wrapDataKey({ plaintextKey: dek, context: kmsContext(identity) });
    return Object.freeze({
      ciphertext,
      nonce: Buffer.from(nonce),
      authTag: Buffer.from(authTag),
      wrappedDek: requireWrappedKey(wrapped.wrappedKey),
      kmsKeyId: requireKmsMetadata(wrapped.keyId, 512),
      kmsKeyVersion: requireKmsMetadata(wrapped.keyVersion, 128),
      schemaVersion: BYOK_ENVELOPE_SCHEMA_VERSION,
    });
  } finally {
    plaintext.fill(0);
    dek.fill(0);
    aad.fill(0);
  }
}

export async function decryptCredential(
  kms: ByokKmsPort,
  identity: EnvelopeIdentity,
  envelope: CredentialEnvelope,
): Promise<Buffer> {
  if (
    envelope.schemaVersion !== BYOK_ENVELOPE_SCHEMA_VERSION ||
    envelope.nonce.byteLength !== NONCE_BYTES ||
    envelope.authTag.byteLength !== AUTH_TAG_BYTES
  ) {
    throw new Error("Credential envelope is invalid");
  }
  const aad = credentialAad(identity);
  const dek = requireDataKey(
    await kms.unwrapDataKey({
      wrappedKey: Buffer.from(envelope.wrappedDek),
      keyId: envelope.kmsKeyId,
      keyVersion: envelope.kmsKeyVersion,
      context: kmsContext(identity),
    }),
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, envelope.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } finally {
    dek.fill(0);
    aad.fill(0);
  }
}

export async function rewrapCredentialDek(
  kms: ByokKmsPort,
  identity: EnvelopeIdentity,
  envelope: CredentialEnvelope,
): Promise<Pick<CredentialEnvelope, "wrappedDek" | "kmsKeyId" | "kmsKeyVersion">> {
  const context = kmsContext(identity);
  const dek = requireDataKey(
    await kms.unwrapDataKey({
      wrappedKey: Buffer.from(envelope.wrappedDek),
      keyId: envelope.kmsKeyId,
      keyVersion: envelope.kmsKeyVersion,
      context,
    }),
  );
  try {
    const wrapped = await kms.wrapDataKey({ plaintextKey: dek, context });
    return Object.freeze({
      wrappedDek: requireWrappedKey(wrapped.wrappedKey),
      kmsKeyId: requireKmsMetadata(wrapped.keyId, 512),
      kmsKeyVersion: requireKmsMetadata(wrapped.keyVersion, 128),
    });
  } finally {
    dek.fill(0);
  }
}
