import { z } from "zod";
import type { CredentialEnvelope } from "../../ai/byok-envelope.js";

const Base64 = z
  .string()
  .min(4)
  .max(24_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const EnvelopeSchema = z.strictObject({
  ciphertext: Base64,
  nonce: Base64,
  authTag: Base64,
  wrappedDek: Base64,
  kmsKeyId: z.literal("windows-dpapi-current-user"),
  kmsKeyVersion: z.literal("1"),
  schemaVersion: z.literal(1),
});
export function serializeEnvelope(value: CredentialEnvelope): string {
  return JSON.stringify(
    EnvelopeSchema.parse({
      ...value,
      ciphertext: value.ciphertext.toString("base64"),
      nonce: value.nonce.toString("base64"),
      authTag: value.authTag.toString("base64"),
      wrappedDek: value.wrappedDek.toString("base64"),
    }),
  );
}
export function parseEnvelope(raw: unknown): CredentialEnvelope {
  const value = EnvelopeSchema.parse(raw);
  return Object.freeze({
    ...value,
    ciphertext: Buffer.from(value.ciphertext, "base64"),
    nonce: Buffer.from(value.nonce, "base64"),
    authTag: Buffer.from(value.authTag, "base64"),
    wrappedDek: Buffer.from(value.wrappedDek, "base64"),
  });
}
