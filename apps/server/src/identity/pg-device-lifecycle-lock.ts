import type { PgPoolClient } from "../db/pg-pool.js";
import type { Uuid } from "./types.js";

/** Serialize every session/PIN lifecycle mutation for one browser device. */
export async function lockDeviceLifecycle(
  client: PgPoolClient,
  orgId: Uuid,
  storeId: Uuid,
  deviceId: Uuid,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `laundry-session:${orgId}:${storeId}:${deviceId}`,
  ]);
}
