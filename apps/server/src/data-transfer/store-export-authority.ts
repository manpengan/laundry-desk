import { createPrivateKey, createPublicKey, hkdfSync, sign, verify } from "node:crypto";
import { z } from "zod";

const DOMAIN = "laundry-desk/store-export-approval/v1\n";
const ClaimsSchema = z.strictObject({
  id: z.uuid(),
  org_id: z.uuid(),
  store_id: z.uuid(),
  actor_id: z.uuid(),
  session_id: z.uuid(),
  session_version: z.number().int().positive(),
  permission_version: z.number().int().positive(),
  policy_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  approved_at_ms: z.coerce.number().int().nonnegative().safe(),
  expires_at_ms: z.coerce.number().int().positive().safe(),
});
export type StoreExportApprovalClaims = z.input<typeof ClaimsSchema>;

/** Instance-bound key, with a distinct HKDF domain from access tokens and edge grants. */
function keys(secret: string) {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("STORE_EXPORT_AUTHORITY_INVALID");
  const seed = Buffer.from(hkdfSync("sha256", secret, DOMAIN, "ed25519-pkcs8-seed", 32));
  try {
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });
    return { privateKey, publicKey: createPublicKey(privateKey) };
  } finally {
    seed.fill(0);
  }
}
function payload(claims: StoreExportApprovalClaims): Buffer {
  const parsed = ClaimsSchema.parse(claims);
  if (
    parsed.expires_at_ms <= parsed.approved_at_ms ||
    parsed.expires_at_ms - parsed.approved_at_ms > 600_000
  )
    throw new Error("STORE_EXPORT_AUTHORITY_INVALID");
  return Buffer.from(`${DOMAIN}${JSON.stringify(parsed)}`, "utf8");
}
export function signStoreExportApproval(secret: string, claims: StoreExportApprovalClaims): string {
  return sign(null, payload(claims), keys(secret).privateKey).toString("base64");
}
export function verifyStoreExportApproval(
  secret: string,
  claims: StoreExportApprovalClaims,
  signature: string,
): void {
  if (
    !/^[A-Za-z0-9+/]{86}==$/u.test(signature) ||
    !verify(null, payload(claims), keys(secret).publicKey, Buffer.from(signature, "base64"))
  )
    throw new Error("STORE_EXPORT_AUTHORIZATION_INVALID");
}
