/**
 * Seed the minimum price list a counter workday needs.
 *
 * `order.receive` resolves prices from the active catalog and refuses a line
 * whose (service_code, category_code) does not match exactly one active item.
 * Nothing seeds catalog_items — not the migrations, not bootstrap — and the
 * frozen M2 contract surface exposes only catalog queries, so a fresh local
 * install cannot take an order until rows exist. The browser workday E2E seeds
 * them here rather than reaching into the database from the spec.
 *
 * Idempotent: re-running updates the same rows instead of duplicating them.
 */

import { createRequire } from "node:module";

import { ensureLocalConfig } from "./config.mjs";

// pg is a direct dependency of @laundry/server; resolve it from there so this
// tooling needs no dependency of its own.
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
/** @type {{ Pool: new (config: { connectionString: string }) => any }} */
const { Pool } = require("pg");

const DEMO_ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEMO_STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Deterministic ids keep re-runs from creating duplicate rows. */
export const COUNTER_CATALOG = Object.freeze([
  Object.freeze({
    id: "cccccccc-0000-4000-8000-000000000001",
    code: "wash-shirt",
    name: "水洗衬衫",
    serviceCode: "wash",
    categoryCode: "shirt",
    unitPriceCents: 1_500,
    mnemonic: "SXCS",
    sortOrder: 0,
  }),
  Object.freeze({
    id: "cccccccc-0000-4000-8000-000000000002",
    code: "dry-coat",
    name: "干洗大衣",
    serviceCode: "dry",
    categoryCode: "coat",
    unitPriceCents: 4_800,
    mnemonic: "GXDY",
    sortOrder: 1,
  }),
]);

function adminConnectionString(config) {
  const url = new URL("postgresql://127.0.0.1:8543/laundry_v2");
  url.username = "postgres";
  url.password = config.postgresSuperuserPassword;
  return url.toString();
}

export async function seedCounterCatalog(env = process.env) {
  const config = await ensureLocalConfig({ env });
  const pool = new Pool({ connectionString: adminConnectionString(config) });
  try {
    for (const item of COUNTER_CATALOG) {
      await pool.query(
        `INSERT INTO catalog_items (
           id, org_id, store_id, code, name, service_code, category_code,
           unit_price_cents, mnemonic, is_active, sort_order, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, now(), now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           unit_price_cents = EXCLUDED.unit_price_cents,
           is_active = true,
           updated_at = now()`,
        [
          item.id,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          item.code,
          item.name,
          item.serviceCode,
          item.categoryCode,
          item.unitPriceCents,
          item.mnemonic,
          item.sortOrder,
        ],
      );
    }
    return COUNTER_CATALOG.length;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedCounterCatalog()
    .then((count) => {
      process.stdout.write(`LOCAL_CATALOG_SEEDED count=${count}\n`);
    })
    .catch((error) => {
      process.stderr.write(`LOCAL_CATALOG_SEED_FAILED ${String(error?.code ?? error)}\n`);
      process.exitCode = 1;
    });
}
