/**
 * Postgres CatalogStore: laundry_app + withStoreGuc (SET LOCAL tenant GUCs).
 * Empty stores remain empty until an explicit catalog command writes rows.
 */

import type { CatalogItem } from "@laundry/domain";

import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type { CatalogStore, CatalogUpsertInput, CatalogUpsertResult } from "./memory-catalog.js";

export type CreatePgCatalogStoreOptions = Readonly<{
  orgId: string;
  storeId: string;
  /** Override id generation (tests). */
  newId?: () => string;
}>;

type CatalogItemRow = Readonly<{
  code: string;
  name: string;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  mnemonic: string | null;
}>;

function mapRow(row: CatalogItemRow): CatalogItem {
  const item: CatalogItem = Object.freeze({
    code: row.code,
    name: row.name,
    service_code: row.service_code,
    category_code: row.category_code,
    unit_price_cents: row.unit_price_cents,
    ...(row.mnemonic !== null && row.mnemonic.length > 0 ? { mnemonic: row.mnemonic } : {}),
  });
  return item;
}

async function loadActiveItems(
  client: SqlClient,
  orgId: string,
  storeId: string,
): Promise<readonly CatalogItem[]> {
  const result = await client.query<CatalogItemRow>(
    `SELECT code, name, service_code, category_code, unit_price_cents, mnemonic
     FROM catalog_items
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND is_active = true
     ORDER BY sort_order ASC, code ASC`,
    [orgId, storeId],
  );
  return Object.freeze(result.rows.map(mapRow));
}

/**
 * Create a CatalogStore backed by Postgres under laundry_app RLS GUC scope.
 * Reads never create rows.
 */
/**
 * Upsert one price item by (org, store, code).
 *
 * `xmax = 0` distinguishes an insert from an update on the conflict path, so the
 * caller can report created vs updated without a second round trip.
 */
async function upsertItem(
  client: SqlClient,
  orgId: string,
  storeId: string,
  newId: () => string,
  input: CatalogUpsertInput,
): Promise<CatalogUpsertResult> {
  const result = await client.query<{ code: string; created: boolean }>(
    `INSERT INTO catalog_items (
       id, org_id, store_id, code, name, service_code, category_code,
       unit_price_cents, mnemonic, is_active, sort_order, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
     ON CONFLICT (org_id, store_id, code) DO UPDATE SET
       name = EXCLUDED.name,
       service_code = EXCLUDED.service_code,
       category_code = EXCLUDED.category_code,
       unit_price_cents = EXCLUDED.unit_price_cents,
       mnemonic = EXCLUDED.mnemonic,
       is_active = EXCLUDED.is_active,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()
     RETURNING code, (xmax = 0) AS created`,
    [
      newId(),
      orgId,
      storeId,
      input.code,
      input.name,
      input.service_code,
      input.category_code,
      input.unit_price_cents,
      input.mnemonic ?? null,
      input.is_active,
      input.sort_order ?? 0,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("catalog upsert returned no row");
  }
  return Object.freeze({ code: row.code, created: row.created });
}

export function createPgCatalogStore(
  pool: PgPool,
  options: CreatePgCatalogStoreOptions,
): CatalogStore {
  const { orgId, storeId } = options;
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    listAll: async (): Promise<readonly CatalogItem[]> =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        loadActiveItems(client, orgId, storeId),
      ),
    upsert: async (input: CatalogUpsertInput): Promise<CatalogUpsertResult> =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        upsertItem(client, orgId, storeId, newId, input),
      ),
  });
}
