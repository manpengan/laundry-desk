import type { SqlClient, TenantContext } from "../db/types.js";

export type BusinessDayLockPort = (
  client: SqlClient,
  tenant: TenantContext,
  businessDate: string,
) => Promise<void>;

/**
 * Serialize a store business day's writes and close inside the caller's transaction.
 * Hash collisions only cause conservative extra serialization; they cannot weaken isolation.
 */
export const acquirePgBusinessDayLock: BusinessDayLockPort = async (
  client,
  tenant,
  businessDate,
) => {
  const key = `laundry:business-day:${tenant.orgId}:${tenant.storeId}:${businessDate}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
};
