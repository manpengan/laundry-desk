import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { RemoteAssistanceCommandSchema } from "@laundry/contracts";

const ascii = z.string().regex(/^[\x21-\x7e]{1,256}$/u);
export const AssistanceTrustSchema = z.strictObject({
  version: z.literal(1),
  broker_url: z.url().max(2048),
  broker_token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
  issuer: ascii,
  audience: ascii,
  kid: ascii,
  public_key_spki: z.string().regex(/^[A-Za-z0-9+/]{1,1024}={0,2}$/u),
});
export type AssistanceTrust = z.infer<typeof AssistanceTrustSchema>;
const claimsSchema = z.strictObject({
  iss: ascii,
  aud: ascii,
  sub: ascii,
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  auth_time: z.number().int().positive(),
  amr: z
    .array(z.enum(["pwd", "otp", "hwk", "mfa"]))
    .min(2)
    .max(4),
  session_id: z.uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  jti: z.uuid(),
  command: RemoteAssistanceCommandSchema,
});
export type SupportCommand = z.infer<typeof claimsSchema>;
const headerSchema = z.strictObject({ alg: z.literal("EdDSA"), typ: z.literal("JWT"), kid: ascii });
function decode(raw: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) throw new Error("ASSISTANCE_PROOF_INVALID");
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.toString("base64url") !== raw) throw new Error("ASSISTANCE_PROOF_INVALID");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
export function assistancePublicKey(trust: AssistanceTrust): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(trust.public_key_spki, "base64"),
    type: "spki",
    format: "der",
  });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("ASSISTANCE_TRUST_INVALID");
  return key;
}
export function verifySupportCommand(
  jwt: string,
  trust: AssistanceTrust,
  expected: Readonly<{ sessionId: string; nonce: string; now: number }>,
): SupportCommand {
  if (typeof jwt !== "string" || jwt.length > 8192) throw new Error("ASSISTANCE_PROOF_INVALID");
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("ASSISTANCE_PROOF_INVALID");
  const [header, payload, signature] = parts as [string, string, string];
  const parsedHeader = headerSchema.parse(decode(header));
  const claim = claimsSchema.parse(decode(payload));
  const signatureBytes = Buffer.from(signature, "base64url");
  const now = Math.floor(expected.now / 1000);
  if (
    parsedHeader.kid !== trust.kid ||
    signatureBytes.length !== 64 ||
    signatureBytes.toString("base64url") !== signature ||
    !verify(
      null,
      Buffer.from(`${header}.${payload}`),
      assistancePublicKey(trust),
      signatureBytes,
    ) ||
    claim.iss !== trust.issuer ||
    claim.aud !== trust.audience ||
    claim.session_id !== expected.sessionId ||
    claim.nonce !== expected.nonce ||
    claim.iat > now ||
    claim.iat < now - 60 ||
    claim.exp <= now ||
    claim.exp > claim.iat + 60 ||
    claim.auth_time > claim.iat ||
    claim.auth_time < now - 300 ||
    !claim.amr.includes("mfa") ||
    !claim.amr.some((method) => method === "otp" || method === "hwk")
  )
    throw new Error("ASSISTANCE_PROOF_INVALID");
  return claim;
}
export function supportOperatorHash(command: SupportCommand): string {
  return createHash("sha256").update(`${command.iss}\0${command.sub}`).digest("hex");
}
