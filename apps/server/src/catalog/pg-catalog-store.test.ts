/**
 * Unit tests for createPgCatalogStore row mapping.
 *
 * listAll's real behaviour — that a fresh install reads an empty price list,
 * that retired items drop out, and that nothing is auto-seeded — is proven on a
 * real database in pg-catalog-upsert.test.ts, which drives the same store
 * through the command bus. What is left here is the mapping the store itself
 * performs, which needs no database.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgCatalogStore } from "./pg-catalog-store.js";

type RecordedQuery = Readonly<{
  sql: string;
  params: readonly unknown[] | undefined;
}>;

type MockQueryHandler = (
  sql: string,
  params: readonly unknown[] | undefined,
) => { rows: readonly unknown[]; rowCount: number };

function createCapturingPool(handler?: MockQueryHandler): {
  pool: PgPool;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const queryImpl = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly unknown[]; rowCount: number }> => {
    queries.push(Object.freeze({ sql, params }));
    if (handler !== undefined) {
      return handler(sql, params);
    }
    return { rows: [], rowCount: 0 };
  };

  const client = {
    query: queryImpl,
    release() {
      // mock
    },
  } as unknown as PgPoolClient;

  const pool = {
    connect: async () => client,
    query: queryImpl,
  } as unknown as PgPool;

  return { pool, queries };
}

// Reading a price list must never write one. This is a property of the store's
// own statements, so it holds regardless of what the database would return —
// the mock answers unconditionally rather than keying off the SQL text.
test("listAll never issues a write, empty or not", async () => {
  const { pool, queries } = createCapturingPool(() => ({ rows: [], rowCount: 0 }));

  const store = createPgCatalogStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });

  const items = await store.listAll();
  assert.deepEqual(items, []);
  assert.equal(queries.filter((query) => /\b(INSERT|UPDATE|DELETE)\b/iu.test(query.sql)).length, 0);
  assert.ok(queries.some((query) => query.params?.includes(DEMO_STORE_ID)));
});

test("listAll maps a row onto the catalog item shape", async () => {
  const { pool, queries } = createCapturingPool((sql) => {
    if (sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    return {
      rows: [
        {
          code: "custom_item",
          name: "定制",
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 100,
          mnemonic: null,
        },
      ],
      rowCount: 1,
    };
  });

  const store = createPgCatalogStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });

  const items = await store.listAll();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.code, "custom_item");
  assert.equal(items[0]?.name, "定制");
  assert.equal(items[0]?.unit_price_cents, 100);
  assert.equal(items[0]?.mnemonic, undefined);
  assert.equal(queries.filter((query) => /\bINSERT\b/iu.test(query.sql)).length, 0);
});

test("mapRow omits empty mnemonic", async () => {
  const { pool } = createCapturingPool((sql) => {
    if (sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM catalog_items")) {
      return {
        rows: [
          {
            code: "x",
            name: "X",
            service_code: "wash",
            category_code: "shirt",
            unit_price_cents: 1,
            mnemonic: "",
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const items = await createPgCatalogStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  }).listAll();
  assert.equal(items[0]?.mnemonic, undefined);
});
