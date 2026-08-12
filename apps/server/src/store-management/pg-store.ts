import type { SqlClient, TenantContext } from "../db/types.js";
import type {
  AuthorizedStoreDirectory,
  StoreManagementStore,
  StoreProfileSnapshot,
  StoreProfileUpdateResult,
} from "./types.js";

type StoreRow = Readonly<{
  id: string;
  code: string;
  name: string;
  timezone: string;
  profile_version: number | string;
  updated_at: Date | string;
}>;

type AuthorizationRow = Readonly<{ authorized: boolean }>;

const AUTHORIZED_STORE_LIMIT = 50;
const MAXIMUM_STORE_CANDIDATES = 200;
const STORE_CANDIDATE_QUERY_LIMIT = MAXIMUM_STORE_CANDIDATES + 1;

const LIST_CANDIDATES_SQL = `
  SELECT store.id::text, store.code, store.name, store.timezone,
         store.profile_version, store.updated_at
    FROM stores AS store
   WHERE store.org_id = $1::uuid
   ORDER BY store.code ASC, store.id ASC
   LIMIT $2::integer
`;

const AUTHORIZE_STORE_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM staff_store_roles AS store_role
      JOIN staffs AS staff
        ON staff.org_id = store_role.org_id
       AND staff.id = store_role.staff_id
     WHERE store_role.org_id = $1::uuid
       AND store_role.store_id = $2::uuid
       AND store_role.staff_id = $3::uuid
       AND store_role.role = 'admin'
       AND store_role.is_active
       AND staff.is_active
  ) AS authorized
`;

const READ_CURRENT_SQL = `
  SELECT store.id::text, store.code, store.name, store.timezone,
         store.profile_version, store.updated_at
    FROM stores AS store
   WHERE store.org_id = $1::uuid
     AND store.id = $2::uuid
   FOR UPDATE
`;

const UPDATE_CURRENT_SQL = `
  UPDATE stores
     SET name = $3,
         updated_at = $4::timestamptz
   WHERE org_id = $1::uuid
     AND id = $2::uuid
     AND profile_version = $5::integer
   RETURNING id::text, code, name, timezone, profile_version, updated_at
`;

const SET_STORE_GUC_SQL = "SELECT set_config('app.store_id', $1, true)";

function safePositiveInteger(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`invalid PostgreSQL ${field}`);
  }
  return parsed;
}

function exactDate(value: Date | string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`invalid PostgreSQL ${field}`);
  return parsed;
}

function compareStoreCodes(left: StoreProfileSnapshot, right: StoreProfileSnapshot): number {
  if (left.storeCode < right.storeCode) return -1;
  if (left.storeCode > right.storeCode) return 1;
  return 0;
}

function toSnapshot(row: StoreRow, currentStoreId: string): StoreProfileSnapshot {
  if (row.code.length === 0 || row.name.trim().length === 0 || row.timezone.length === 0) {
    throw new TypeError("invalid PostgreSQL store profile");
  }
  return Object.freeze({
    storeCode: row.code,
    storeName: row.name,
    timeZone: row.timezone,
    profileVersion: safePositiveInteger(row.profile_version, "store profile version"),
    updatedAt: exactDate(row.updated_at, "store updated_at"),
    isCurrent: row.id === currentStoreId,
  });
}

async function actorIsStoreAdmin(
  client: SqlClient,
  tenant: TenantContext,
  storeId: string,
): Promise<boolean> {
  const result = await client.query<AuthorizationRow>(AUTHORIZE_STORE_SQL, [
    tenant.orgId,
    storeId,
    tenant.staffId,
  ]);
  const row = result.rows[0];
  if (row === undefined || typeof row.authorized !== "boolean") {
    throw new TypeError("missing PostgreSQL store authorization");
  }
  return row.authorized;
}

function projectBoundedDirectory(
  authorized: readonly StoreProfileSnapshot[],
): AuthorizedStoreDirectory {
  if (authorized.length <= AUTHORIZED_STORE_LIMIT) {
    return Object.freeze({ stores: Object.freeze([...authorized]), truncated: false });
  }
  const first = authorized.slice(0, AUTHORIZED_STORE_LIMIT);
  if (!first.some((store) => store.isCurrent)) {
    const current = authorized.find((store) => store.isCurrent);
    if (current === undefined) throw new TypeError("current authorized store is missing");
    first[AUTHORIZED_STORE_LIMIT - 1] = current;
    first.sort(compareStoreCodes);
  }
  return Object.freeze({ stores: Object.freeze(first), truncated: true });
}

async function listAuthorized(
  client: SqlClient,
  tenant: TenantContext,
): Promise<AuthorizedStoreDirectory> {
  const candidates = await client.query<StoreRow>(LIST_CANDIDATES_SQL, [
    tenant.orgId,
    STORE_CANDIDATE_QUERY_LIMIT,
  ]);
  if (candidates.rows.length > MAXIMUM_STORE_CANDIDATES) {
    throw new RangeError("PostgreSQL store candidate limit exceeded");
  }
  const authorized: StoreProfileSnapshot[] = [];
  try {
    for (const row of candidates.rows) {
      await client.query(SET_STORE_GUC_SQL, [row.id]);
      if (await actorIsStoreAdmin(client, tenant, row.id)) {
        authorized.push(toSnapshot(row, tenant.storeId));
      }
    }
  } finally {
    await client.query(SET_STORE_GUC_SQL, [tenant.storeId]);
  }
  if (!authorized.some((store) => store.isCurrent)) {
    throw new TypeError("current PostgreSQL store is not authorized");
  }
  return projectBoundedDirectory(authorized.sort(compareStoreCodes));
}

async function updateCurrent(
  client: SqlClient,
  tenant: TenantContext,
  input: Readonly<{ expectedProfileVersion: number; storeName: string; at: Date }>,
): Promise<StoreProfileUpdateResult> {
  const found = await client.query<StoreRow>(READ_CURRENT_SQL, [tenant.orgId, tenant.storeId]);
  const row = found.rows[0];
  if (row === undefined) return Object.freeze({ ok: false as const, reason: "missing" as const });
  const before = toSnapshot(row, tenant.storeId);
  if (before.profileVersion !== input.expectedProfileVersion) {
    return Object.freeze({ ok: false as const, reason: "stale" as const });
  }
  if (before.storeName === input.storeName) {
    return Object.freeze({ ok: false as const, reason: "unchanged" as const });
  }
  const changed = await client.query<StoreRow>(UPDATE_CURRENT_SQL, [
    tenant.orgId,
    tenant.storeId,
    input.storeName,
    input.at.toISOString(),
    input.expectedProfileVersion,
  ]);
  const updated = changed.rows[0];
  if (updated === undefined) return Object.freeze({ ok: false as const, reason: "stale" as const });
  return Object.freeze({
    ok: true as const,
    before,
    after: toSnapshot(updated, tenant.storeId),
  });
}

export function createPgStoreManagementStore(): StoreManagementStore {
  return Object.freeze({ listAuthorized, updateCurrent });
}
