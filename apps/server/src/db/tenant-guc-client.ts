/**
 * Run work inside a transaction with SET LOCAL tenant GUCs (laundry_app path).
 * GUC names are fixed literals; UUID values are bind parameters only.
 */

import type { PgPool, PgPoolClient } from "./pg-pool.js";
import { withTransaction } from "./pg-pool.js";
import { TENANT_GUC_KEYS } from "./guc.js";
import type { Uuid } from "./types.js";

export type OrgScope = Readonly<{
  orgId: Uuid;
  /** Optional staff for audit GUC; defaults to nil UUID when unknown. */
  staffId?: Uuid;
}>;

export type StoreScope = Readonly<{
  orgId: Uuid;
  storeId: Uuid;
  staffId?: Uuid;
}>;

const NIL_STAFF = "00000000-0000-4000-8000-000000000000";

async function applyOrgGuc(client: PgPoolClient, orgId: Uuid, staffId: Uuid): Promise<void> {
  await client.query(`SELECT set_config('${TENANT_GUC_KEYS.orgId}', $1, true)`, [orgId]);
  await client.query(`SELECT set_config('${TENANT_GUC_KEYS.staffId}', $1, true)`, [staffId]);
}

async function applyStoreGuc(
  client: PgPoolClient,
  orgId: Uuid,
  storeId: Uuid,
  staffId: Uuid,
): Promise<void> {
  await applyOrgGuc(client, orgId, staffId);
  await client.query(`SELECT set_config('${TENANT_GUC_KEYS.storeId}', $1, true)`, [storeId]);
}

/** Org-scoped tables (staffs, stores, settings): set app.org_id (+ staff). */
export async function withOrgGuc<T>(
  pool: PgPool,
  scope: OrgScope,
  fn: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const staffId = scope.staffId ?? NIL_STAFF;
  return withTransaction(pool, async (client) => {
    await applyOrgGuc(client, scope.orgId, staffId);
    return fn(client);
  });
}

/** Store-scoped tables (sessions, refresh_*, pin_challenges, …). */
export async function withStoreGuc<T>(
  pool: PgPool,
  scope: StoreScope,
  fn: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const staffId = scope.staffId ?? NIL_STAFF;
  return withTransaction(pool, async (client) => {
    await applyStoreGuc(client, scope.orgId, scope.storeId, staffId);
    return fn(client);
  });
}
