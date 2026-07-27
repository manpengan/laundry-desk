/**
 * Postgres CatalogStore: laundry_app + withStoreGuc (SET LOCAL tenant GUCs).
 * Empty stores remain empty until an explicit catalog command writes rows.
 */

import type { CatalogItem } from "@laundry/domain";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type { CatalogStore } from "./memory-catalog.js";

export type CreatePgCatalogStoreOptions = Readonly<{
  orgId: string;
  storeId: string;
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
export function createPgCatalogStore(
  pool: PgPool,
  options: CreatePgCatalogStoreOptions,
): CatalogStore {
  const { orgId, storeId } = options;

  return Object.freeze({
    listAll: async (): Promise<readonly CatalogItem[]> =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        loadActiveItems(client, orgId, storeId),
      ),
  });
}
