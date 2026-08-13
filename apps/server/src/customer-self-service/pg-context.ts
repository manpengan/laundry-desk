import { randomUUID } from "node:crypto";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { CustomerPortalSessionInvalidError, type CustomerPortalSessionIdentity } from "./types.js";

type AccessEvidence = Readonly<{ operation: string; resourceId: string | null }>;

async function setCustomerContext(
  client: PgPoolClient,
  identity: CustomerPortalSessionIdentity,
): Promise<void> {
  await client.query("SELECT set_config('app.org_id', $1, true)", [identity.orgId]);
  await client.query("SELECT set_config('app.store_id', $1, true)", [identity.storeId]);
  await client.query("SELECT set_config('app.customer_id', $1, true)", [identity.customerId]);
}

export async function withPortalTransaction<T>(
  pool: PgPool,
  identity: CustomerPortalSessionIdentity,
  sessionHash: string,
  access: AccessEvidence | null,
  run: (client: PgPoolClient) => Promise<T | null>,
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setCustomerContext(client, identity);
    const valid = await client.query<{ valid: boolean }>(
      "SELECT customer_portal_session_validate($1::uuid, $2::text, $3::text) AS valid",
      [identity.sessionId, sessionHash, identity.authorityHash],
    );
    if (valid.rows[0]?.valid !== true) throw new CustomerPortalSessionInvalidError();
    const result = await run(client);
    if (result !== null && access !== null) {
      await client.query(
        `INSERT INTO customer_portal_access_log (
           id, org_id, store_id, customer_id, session_id, operation, resource_id, at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid,
                   statement_timestamp())`,
        [
          randomUUID(),
          identity.orgId,
          identity.storeId,
          identity.customerId,
          identity.sessionId,
          access.operation,
          access.resourceId,
        ],
      );
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original read/authority failure remains the useful error.
    }
    throw error;
  } finally {
    client.release();
  }
}
