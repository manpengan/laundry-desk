import type { CustomerPortalProfileUpdateInput } from "@laundry/contracts";
import { MiniappError, type MiniappTransaction } from "./types.js";
import { signMiniappProfileUpdate } from "./profile-authority.js";

/** Owner-only bounded CAS preserves the original portal DML guard and staff-owned addresses. */
export async function updateMiniappProfile(
  tx: MiniappTransaction,
  input: CustomerPortalProfileUpdateInput,
  accessTokenSecret: string,
) {
  const proof = await signMiniappProfileUpdate(accessTokenSecret, tx, input);
  const result = await tx.client.query<{ version: number }>(
    `SELECT version FROM miniapp_profile_update($1::uuid,$2::integer,$3::text,$4::jsonb,$5::text,$6::text)`,
    [
      tx.identity.sessionId,
      input.expected_version,
      input.preferred_contact,
      JSON.stringify(input.addresses),
      proof.payload,
      proof.signature,
    ],
  );
  if (result.rows[0] === undefined) throw new MiniappError("RESOURCE_UNAVAILABLE");
  return Object.freeze({ version: result.rows[0].version });
}
