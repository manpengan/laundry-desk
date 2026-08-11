/** PostgreSQL catalog repository under the authenticated store RLS scope. */

import type { CatalogItem } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type {
  CatalogAuditAction,
  CatalogAuditFilter,
  CatalogAuditItem,
  CatalogManagedItem,
  CatalogManagementList,
  CatalogReorderChange,
  CatalogReorderEntry,
  CatalogStore,
  CatalogUpsertChange,
  CatalogUpsertInput,
} from "./types.js";

export type CreatePgCatalogStoreOptions = Readonly<{
  orgId: string;
  storeId: string;
  newId?: () => string;
}>;

type CatalogRow = Readonly<{
  code: string;
  name: string;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  mnemonic: string | null;
  is_active: boolean;
  sort_order: number;
  version: number;
  updated_at: Date | string;
  total?: number | string;
}>;

const SELECT_FIELDS = `code, name, service_code, category_code, unit_price_cents,
  mnemonic, is_active, sort_order, version, updated_at`;

function epoch(value: Date | string): number {
  return Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1_000);
}

function mapManaged(row: CatalogRow): CatalogManagedItem {
  return Object.freeze({
    code: row.code,
    name: row.name,
    service_code: row.service_code,
    category_code: row.category_code,
    unit_price_cents: row.unit_price_cents,
    ...(row.mnemonic === null || row.mnemonic.length === 0 ? {} : { mnemonic: row.mnemonic }),
    is_active: row.is_active,
    sort_order: row.sort_order,
    version: row.version,
    updated_at: epoch(row.updated_at),
  });
}

function toCatalogItem(row: CatalogRow): CatalogItem {
  const managed = mapManaged(row);
  return Object.freeze({
    code: managed.code,
    name: managed.name,
    service_code: managed.service_code,
    category_code: managed.category_code,
    unit_price_cents: managed.unit_price_cents,
    ...(managed.mnemonic === undefined ? {} : { mnemonic: managed.mnemonic }),
  });
}

async function loadActiveItems(client: SqlClient, orgId: string, storeId: string) {
  const result = await client.query<CatalogRow>(
    `SELECT ${SELECT_FIELDS} FROM catalog_items
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND is_active = true
      ORDER BY sort_order ASC, code ASC`,
    [orgId, storeId],
  );
  return Object.freeze(result.rows.map(toCatalogItem));
}

async function loadManagement(
  client: SqlClient,
  orgId: string,
  storeId: string,
  query: string,
  limit: number,
): Promise<CatalogManagementList> {
  const pattern = `%${query}%`;
  const result = await client.query<CatalogRow>(
    `SELECT ${SELECT_FIELDS}, count(*) OVER()::integer AS total
       FROM catalog_items
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND ($3 = '' OR concat_ws(' ', code, name, service_code, category_code, mnemonic) ILIKE $4)
      ORDER BY is_active DESC, sort_order ASC, code ASC
      LIMIT $5`,
    [orgId, storeId, query, pattern, limit],
  );
  return Object.freeze({
    items: Object.freeze(result.rows.map(mapManaged)),
    total: Number(result.rows[0]?.total ?? 0),
  });
}

async function acquireWriteLock(client: SqlClient, orgId: string, storeId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `catalog:${orgId}:${storeId}`,
  ]);
}

async function loadOneForUpdate(
  client: SqlClient,
  orgId: string,
  storeId: string,
  code: string,
): Promise<CatalogManagedItem | null> {
  const result = await client.query<CatalogRow>(
    `SELECT ${SELECT_FIELDS} FROM catalog_items
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND code = $3
      FOR UPDATE`,
    [orgId, storeId, code],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapManaged(row);
}

async function nextSortOrder(client: SqlClient, orgId: string, storeId: string): Promise<number> {
  const result = await client.query<{ next_sort_order: number }>(
    `SELECT COALESCE(max(sort_order), -1)::integer + 1 AS next_sort_order
       FROM catalog_items WHERE org_id = $1::uuid AND store_id = $2::uuid`,
    [orgId, storeId],
  );
  return result.rows[0]?.next_sort_order ?? 0;
}

async function writeUpsert(
  client: SqlClient,
  orgId: string,
  storeId: string,
  newId: () => string,
  input: CatalogUpsertInput,
): Promise<CatalogUpsertChange | null> {
  await acquireWriteLock(client, orgId, storeId);
  const before = await loadOneForUpdate(client, orgId, storeId, input.code);
  if (
    (before === null && input.expected_version !== undefined && input.expected_version !== 0) ||
    (before !== null &&
      input.expected_version !== undefined &&
      input.expected_version !== before.version)
  ) {
    return null;
  }
  const sortOrder =
    input.sort_order ?? before?.sort_order ?? (await nextSortOrder(client, orgId, storeId));
  const params = [
    orgId,
    storeId,
    input.code,
    input.name,
    input.service_code,
    input.category_code,
    input.unit_price_cents,
    input.mnemonic ?? null,
    input.is_active,
    sortOrder,
  ] as const;
  const result =
    before === null
      ? await client.query<CatalogRow>(
          `INSERT INTO catalog_items (
             id, org_id, store_id, code, name, service_code, category_code,
             unit_price_cents, mnemonic, is_active, sort_order, created_at, updated_at
           ) VALUES ($11::uuid,$1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
           RETURNING ${SELECT_FIELDS}`,
          [...params, newId()],
        )
      : await client.query<CatalogRow>(
          `UPDATE catalog_items SET
             name=$4, service_code=$5, category_code=$6, unit_price_cents=$7,
             mnemonic=$8, is_active=$9, sort_order=$10, updated_at=now()
           WHERE org_id=$1::uuid AND store_id=$2::uuid AND code=$3
           RETURNING ${SELECT_FIELDS}`,
          params,
        );
  const row = result.rows[0];
  if (row === undefined) throw new Error("catalog upsert returned no row");
  return Object.freeze({ before, after: mapManaged(row), created: before === null });
}

function sameActiveSnapshot(
  current: readonly CatalogManagedItem[],
  wanted: readonly CatalogReorderEntry[],
): boolean {
  if (
    current.length !== wanted.length ||
    new Set(wanted.map((item) => item.code)).size !== wanted.length
  )
    return false;
  const byCode = new Map(current.map((item) => [item.code, item]));
  return wanted.every((item) => byCode.get(item.code)?.version === item.expected_version);
}

async function loadActiveManagedForUpdate(client: SqlClient, orgId: string, storeId: string) {
  const result = await client.query<CatalogRow>(
    `SELECT ${SELECT_FIELDS} FROM catalog_items
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND is_active=true
      ORDER BY sort_order ASC, code ASC FOR UPDATE`,
    [orgId, storeId],
  );
  return Object.freeze(result.rows.map(mapManaged));
}

async function reorderItems(
  client: SqlClient,
  orgId: string,
  storeId: string,
  items: readonly CatalogReorderEntry[],
): Promise<CatalogReorderChange | null> {
  await acquireWriteLock(client, orgId, storeId);
  const before = await loadActiveManagedForUpdate(client, orgId, storeId);
  if (!sameActiveSnapshot(before, items)) return null;
  if (items.length > 0) {
    await client.query(
      `WITH desired(code, sort_order) AS (
         SELECT * FROM unnest($3::text[], $4::integer[])
       )
       UPDATE catalog_items AS item
          SET sort_order=desired.sort_order,
              updated_at=CASE WHEN item.sort_order IS DISTINCT FROM desired.sort_order
                              THEN now() ELSE item.updated_at END
         FROM desired
        WHERE item.org_id=$1::uuid AND item.store_id=$2::uuid AND item.code=desired.code`,
      [orgId, storeId, items.map((item) => item.code), items.map((_, index) => index)],
    );
  }
  const after = await loadActiveManagedForUpdate(client, orgId, storeId);
  return Object.freeze({ before, after });
}

const CATALOG_ACTIONS = new Set<CatalogAuditAction>([
  "created",
  "updated",
  "retired",
  "reactivated",
  "reordered",
  "unchanged",
]);

function auditProjection(row: {
  id: string;
  at_epoch_s: number | string;
  command: string;
  staff_id: string | null;
  entity_id: string | null;
  after_json: string | null;
}): CatalogAuditItem {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = row.after_json === null ? {} : JSON.parse(row.after_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  const rawAction = payload.action;
  const action: CatalogAuditAction =
    typeof rawAction === "string" && CATALOG_ACTIONS.has(rawAction as CatalogAuditAction)
      ? (rawAction as CatalogAuditAction)
      : row.command === "catalog.items.reorder"
        ? "reordered"
        : payload.created === true
          ? "created"
          : payload.is_active === false
            ? "retired"
            : "updated";
  const rawCodes = Array.isArray(payload.codes) ? payload.codes : [];
  const codes = rawCodes.filter((code): code is string => typeof code === "string");
  if (codes.length === 0 && row.entity_id !== null) codes.push(row.entity_id);
  return Object.freeze({
    id: row.id,
    at_epoch_s: Number(row.at_epoch_s),
    staff_id: row.staff_id,
    action,
    codes: Object.freeze([...codes]),
  });
}

async function loadAudit(
  client: SqlClient,
  orgId: string,
  storeId: string,
  filter: CatalogAuditFilter,
): Promise<readonly CatalogAuditItem[]> {
  const result = await client.query<{
    id: string;
    at_epoch_s: number | string;
    command: string;
    staff_id: string | null;
    entity_id: string | null;
    after_json: string | null;
  }>(
    `SELECT id, EXTRACT(EPOCH FROM at)::bigint AS at_epoch_s,
            command, staff_id, entity_id, after_json
       FROM audit_log
      WHERE org_id=$1::uuid AND store_id=$2::uuid
        AND command IN ('catalog.item.upsert', 'catalog.items.reorder')
        AND at >= to_timestamp($3) AND at <= to_timestamp($4)
        AND ($5::text IS NULL OR entity_id=$5 OR
             (after_json IS JSON AND jsonb_typeof(after_json::jsonb->'codes')='array'
              AND (after_json::jsonb->'codes') ? $5))
      ORDER BY at DESC, id DESC LIMIT $6`,
    [orgId, storeId, filter.from_epoch_s, filter.to_epoch_s, filter.code ?? null, filter.limit],
  );
  return Object.freeze(result.rows.map(auditProjection));
}

export function createPgCatalogStore(
  pool: PgPool,
  options: CreatePgCatalogStoreOptions,
): CatalogStore {
  const { orgId, storeId } = options;
  const newId = options.newId ?? randomUUID;
  const scoped = <T>(fn: (client: SqlClient) => Promise<T>) =>
    withStoreGucOrCurrent(pool, { orgId, storeId }, fn);
  return Object.freeze({
    listAll: () => scoped((client) => loadActiveItems(client, orgId, storeId)),
    manageList: (query, limit) =>
      scoped((client) => loadManagement(client, orgId, storeId, query, limit)),
    upsert: (input) => scoped((client) => writeUpsert(client, orgId, storeId, newId, input)),
    reorder: (items) => scoped((client) => reorderItems(client, orgId, storeId, items)),
    listAudit: (filter) => scoped((client) => loadAudit(client, orgId, storeId, filter)),
  });
}
