import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { deriveMiniappProfileAuthorityKey } from "../customer-miniapp/profile-authority.js";

/** Trusted runtime verification only. The HTTP process never receives this pool. */
export async function prepareMiniappProfileAuthority(
  pool: PgPool,
  accessTokenSecret: string,
): Promise<void> {
  let key: Buffer | undefined;
  let client: PgPoolClient | undefined;
  let transactionOpen = false;
  try {
    key = deriveMiniappProfileAuthorityKey(accessTokenSecret);
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL ROLE laundry_owner");
    // An unchanged secret causes no write. Rotation replaces the verifier before
    // startup, invalidating outstanding proofs made with the previous key.
    await client.query(
      `INSERT INTO public.miniapp_profile_authority(org_id,store_id,hmac_key)
       VALUES($1::uuid,$2::uuid,$3::bytea)
       ON CONFLICT(org_id,store_id) DO UPDATE SET hmac_key=EXCLUDED.hmac_key
       WHERE miniapp_profile_authority.hmac_key IS DISTINCT FROM EXCLUDED.hmac_key`,
      [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, key],
    );
    await client.query("COMMIT");
    transactionOpen = false;
  } catch {
    if (client !== undefined && transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw new Error("RUNTIME_MINIAPP_AUTHORITY_ROLLBACK_FAILED");
      }
    }
    throw new Error("RUNTIME_MINIAPP_AUTHORITY_FAILED");
  } finally {
    key?.fill(0);
    client?.release();
  }
}
