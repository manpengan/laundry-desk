/**
 * Run work inside a transaction with SET LOCAL tenant GUCs (laundry_app path).
 * GUC names are fixed literals; UUID values are bind parameters only.
 */

import type { PgPool, PgPoolClient } from "./pg-pool.js";
import { withTransaction } from "./pg-pool.js";
import { getActiveTenantTransaction } from "./active-tenant-transaction.js";
import { TENANT_GUC_KEYS } from "./guc.js";
import type { SqlClient, Uuid } from "./types.js";

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

/**
 * Reuse the command bus transaction when one is active for exactly this org.
 * Direct repository calls still get their own transaction and SET LOCAL GUCs.
 */
export async function withOrgGucOrCurrent<T>(
  pool: PgPool,
  scope: OrgScope,
  fn: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const current = getActiveTenantTransaction();
  if (current === undefined) {
    return withOrgGuc(pool, scope, fn);
  }
  if (current.tenant.orgId !== scope.orgId) {
    throw new Error("Repository org scope does not match authenticated tenant");
  }
  return fn(current.client);
}

/**
 * Reuse the command bus transaction only for its authenticated store scope.
 * A repository cannot switch org/store while a request transaction is active.
 */
export async function withStoreGucOrCurrent<T>(
  pool: PgPool,
  scope: StoreScope,
  fn: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const current = getActiveTenantTransaction();
  if (current === undefined) {
    return withStoreGuc(pool, scope, fn);
  }
  if (current.tenant.orgId !== scope.orgId || current.tenant.storeId !== scope.storeId) {
    throw new Error("Repository store scope does not match authenticated tenant");
  }
  if (scope.staffId !== undefined && current.tenant.staffId !== scope.staffId) {
    throw new Error("Repository staff scope does not match authenticated actor");
  }
  return fn(current.client);
}
