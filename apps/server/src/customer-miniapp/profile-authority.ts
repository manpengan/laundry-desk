import { createHmac, hkdfSync } from "node:crypto";
import type { CustomerPortalProfileUpdateInput } from "@laundry/contracts";
import type { MiniappTransaction } from "./types.js";

/** Shared only by the trusted owner bootstrap and the server; never persisted in app-readable data. */
export function deriveMiniappProfileAuthorityKey(accessTokenSecret: string): Buffer {
  if (Buffer.byteLength(accessTokenSecret, "utf8") < 32)
    throw new Error("MINIAPP_PROFILE_AUTHORITY_INVALID");
  return Buffer.from(
    hkdfSync(
      "sha256",
      accessTokenSecret,
      "laundry-desk/miniapp-profile/v1",
      "profile-cas-authority",
      32,
    ),
  );
}
export async function signMiniappProfileUpdate(
  secret: string,
  tx: MiniappTransaction,
  input: CustomerPortalProfileUpdateInput,
) {
  // The verifier owns the clock. Even millisecond host/DB skew must not reject a valid proof.
  const clock = await tx.client.query<{ expires_at_ms: string }>(
    "SELECT ((extract(epoch FROM statement_timestamp())*1000)::bigint+60000)::text AS expires_at_ms",
  );
  const expiresAt = Number(clock.rows[0]?.expires_at_ms);
  if (!Number.isSafeInteger(expiresAt)) throw new Error("MINIAPP_PROFILE_AUTHORITY_INVALID");
  const payload = JSON.stringify({
    action: "profile/update",
    org_id: tx.tenant.orgId,
    store_id: tx.tenant.storeId,
    session_id: tx.identity.sessionId,
    customer_id: tx.customerId,
    staff_id: tx.settings.delegated_staff_id,
    config_version: tx.settings.version,
    expires_at_ms: expiresAt,
    expected_version: input.expected_version,
    preferred_contact: input.preferred_contact,
    addresses: input.addresses,
  });
  const key = deriveMiniappProfileAuthorityKey(secret);
  try {
    return Object.freeze({
      payload,
      signature: createHmac("sha256", key).update(payload, "utf8").digest("hex"),
    });
  } finally {
    key.fill(0);
  }
}
