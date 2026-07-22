/**
 * Postgres CatalogStore: laundry_app + withStoreGuc (SET LOCAL tenant GUCs).
 * Seeds DEMO_CATALOG_ITEMS on first listAll when the store has no rows.
 */

import { randomUUID } from "node:crypto";

import type { CatalogItem } from "@laundry/domain";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import type { CatalogStore } from "./memory-catalog.js";
import { DEMO_CATALOG_ITEMS } from "./memory-catalog.js";

export type CreatePgCatalogStoreOptions = Readonly<{
  orgId: string;
  storeId: string;
  /** Seed rows when table empty for this store (default DEMO_CATALOG_ITEMS). */
  seedItems?: readonly CatalogItem[];
  /** Override UUID generation (tests). */
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

async function countItems(client: PgPoolClient, orgId: string, storeId: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
     FROM catalog_items
     WHERE org_id = $1::uuid AND store_id = $2::uuid`,
    [orgId, storeId],
  );
  const n = result.rows[0]?.n;
  return n === undefined ? 0 : Number.parseInt(n, 10);
}

async function seedIfEmpty(
  client: PgPoolClient,
  orgId: string,
  storeId: string,
  seedItems: readonly CatalogItem[],
  newId: () => string,
): Promise<void> {
  const existing = await countItems(client, orgId, storeId);
  if (existing > 0) return;

  const now = new Date();
  for (let i = 0; i < seedItems.length; i += 1) {
    const item = seedItems[i];
    if (item === undefined) continue;
    await client.query(
      `INSERT INTO catalog_items (
         id, org_id, store_id, code, name, service_code, category_code,
         unit_price_cents, mnemonic, is_active, sort_order, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, true, $10, $11, $11
       )
       ON CONFLICT (org_id, store_id, code) DO NOTHING`,
      [
        newId(),
        orgId,
        storeId,
        item.code,
        item.name,
        item.service_code,
        item.category_code,
        item.unit_price_cents,
        item.mnemonic ?? null,
        i,
        now,
      ],
    );
  }
}

async function loadActiveItems(
  client: PgPoolClient,
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
 * First listAll seeds demo items when the store catalog is empty.
 */
export function createPgCatalogStore(
  pool: PgPool,
  options: CreatePgCatalogStoreOptions,
): CatalogStore {
  const { orgId, storeId } = options;
  const seedItems = options.seedItems ?? DEMO_CATALOG_ITEMS;
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    listAll: async (): Promise<readonly CatalogItem[]> =>
      withStoreGuc(pool, { orgId, storeId }, async (client) => {
        await seedIfEmpty(client, orgId, storeId, seedItems, newId);
        return loadActiveItems(client, orgId, storeId);
      }),
  });
}
