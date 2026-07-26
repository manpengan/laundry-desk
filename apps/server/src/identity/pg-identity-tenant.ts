import type { PgPool } from "../db/pg-pool.js";
import type { Uuid } from "./types.js";

const MAINTENANCE_STAFF_ID = "00000000-0000-4000-8000-000000000000";

export type IdentityTenantIds = Readonly<{
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
}>;

export function storeScopeOf(tenant: IdentityTenantIds): Readonly<{
  orgId: Uuid;
  storeId: Uuid;
  staffId: Uuid;
}> {
  return Object.freeze({
    orgId: tenant.org_id,
    storeId: tenant.store_id,
    staffId: tenant.staff_id,
  });
}

export async function lookupSessionTenant(
  pool: PgPool,
  sessionId: Uuid,
): Promise<IdentityTenantIds | null> {
  const result = await pool.query<{ org_id: string; store_id: string; staff_id: string }>(
    `SELECT org_id::text, store_id::text, staff_id::text
     FROM laundry_auth_lookup_session($1::uuid)`,
    [sessionId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { org_id: row.org_id, store_id: row.store_id, staff_id: row.staff_id };
}

async function maintenanceTenantFromQuery(
  pool: PgPool,
  sql: string,
  id: Uuid,
): Promise<IdentityTenantIds | null> {
  const result = await pool.query<{ org_id: string; store_id: string }>(sql, [id]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { org_id: row.org_id, store_id: row.store_id, staff_id: MAINTENANCE_STAFF_ID };
}

export const lookupFamilyTenant = (
  pool: PgPool,
  familyId: Uuid,
): Promise<IdentityTenantIds | null> =>
  maintenanceTenantFromQuery(
    pool,
    "SELECT org_id::text, store_id::text FROM laundry_auth_lookup_family($1::uuid)",
    familyId,
  );

export const lookupTokenTenant = (pool: PgPool, tokenId: Uuid): Promise<IdentityTenantIds | null> =>
  maintenanceTenantFromQuery(
    pool,
    "SELECT org_id::text, store_id::text FROM laundry_auth_lookup_refresh_by_id($1::uuid)",
    tokenId,
  );
