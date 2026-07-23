/**
 * Unit tests for createPgOrderStore with a capturing mock pool.
 * Real PG integration is skipped unless LAUNDRY_USE_LOCAL_PG=1 (tables may not exist yet).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { buildLineIdByIndex, mapOrder, mapOrderLine } from "./pg-order-mappers.js";
import { createPgOrderStore } from "./pg-order-store.js";
import type { GarmentRecord, OrderRecord } from "./types.js";

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
    if (sql.includes("ticket_counters") && sql.includes("RETURNING")) {
      return { rows: [{ last_seq: 3 }], rowCount: 1 };
    }
    if (sql.trimStart().toUpperCase().startsWith("SELECT") && sql.includes("FROM orders")) {
      return { rows: [], rowCount: 0 };
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

const sampleOrder = (): OrderRecord =>
  Object.freeze({
    order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    ticket_no: "20260722-0001",
    status: "open" as const,
    customer_phone: "13800000111",
    customer_name: null,
    note: null,
    lines: Object.freeze([
      Object.freeze({
        line_index: 0,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 1500,
        qty: 2,
        line_total_cents: 3000,
        color: null,
        brand: null,
      }),
    ]),
    subtotal_cents: 3000,
    payable_cents: 3000,
    paid_cents: 500,
    balance_cents: 2500,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    created_by_staff_id: DEMO_STAFF_A_ID,
  });

const sampleGarments = (): readonly GarmentRecord[] =>
  Object.freeze([
    Object.freeze({
      garment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      line_index: 0,
      seq: 1,
      barcode: "BBBBBBBBBBBBBBBB",
      service_code: "wash",
      category_code: "shirt",
      unit_price_cents: 1500,
      color: null,
      brand: null,
      status: "received" as const,
    }),
    Object.freeze({
      garment_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      line_index: 0,
      seq: 2,
      barcode: "CCCCCCCCCCCCCCCC",
      service_code: "wash",
      category_code: "shirt",
      unit_price_cents: 1500,
      color: null,
      brand: null,
      status: "received" as const,
    }),
  ]);

test("buildLineIdByIndex maps each line_index to a stable id", () => {
  let n = 0;
  const map = buildLineIdByIndex(sampleOrder().lines, () => {
    n += 1;
    return `line-${n}`;
  });
  assert.equal(map.get(0), "line-1");
  assert.equal(map.size, 1);
});

test("mapOrder + mapOrderLine preserve cents and line_index", () => {
  const line = mapOrderLine({
    id: "line-1",
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    order_id: "ord-1",
    line_index: 2,
    service_code: "wash",
    category_code: "coat",
    unit_price_cents: 4000,
    qty: 1,
    line_total_cents: 4000,
    color: "black",
    brand: null,
  });
  assert.equal(line.line_index, 2);
  assert.equal(line.unit_price_cents, 4000);

  const order = mapOrder(
    {
      id: "ord-1",
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      ticket_no: "20260722-0009",
      status: "open",
      customer_phone: null,
      customer_name: null,
      note: null,
      subtotal_cents: 4000,
      payable_cents: 4000,
      paid_cents: 0,
      balance_cents: 4000,
      created_at: new Date("2026-07-22T00:00:00Z"),
      updated_at: new Date("2026-07-22T00:00:00Z"),
      created_by_staff_id: DEMO_STAFF_A_ID,
    },
    [line],
  );
  assert.equal(order.order_id, "ord-1");
  assert.equal(order.lines[0]?.line_index, 2);
  assert.equal(order.created_at, Math.floor(Date.parse("2026-07-22T00:00:00Z") / 1000));
});

test("nextTicketSeq issues UPSERT on ticket_counters and returns last_seq", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgOrderStore(pool);
  const seq = await store.nextTicketSeq(DEMO_ORG_ID, DEMO_STORE_ID, "20260722");
  assert.equal(seq, 3);
  const upsert = queries.find((q) => q.sql.includes("ticket_counters"));
  assert.ok(upsert);
  assert.match(upsert.sql, /ON CONFLICT/u);
  assert.match(upsert.sql, /RETURNING last_seq/u);
  assert.deepEqual(upsert.params?.slice(0, 3), [DEMO_ORG_ID, DEMO_STORE_ID, "20260722"]);
});

test("insertOrder writes order + lines + garments with generated order_line_id", async () => {
  const { pool, queries } = createCapturingPool();
  let idSeq = 0;
  const store = createPgOrderStore(pool, {
    newId: () => {
      idSeq += 1;
      return `00000000-0000-4000-8000-00000000000${idSeq}`;
    },
  });
  await store.insertOrder(sampleOrder(), sampleGarments());

  const inserts = queries.filter((q) => q.sql.trimStart().toUpperCase().startsWith("INSERT"));
  assert.ok(inserts.some((q) => q.sql.includes("INTO orders")));
  assert.ok(inserts.some((q) => q.sql.includes("INTO order_lines")));
  assert.ok(inserts.some((q) => q.sql.includes("INTO garments")));

  const lineInsert = inserts.find((q) => q.sql.includes("INTO order_lines"));
  assert.ok(lineInsert);
  // $1 = line id, $5 = line_index
  assert.equal(lineInsert.params?.[0], "00000000-0000-4000-8000-000000000001");
  assert.equal(lineInsert.params?.[4], 0);

  const garmentInserts = inserts.filter((q) => q.sql.includes("INTO garments"));
  assert.equal(garmentInserts.length, 2);
  for (const g of garmentInserts) {
    // order_line_id is $5
    assert.equal(g.params?.[4], "00000000-0000-4000-8000-000000000001");
  }

  // GUC set_config must run inside the txn
  assert.ok(queries.some((q) => q.sql.includes("set_config") && q.sql.includes("app.org_id")));
  assert.ok(queries.some((q) => q.sql.includes("set_config") && q.sql.includes("app.store_id")));
});

test("getOrder returns null when no order row", async () => {
  const { pool } = createCapturingPool();
  const store = createPgOrderStore(pool);
  const found = await store.getOrder(DEMO_ORG_ID, DEMO_STORE_ID, sampleOrder().order_id);
  assert.equal(found, null);
});

test("applyPickup updates garments to picked_up and settles balance", async () => {
  const order = sampleOrder();
  const garments = sampleGarments();
  const handler: MockQueryHandler = (sql) => {
    if (sql.includes("FROM orders") && sql.includes("WHERE")) {
      return {
        rows: [
          {
            id: order.order_id,
            org_id: order.org_id,
            store_id: order.store_id,
            ticket_no: order.ticket_no,
            status: order.status,
            customer_phone: order.customer_phone,
            customer_name: order.customer_name,
            note: order.note,
            subtotal_cents: order.subtotal_cents,
            payable_cents: order.payable_cents,
            paid_cents: order.paid_cents,
            balance_cents: order.balance_cents,
            created_at: new Date(order.created_at * 1000),
            updated_at: new Date(order.updated_at * 1000),
            created_by_staff_id: order.created_by_staff_id,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM order_lines")) {
      return {
        rows: [
          {
            id: "line-uuid",
            org_id: order.org_id,
            store_id: order.store_id,
            order_id: order.order_id,
            line_index: 0,
            service_code: "wash",
            category_code: "shirt",
            unit_price_cents: 1500,
            qty: 2,
            line_total_cents: 3000,
            color: null,
            brand: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM garments")) {
      return {
        rows: garments.map((g) => ({
          id: g.garment_id,
          org_id: g.org_id,
          store_id: g.store_id,
          order_id: g.order_id,
          order_line_id: "line-uuid",
          line_index: g.line_index,
          seq: g.seq,
          barcode: g.barcode,
          service_code: g.service_code,
          category_code: g.category_code,
          unit_price_cents: g.unit_price_cents,
          color: g.color,
          brand: g.brand,
          status: g.status,
        })),
        rowCount: garments.length,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  const { pool, queries } = createCapturingPool(handler);
  const store = createPgOrderStore(pool, {
    newId: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  const applied = await store.applyPickup(
    DEMO_ORG_ID,
    DEMO_STORE_ID,
    order.order_id,
    garments.map((g) => g.garment_id),
    2500,
    1_700_000_100,
    Object.freeze({ staffId: DEMO_STAFF_A_ID, method: "cash" as const }),
  );
  assert.ok(applied);
  assert.equal(applied.order.paid_cents, 3000);
  assert.equal(applied.order.balance_cents, 0);
  assert.equal(applied.order.status, "closed");
  assert.equal(
    applied.garments.every((g) => g.status === "picked_up"),
    true,
  );

  assert.ok(queries.some((q) => q.sql.includes("UPDATE garments") && q.sql.includes("picked_up")));
  assert.ok(queries.some((q) => q.sql.includes("UPDATE orders")));
  const paymentInsert = queries.find((q) => q.sql.includes("INTO payments"));
  assert.ok(paymentInsert, "expected INSERT INTO payments when collectCents > 0");
  assert.equal(paymentInsert.params?.[4], "cash");
  assert.equal(paymentInsert.params?.[5], 2500);
  assert.equal(paymentInsert.params?.[6], "pay");
  assert.equal(paymentInsert.params?.[8], DEMO_STAFF_A_ID);
});

test("applyPickup with collectCents 0 skips payments insert", async () => {
  const order = sampleOrder();
  const garments = sampleGarments();
  const handler: MockQueryHandler = (sql) => {
    if (sql.includes("FROM orders") && sql.includes("WHERE")) {
      return {
        rows: [
          {
            id: order.order_id,
            org_id: order.org_id,
            store_id: order.store_id,
            ticket_no: order.ticket_no,
            status: order.status,
            customer_phone: order.customer_phone,
            customer_name: order.customer_name,
            note: order.note,
            subtotal_cents: order.subtotal_cents,
            payable_cents: order.payable_cents,
            paid_cents: order.paid_cents,
            balance_cents: order.balance_cents,
            created_at: new Date(order.created_at * 1000),
            updated_at: new Date(order.updated_at * 1000),
            created_by_staff_id: order.created_by_staff_id,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM order_lines")) {
      return {
        rows: [
          {
            id: "line-uuid",
            org_id: order.org_id,
            store_id: order.store_id,
            order_id: order.order_id,
            line_index: 0,
            service_code: "wash",
            category_code: "shirt",
            unit_price_cents: 1500,
            qty: 2,
            line_total_cents: 3000,
            color: null,
            brand: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM garments")) {
      return {
        rows: garments.map((g) => ({
          id: g.garment_id,
          org_id: g.org_id,
          store_id: g.store_id,
          order_id: g.order_id,
          order_line_id: "line-uuid",
          line_index: g.line_index,
          seq: g.seq,
          barcode: g.barcode,
          service_code: g.service_code,
          category_code: g.category_code,
          unit_price_cents: g.unit_price_cents,
          color: g.color,
          brand: g.brand,
          status: g.status,
        })),
        rowCount: garments.length,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  const { pool, queries } = createCapturingPool(handler);
  const store = createPgOrderStore(pool);
  const applied = await store.applyPickup(
    DEMO_ORG_ID,
    DEMO_STORE_ID,
    order.order_id,
    [garments[0]!.garment_id],
    0,
    1_700_000_100,
    Object.freeze({ staffId: DEMO_STAFF_A_ID }),
  );
  assert.ok(applied);
  assert.equal(
    queries.some((q) => q.sql.includes("INTO payments")),
    false,
  );
});

test("listOrderSummaries uses one aggregate query and preserves every order.list filter", async () => {
  const handler: MockQueryHandler = (sql) => {
    if (sql.includes("COUNT(g.id)")) {
      return {
        rows: [
          {
            order_id: sampleOrder().order_id,
            ticket_no: sampleOrder().ticket_no,
            status: "open",
            customer_phone: sampleOrder().customer_phone,
            customer_name: "甲",
            payable_cents: 3000,
            paid_cents: 500,
            balance_cents: 2500,
            created_at: new Date("2024-07-22T12:34:56.000Z"),
            garment_count: 2,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const { pool, queries } = createCapturingPool(handler);
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
  assert.equal(summaries[0]?.created_at, Math.floor(Date.parse("2024-07-22T12:34:56.000Z") / 1000));
  const summaryQueries = queries.filter((query) => query.sql.includes("COUNT(g.id)"));
  assert.equal(summaryQueries.length, 1);
  assert.match(summaryQueries[0]!.sql, /LEFT JOIN garments/u);
  assert.match(summaryQueries[0]!.sql, /o\.balance_cents >= \$7/u);
  assert.match(summaryQueries[0]!.sql, /ORDER BY o\.created_at DESC, o\.ticket_no DESC/u);
  assert.deepEqual(summaryQueries[0]!.params, [
    DEMO_ORG_ID,
    DEMO_STORE_ID,
    "open",
    "13800000111",
    new Date("2024-07-22T00:00:00.000Z"),
    new Date("2024-07-23T00:00:00.000Z"),
    1,
    7,
  ]);
});

test("listOrderSummaries short-circuits a threshold above PostgreSQL integer before aggregate SQL", async () => {
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

// Optional live PG smoke — tables may not exist until migration lands.
const pgOptIn =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true";
const urls = pgOptIn ? resolvePgUrls(process.env) : null;
const maybePg = urls === null ? test.skip : test;

maybePg("PG order store smoke (requires order tables + LAUNDRY_USE_LOCAL_PG)", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });
  try {
    const store = createPgOrderStore(pool);
    // Probe: nextTicketSeq needs ticket_counters; if missing, test fails loudly under opt-in.
    const seq = await store.nextTicketSeq(DEMO_ORG_ID, DEMO_STORE_ID, "20990101");
    assert.ok(seq >= 1);
  } finally {
    await pool.end();
  }
});
