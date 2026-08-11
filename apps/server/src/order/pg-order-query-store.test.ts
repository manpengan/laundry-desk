/** Bounded order query store decisions plus the opt-in live PostgreSQL smoke. */

import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgOrderStore } from "./pg-order-store.js";

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
  const query = async (sql: string, params?: readonly unknown[]) => {
    queries.push(Object.freeze({ sql, params }));
    return handler?.(sql, params) ?? { rows: [], rowCount: 0 };
  };
  const client = Object.freeze({ query, release() {} }) as unknown as PgPoolClient;
  const pool = Object.freeze({ connect: async () => client, query }) as unknown as PgPool;
  return { pool, queries };
}

const ORDER_ROW = Object.freeze({
  order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ticket_no: "20260722-0001",
  pickup_code: "P202607220001",
  status: "open",
  customer_phone: "13800000111",
  customer_name: "甲",
  payable_cents: 3_000,
  paid_cents: 500,
  balance_cents: 2_500,
  created_at: new Date("2024-07-22T12:34:56.000Z"),
  garment_count: 2,
});

test("listOrderSummaries issues exactly one aggregate query carrying every filter", async () => {
  const { pool, queries } = createCapturingPool((sql) =>
    sql.includes("COUNT(g.id)") ? { rows: [ORDER_ROW], rowCount: 1 } : { rows: [], rowCount: 0 },
  );
  const store = createPgOrderStore(pool);
  assert.ok(store.listOrderSummaries);

  const summaries = await store.listOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
    businessDate: "2024-07-22",
    status: "open",
    customerPhone: "13800000111",
    minBalanceCents: 1,
    limit: 7,
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.garment_count, 2);
  assert.equal(summaries[0]?.created_at, Math.floor(ORDER_ROW.created_at.getTime() / 1_000));
  const summaryQueries = queries.filter((query) => query.sql.includes("COUNT(g.id)"));
  assert.equal(summaryQueries.length, 1, "the list must not fan out into per-order queries");
  assert.deepEqual(summaryQueries[0]!.params, [
    DEMO_ORG_ID,
    DEMO_STORE_ID,
    "open",
    "13800000111",
    "2024-07-22",
    1,
    7,
  ]);
});

test("listOrderSummaries short-circuits an out-of-range PostgreSQL integer", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgOrderStore(pool);
  assert.ok(store.listOrderSummaries);

  const summaries = await store.listOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
    minBalanceCents: 2_147_483_648,
    limit: 20,
  });
  assert.deepEqual(summaries, []);
  assert.equal(
    queries.some((query) => query.sql.includes("COUNT(g.id)")),
    false,
  );
  assert.equal(queries[0]?.sql, "BEGIN");
  assert.equal(queries.at(-1)?.sql, "COMMIT");
});

test("lookupOrderSummaries stays a single bounded query and maps matched_by", async () => {
  const { pool, queries } = createCapturingPool((sql) =>
    sql.includes("AS matched_by")
      ? { rows: [{ ...ORDER_ROW, matched_by: "garment_barcode" }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
  const store = createPgOrderStore(pool);
  assert.ok(store.lookupOrderSummaries);

  const summaries = await store.lookupOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
    key: "BBBBBBBBBBBBBBBB",
    status: "open",
    limit: 20,
  });
  assert.equal(summaries[0]?.matched_by, "garment_barcode");
  assert.equal(summaries[0]?.pickup_code, ORDER_ROW.pickup_code);
  const lookups = queries.filter((query) => query.sql.includes("AS matched_by"));
  assert.equal(lookups.length, 1, "the lookup must stay a single bounded query");
  assert.deepEqual(lookups[0]!.params, [
    DEMO_ORG_ID,
    DEMO_STORE_ID,
    "BBBBBBBBBBBBBBBB",
    "open",
    20,
  ]);
});

const pgOptIn =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true";
const urls = pgOptIn ? resolvePgUrls(process.env) : null;
const maybePg = urls === null ? test.skip : test;

maybePg("PG order store smoke", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });
  try {
    const store = createPgOrderStore(pool);
    const seq = await store.nextTicketSeq(DEMO_ORG_ID, DEMO_STORE_ID, "20990101");
    assert.ok(seq >= 1);
  } finally {
    await pool.end();
  }
});
