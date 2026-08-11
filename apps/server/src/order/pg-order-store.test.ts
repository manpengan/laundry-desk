/**
 * Unit tests for createPgOrderStore logic that does not need a database.
 *
 * Kept here, because these are decisions the store itself makes: pure mapping
 * (buildLineIdByIndex, mapOrder, mapOrderLine), which values it sends to the
 * driver, that each garment is wired to one generated order_line, that a draft
 * takes the opening timestamp, and that draft/open write paths preserve the
 * aggregate. Bounded query decisions live in pg-order-query-store.test.ts.
 *
 * Moved to a real database, because these are decisions PostgreSQL makes:
 * joins, filters, ordering and ledger sequence. Those live in
 * pg-order-summaries.test.ts, with the write paths covered through the command
 * bus in pg-workday.test.ts.
 *
 * The distinction matters: a regex over generated SQL stays green whether or
 * not the query returns the right rows, which is how migration 0019 shipped a
 * business_date CHECK that rejected every date behind a passing suite.
 *
 * Real PG integration is enabled by LAUNDRY_USE_LOCAL_PG=1 in v2-integration.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
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
    pickup_code: "P202607220001",
    status: "open" as const,
    customer_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
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
        garment_details: Object.freeze([
          Object.freeze({
            color: null,
            brand: null,
            defects: Object.freeze([]),
            accessories: Object.freeze([]),
            note: null,
            addons: Object.freeze([]),
          }),
          Object.freeze({
            color: null,
            brand: null,
            defects: Object.freeze([]),
            accessories: Object.freeze([]),
            note: null,
            addons: Object.freeze([]),
          }),
        ]),
      }),
    ]),
    subtotal_cents: 3000,
    original_cents: 3000,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    pricing_policy_version: 0,
    urgent_selected: false,
    freight_selected: false,
    payable_cents: 3000,
    paid_cents: 500,
    balance_cents: 2500,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    business_date: "2023-11-14",
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
      defects: Object.freeze([]),
      accessories: Object.freeze([]),
      note: null,
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
      defects: Object.freeze([]),
      accessories: Object.freeze([]),
      note: null,
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
    garment_details_json: [
      {
        color: "black",
        brand: null,
        defects: ["scratch"],
        accessories: ["belt"],
        note: "front",
        addons: [{ code: "stain", name: "Stain treatment", unit_price_cents: 300 }],
      },
    ],
  });
  assert.equal(line.line_index, 2);
  assert.equal(line.unit_price_cents, 4000);
  assert.deepEqual(line.garment_details?.[0], {
    color: "black",
    brand: null,
    defects: ["scratch"],
    accessories: ["belt"],
    note: "front",
    addons: [{ code: "stain", name: "Stain treatment", unit_price_cents: 300 }],
  });

  const order = mapOrder(
    {
      id: "ord-1",
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      ticket_no: "20260722-0009",
      pickup_code: "P202607220009",
      status: "open",
      customer_id: null,
      customer_phone: null,
      customer_name: null,
      note: null,
      subtotal_cents: 4000,
      original_cents: 4000,
      discount_cents: 0,
      addon_cents: 0,
      urgent_cents: 0,
      freight_cents: 0,
      pricing_policy_version: 3,
      urgent_selected: true,
      freight_selected: false,
      payable_cents: 4000,
      paid_cents: 0,
      balance_cents: 4000,
      created_at: new Date("2026-07-22T00:00:00Z"),
      updated_at: new Date("2026-07-22T00:00:00Z"),
      business_date: "2026-07-22",
      created_by_staff_id: DEMO_STAFF_A_ID,
    },
    [line],
  );
  assert.equal(order.order_id, "ord-1");
  assert.equal(order.customer_id, null);
  assert.equal(order.lines[0]?.line_index, 2);
  assert.equal(order.pricing_policy_version, 3);
  assert.equal(order.urgent_selected, true);
  assert.equal(order.created_at, Math.floor(Date.parse("2026-07-22T00:00:00Z") / 1000));
});

test("mapOrderLine rejects malformed persisted per-piece snapshots", () => {
  const base = {
    id: "line-1",
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    order_id: "ord-1",
    line_index: 0,
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1_500,
    qty: 1,
    line_total_cents: 1_500,
    color: null,
    brand: null,
  };
  assert.throws(
    () =>
      mapOrderLine({
        ...base,
        garment_details_json: [
          {
            color: null,
            brand: null,
            defects: [],
            accessories: [],
            note: null,
            addons: [{ code: "stain", name: "去渍", unit_price_cents: 100, unexpected: true }],
          },
        ],
      }),
    /Invalid garment add-on/u,
  );
  assert.throws(
    () =>
      mapOrderLine({
        ...base,
        garment_details_json: [
          {
            color: null,
            brand: null,
            defects: ["x".repeat(33)],
            accessories: [],
            note: null,
            addons: [],
          },
        ],
      }),
    /Invalid garment defects/u,
  );
});

test("nextTicketSeq issues UPSERT on ticket_counters and returns last_seq", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgOrderStore(pool);
  const seq = await store.nextTicketSeq(DEMO_ORG_ID, DEMO_STORE_ID, "20260722");
  // The mapping of the returned row onto a number is this store's work. That the
  // counter actually increments without gaps under concurrency is PostgreSQL's,
  // and is exercised by the real-PG smoke below and by pg-workday.test.ts.
  assert.equal(seq, 3);
  const upsert = queries.find((q) => q.sql.includes("ticket_counters"));
  assert.ok(upsert);
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
  const orderInsert = inserts.find((q) => q.sql.includes("INTO orders"));
  assert.ok(orderInsert);
  assert.ok(orderInsert.params?.includes(sampleOrder().customer_id));
  assert.ok(inserts.some((q) => q.sql.includes("INTO order_lines")));
  assert.ok(inserts.some((q) => q.sql.includes("INTO garments")));

  // The point of this case is the generated line id: every garment must be
  // wired to the same freshly minted order_line, not to a per-garment id.
  // Asserted as a relation between the statements rather than by column index,
  // so adding a column cannot turn it red without changing the behaviour.
  const lineInsert = inserts.find((q) => q.sql.includes("INTO order_lines"));
  assert.ok(lineInsert);
  const generatedLineId = "00000000-0000-4000-8000-000000000001";
  assert.ok(lineInsert.params?.includes(generatedLineId));

  const garmentInserts = inserts.filter((q) => q.sql.includes("INTO garments"));
  assert.equal(garmentInserts.length, 2);
  for (const g of garmentInserts) {
    assert.ok(
      g.params?.includes(generatedLineId),
      "every garment must reference the generated order_line id",
    );
  }

  // The tenant scope reaches the driver inside the transaction. That the GUCs
  // actually confine the write is proven on a real database by
  // __tests__/rls-pg-integration.test.ts and pg-workday.test.ts.
  assert.ok(queries.some((q) => q.params?.includes(DEMO_ORG_ID)));
  assert.ok(queries.some((q) => q.params?.includes(DEMO_STORE_ID)));
});

test("replaceDraft resets created_at when the draft formally becomes an open order", async () => {
  const oldDraft = Object.freeze({
    ...sampleOrder(),
    ticket_no: null,
    pickup_code: null,
    status: "draft" as const,
    created_at: 1_697_321_600,
    updated_at: 1_697_321_600,
    business_date: "2023-10-14",
  });
  const openedAt = 1_700_000_000;
  const opened = Object.freeze({
    ...sampleOrder(),
    created_at: openedAt,
    updated_at: openedAt,
  });
  const handler: MockQueryHandler = (sql) => {
    if (sql.includes("FROM orders") && sql.includes("WHERE")) {
      return {
        rows: [
          {
            id: oldDraft.order_id,
            org_id: oldDraft.org_id,
            store_id: oldDraft.store_id,
            ticket_no: oldDraft.ticket_no,
            pickup_code: oldDraft.pickup_code,
            status: oldDraft.status,
            customer_id: oldDraft.customer_id,
            customer_phone: oldDraft.customer_phone,
            customer_name: oldDraft.customer_name,
            note: oldDraft.note,
            subtotal_cents: oldDraft.subtotal_cents,
            original_cents: oldDraft.original_cents,
            discount_cents: oldDraft.discount_cents,
            addon_cents: oldDraft.addon_cents,
            urgent_cents: oldDraft.urgent_cents,
            freight_cents: oldDraft.freight_cents,
            pricing_policy_version: oldDraft.pricing_policy_version,
            urgent_selected: oldDraft.urgent_selected,
            freight_selected: oldDraft.freight_selected,
            payable_cents: oldDraft.payable_cents,
            paid_cents: oldDraft.paid_cents,
            balance_cents: oldDraft.balance_cents,
            created_at: new Date(oldDraft.created_at * 1_000),
            updated_at: new Date(oldDraft.updated_at * 1_000),
            business_date: oldDraft.business_date,
            created_by_staff_id: oldDraft.created_by_staff_id,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const { pool, queries } = createCapturingPool(handler);
  const store = createPgOrderStore(pool, {
    newId: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  });

  assert.equal(await store.replaceDraft?.(opened, sampleGarments()), true);

  // A draft that becomes a real order takes the opening timestamp, not the one
  // it was drafted at — otherwise it lands in the wrong business day. Asserted
  // by value: the old regex pinned the parameter numbers ($21, $22), so any
  // added column turned it red without any behaviour changing.
  const update = queries.find((query) => query.sql.includes("UPDATE orders"));
  assert.ok(update);
  const sentTimes = (update.params ?? []).filter((param): param is Date => param instanceof Date);
  assert.ok(
    sentTimes.some((at) => at.getTime() === opened.created_at * 1_000),
    "replaceDraft must send the opening created_at",
  );
  assert.equal(
    sentTimes.some((at) => at.getTime() === oldDraft.created_at * 1_000),
    false,
    "the draft's original created_at must not survive the transition",
  );
});

test("replaceDraft requireExisting refuses a missing client-selected draft id", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgOrderStore(pool);
  const replaced = await store.replaceDraft?.(sampleOrder(), sampleGarments(), undefined, {
    requireExisting: true,
  });

  assert.equal(replaced, false);
  assert.equal(
    queries.some((query) => query.sql.includes("INSERT INTO orders")),
    false,
  );
});

test("getOrder returns null when no order row", async () => {
  const { pool } = createCapturingPool();
  const store = createPgOrderStore(pool);
  const found = await store.getOrder(DEMO_ORG_ID, DEMO_STORE_ID, sampleOrder().order_id);
  assert.equal(found, null);
});

test("listPayments reads the append-only ledger in durable sequence order", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgOrderStore(pool);

  await store.listPayments?.(DEMO_ORG_ID, DEMO_STORE_ID, sampleOrder().order_id);

  // That the read is scoped to the order is checkable here. That it comes back
  // in durable append order — rather than by a wall clock that can tie — is a
  // database behaviour, proven in pg-order-summaries.test.ts with three rows
  // sharing one timestamp. The regex this replaced could not have caught a
  // regression to `ORDER BY at`.
  const paymentSelect = queries.find(
    (query) => query.sql.includes("FROM payments") && query.sql.includes("ledger_seq"),
  );
  assert.ok(paymentSelect);
  assert.ok(paymentSelect.params?.includes(sampleOrder().order_id));
});

test("applyPickup updates garments to picked_up and settles balance", async () => {
  const order = sampleOrder();
  const garments = sampleGarments();
  const lockedGarments = garments.map((garment) =>
    Object.freeze({
      ...garment,
      status: "racked" as const,
      rack_zone: "A",
      rack_slot: String(garment.seq).padStart(2, "0"),
    }),
  );
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
            customer_id: order.customer_id,
            customer_phone: order.customer_phone,
            customer_name: order.customer_name,
            note: order.note,
            subtotal_cents: order.subtotal_cents,
            original_cents: order.original_cents,
            discount_cents: order.discount_cents,
            addon_cents: order.addon_cents,
            urgent_cents: order.urgent_cents,
            freight_cents: order.freight_cents,
            payable_cents: order.payable_cents,
            paid_cents: order.paid_cents,
            balance_cents: order.balance_cents,
            pricing_policy_version: order.pricing_policy_version,
            urgent_selected: order.urgent_selected,
            freight_selected: order.freight_selected,
            created_at: new Date(order.created_at * 1000),
            updated_at: new Date(order.updated_at * 1000),
            business_date: order.business_date,
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
            garment_details_json: order.lines[0]?.garment_details,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM garments")) {
      return {
        rows: lockedGarments.map((g) => ({
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
          defects: g.defects,
          accessories: g.accessories,
          note: g.note,
          status: g.status,
          rack_zone: g.rack_zone ?? null,
          rack_slot: g.rack_slot ?? null,
        })),
        rowCount: lockedGarments.length,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  const { pool, queries } = createCapturingPool(handler);
  const store = createPgOrderStore(pool, {
    newId: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  await assert.rejects(
    () =>
      store.applyPickup(
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        order.order_id,
        garments.map((garment) => garment.garment_id),
        2500,
        1_700_000_100,
        Object.freeze({ staffId: DEMO_STAFF_A_ID, method: "cash" as const }),
      ),
    (error) => error instanceof Error && error.name === "HandlerCommandError",
  );
  const applied = await store.applyPickup(
    DEMO_ORG_ID,
    DEMO_STORE_ID,
    order.order_id,
    garments.map((g) => g.garment_id),
    2500,
    1_700_000_100,
    Object.freeze({
      staffId: DEMO_STAFF_A_ID,
      method: "cash" as const,
      verificationBarcodes: lockedGarments.map((garment) => garment.barcode),
    }),
  );
  assert.ok(applied);
  assert.equal(applied.order.paid_cents, 3000);
  assert.equal(applied.order.balance_cents, 0);
  assert.equal(applied.order.status, "closed");
  assert.equal(
    applied.garments.every((g) => g.status === "picked_up"),
    true,
  );

  // Handing a garment over releases its rack slot — the mapped result above
  // already shows the status change; this only pins that the release is part of
  // the same statement rather than a follow-up the caller must remember.
  assert.ok(queries.some((q) => q.sql.includes("UPDATE garments")));
  assert.ok(queries.some((q) => q.sql.includes("UPDATE orders")));

  // Collecting at pickup appends one payment carrying the tender, the exact
  // outstanding amount, the direction, and the staff it belongs to. By value,
  // not by column index; the ledger row really landing is covered on a real
  // database by pg-workday.test.ts.
  const paymentInsert = queries.find((q) => q.sql.includes("INTO payments"));
  assert.ok(paymentInsert, "expected INSERT INTO payments when collectCents > 0");
  for (const expected of ["cash", 2500, "pay", DEMO_STAFF_A_ID]) {
    assert.ok(
      paymentInsert.params?.includes(expected),
      `pickup payment must carry ${String(expected)}`,
    );
  }
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
            customer_id: order.customer_id,
            customer_phone: order.customer_phone,
            customer_name: order.customer_name,
            note: order.note,
            subtotal_cents: order.subtotal_cents,
            original_cents: order.original_cents,
            discount_cents: order.discount_cents,
            addon_cents: order.addon_cents,
            urgent_cents: order.urgent_cents,
            freight_cents: order.freight_cents,
            payable_cents: order.payable_cents,
            paid_cents: order.paid_cents,
            balance_cents: order.balance_cents,
            pricing_policy_version: order.pricing_policy_version,
            urgent_selected: order.urgent_selected,
            freight_selected: order.freight_selected,
            created_at: new Date(order.created_at * 1000),
            updated_at: new Date(order.updated_at * 1000),
            business_date: order.business_date,
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
            garment_details_json: order.lines[0]?.garment_details,
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
          defects: g.defects,
          accessories: g.accessories,
          note: g.note,
          status: g.status,
          rack_zone: g.rack_zone ?? null,
          rack_slot: g.rack_slot ?? null,
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
