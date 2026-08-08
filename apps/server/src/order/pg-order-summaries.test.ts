/**
 * Real-PostgreSQL acceptance for the two counter read models.
 *
 * The sibling pg-order-store.test.ts asserted both of these against a capturing
 * pool, as regexes over the generated SQL — `/LEFT JOIN garments/`,
 * `/o\.balance_cents >= \$6/`, `/ORDER BY o\.created_at DESC, o\.ticket_no DESC/`,
 * `/matched_g\.barcode = \$3/`. A regex shows the string was assembled. It cannot
 * show that the join counts the right garments, that the filter excludes the
 * right orders, or that a barcode lookup finds anything at all — the same blind
 * spot that let migration 0019 ship a business_date CHECK rejecting every date
 * behind a fully green suite.
 *
 * These are the counter's two hottest reads: the order list and the pickup
 * lookup a clerk uses with a customer standing at the desk. They run against a
 * real database here.
 *
 * The integration database is shared, so the fixture uses its own far-future
 * business dates and a per-run marker, and reclaims them as laundry_owner.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgCustomerStore } from "../customer/pg-customer-store.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgOrderStore } from "./pg-order-store.js";
import type { GarmentRecord, OrderRecord } from "./types.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

/** Far future so the workday acceptance's own dates can never overlap. */
const DATE_A = "2097-05-01";
const DATE_B = "2097-05-02";
const ALL_DATES = Object.freeze([DATE_A, DATE_B]);

const BASE_AT = 4_020_000_000;

type OrderSeed = Readonly<{
  ticketSuffix: string;
  businessDate: string;
  status: OrderRecord["status"];
  paidCents: number;
  balanceCents: number;
  createdAt: number;
  customerId: string;
  customerPhone: string;
  customerName: string | null;
  barcodes: readonly string[];
}>;

function buildOrder(marker: string, seed: OrderSeed): OrderRecord {
  return Object.freeze({
    order_id: randomUUID(),
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    ticket_no: `${marker}-${seed.ticketSuffix}`,
    pickup_code: `PK${marker}${seed.ticketSuffix}`,
    status: seed.status,
    customer_id: seed.customerId,
    customer_phone: seed.customerPhone,
    customer_name: seed.customerName,
    note: null,
    lines: Object.freeze([
      Object.freeze({
        line_index: 0,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 1_500,
        qty: seed.barcodes.length === 0 ? 1 : seed.barcodes.length,
        line_total_cents: 3_000,
        color: null,
        brand: null,
      }),
    ]),
    subtotal_cents: 3_000,
    original_cents: 3_000,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: 3_000,
    paid_cents: seed.paidCents,
    balance_cents: seed.balanceCents,
    created_at: seed.createdAt,
    updated_at: seed.createdAt,
    business_date: seed.businessDate,
    created_by_staff_id: DEMO_STAFF_A_ID,
  });
}

function buildGarments(order: OrderRecord, barcodes: readonly string[]): readonly GarmentRecord[] {
  return Object.freeze(
    barcodes.map((barcode, index) =>
      Object.freeze({
        garment_id: randomUUID(),
        order_id: order.order_id,
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        line_index: 0,
        seq: index + 1,
        barcode,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 1_500,
        color: null,
        brand: null,
        status: "received" as const,
      }),
    ),
  );
}

/**
 * orders and its children are not deletable by laundry_app, so the fixture
 * window is reclaimed as laundry_owner on the admin pool — the same escape
 * hatch clearWorkdayFixture uses in pg-workday.test.ts.
 */
async function purgeWindow(adminPool: ReturnType<typeof createPgPool>): Promise<void> {
  const client = await adminPool.connect();
  const scope = [DEMO_ORG_ID, DEMO_STORE_ID, [...ALL_DATES]];
  const orderIds = `SELECT id FROM orders
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = ANY($3::text[])`;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    for (const table of ["garment_status_log", "payments", "garments", "order_lines"]) {
      await client.query(
        `DELETE FROM ${table}
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id IN (${orderIds})`,
        scope,
      );
    }
    await client.query(
      `DELETE FROM orders
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = ANY($3::text[])`,
      scope,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

maybe("PG order summaries apply every list filter and count joined garments", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });

  try {
    await seedPgTestIdentityFixture(adminPool);
    await purgeWindow(adminPool);

    const marker = String(Math.floor(Math.random() * 900_000) + 100_000);
    const customers = createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID });
    const store = createPgOrderStore(appPool);
    assert.ok(store.listOrderSummaries);

    const primary = await customers.upsert({ phone: `17${marker}01`, now: BASE_AT });
    const other = await customers.upsert({ phone: `17${marker}02`, now: BASE_AT });

    // Two garments, open, unpaid balance, on DATE_A.
    const twoGarments = buildOrder(marker, {
      ticketSuffix: "0001",
      businessDate: DATE_A,
      status: "open",
      paidCents: 500,
      balanceCents: 2_500,
      createdAt: BASE_AT,
      customerId: primary.customer.customer_id,
      customerPhone: primary.customer.phone,
      customerName: null,
      barcodes: [`BC${marker}A1`, `BC${marker}A2`],
    });
    await store.insertOrder(
      twoGarments,
      buildGarments(twoGarments, [`BC${marker}A1`, `BC${marker}A2`]),
    );

    // Zero garments, settled, same day — proves the join is a LEFT JOIN and the
    // balance filter really excludes rather than the SQL merely mentioning it.
    const noGarments = buildOrder(marker, {
      ticketSuffix: "0002",
      businessDate: DATE_A,
      status: "closed",
      paidCents: 3_000,
      balanceCents: 0,
      createdAt: BASE_AT + 60,
      customerId: other.customer.customer_id,
      customerPhone: other.customer.phone,
      customerName: null,
      barcodes: [],
    });
    await store.insertOrder(noGarments, []);

    // Different business date — must never leak into a DATE_A query.
    const otherDay = buildOrder(marker, {
      ticketSuffix: "0003",
      businessDate: DATE_B,
      status: "open",
      paidCents: 0,
      balanceCents: 3_000,
      createdAt: BASE_AT + 120,
      customerId: primary.customer.customer_id,
      customerPhone: primary.customer.phone,
      customerName: null,
      barcodes: [`BC${marker}B1`],
    });
    await store.insertOrder(otherDay, buildGarments(otherDay, [`BC${marker}B1`]));

    const tickets = (rows: readonly { ticket_no: string | null }[]) =>
      rows.map((row) => row.ticket_no);

    // Business date confines the page.
    const dayA = await store.listOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
      businessDate: DATE_A,
      limit: 50,
    });
    assert.deepEqual(
      tickets(dayA),
      [`${marker}-0002`, `${marker}-0001`],
      "newest first, and only the requested business date",
    );

    // The LEFT JOIN counts each order's own garments and still returns an order
    // that has none.
    assert.equal(dayA.find((row) => row.ticket_no === `${marker}-0001`)?.garment_count, 2);
    assert.equal(dayA.find((row) => row.ticket_no === `${marker}-0002`)?.garment_count, 0);

    // Status filter.
    const openOnly = await store.listOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
      businessDate: DATE_A,
      status: "open",
      limit: 50,
    });
    assert.deepEqual(tickets(openOnly), [`${marker}-0001`]);

    // Phone filter reaches across days for one customer.
    const byPhone = await store.listOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
      customerPhone: primary.customer.phone,
      limit: 50,
    });
    assert.deepEqual(tickets(byPhone), [`${marker}-0003`, `${marker}-0001`]);

    // Minimum balance excludes the settled order.
    const owing = await store.listOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
      businessDate: DATE_A,
      minBalanceCents: 1,
      limit: 50,
    });
    assert.deepEqual(tickets(owing), [`${marker}-0001`]);

    // A threshold above every balance returns nothing rather than everything.
    const unreachable = await store.listOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
      businessDate: DATE_A,
      minBalanceCents: 999_999,
      limit: 50,
    });
    assert.deepEqual(tickets(unreachable), []);

    // The limit keeps the newest rows.
    const capped = await store.listOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
      businessDate: DATE_A,
      limit: 1,
    });
    assert.deepEqual(tickets(capped), [`${marker}-0002`]);
  } finally {
    await purgeWindow(adminPool).catch(() => undefined);
    await appPool.end();
    await adminPool.end();
  }
});

maybe("PG payment ledger reads back in durable sequence, not by wall clock", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });

  try {
    await seedPgTestIdentityFixture(adminPool);
    await purgeWindow(adminPool);

    const marker = String(Math.floor(Math.random() * 900_000) + 100_000);
    const customers = createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID });
    const store = createPgOrderStore(appPool);
    assert.ok(store.appendPayment);
    assert.ok(store.listPayments);

    const customer = await customers.upsert({ phone: `17${marker}20`, now: BASE_AT });
    const order = buildOrder(marker, {
      ticketSuffix: "0020",
      businessDate: DATE_A,
      status: "open",
      paidCents: 0,
      balanceCents: 3_000,
      createdAt: BASE_AT,
      customerId: customer.customer.customer_id,
      customerPhone: customer.customer.phone,
      customerName: null,
      barcodes: [],
    });
    await store.insertOrder(order, []);

    // Three repayments that all claim the SAME wall-clock instant. Ordering by
    // `at` (or by a random uuid id) cannot put these in a defined order; only
    // the durable ledger_seq can. The old assertion was a regex over the SQL,
    // which would keep passing if the ORDER BY silently regressed to `at`.
    const amounts = [700, 1_100, 1_200] as const;
    for (const amount of amounts) {
      const appended = await store.appendPayment({
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        order_id: order.order_id,
        amount_cents: amount,
        method: "cash",
        note: null,
        kind: "repay",
        staff_id: DEMO_STAFF_A_ID,
        at: BASE_AT + 500,
        business_date: DATE_A,
      });
      assert.ok(appended, `appending ${amount} must succeed`);
    }

    const ledger = await store.listPayments(DEMO_ORG_ID, DEMO_STORE_ID, order.order_id);
    assert.deepEqual(
      ledger.map((row) => row.amount_cents),
      [...amounts],
      "the ledger must read back in append order even when every row shares one timestamp",
    );
  } finally {
    await purgeWindow(adminPool).catch(() => undefined);
    await appPool.end();
    await adminPool.end();
  }
});

maybe("PG order lookup resolves each identifier and reports how it matched", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });

  try {
    await seedPgTestIdentityFixture(adminPool);
    await purgeWindow(adminPool);

    const marker = String(Math.floor(Math.random() * 900_000) + 100_000);
    const customers = createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID });
    const store = createPgOrderStore(appPool);
    assert.ok(store.lookupOrderSummaries);

    const phone = `17${marker}09`;
    const customer = await customers.upsert({ phone, name: `Li${marker}`, now: BASE_AT });
    const barcode = `BC${marker}X1`;

    const order = buildOrder(marker, {
      ticketSuffix: "0009",
      businessDate: DATE_A,
      status: "open",
      paidCents: 0,
      balanceCents: 3_000,
      createdAt: BASE_AT,
      customerId: customer.customer.customer_id,
      customerPhone: phone,
      customerName: `Li${marker}`,
      barcodes: [barcode],
    });
    await store.insertOrder(order, buildGarments(order, [barcode]));

    const lookupOne = async (key: string) => {
      const rows = await store.lookupOrderSummaries!(DEMO_ORG_ID, DEMO_STORE_ID, {
        key,
        limit: 20,
      });
      return rows.filter((row) => row.ticket_no === order.ticket_no);
    };

    // Every identifier the counter can type resolves to the same order, and the
    // result says which one matched. None of this is observable through a mock.
    for (const [key, expected] of [
      [order.ticket_no, "ticket_no"],
      [order.pickup_code, "pickup_code"],
      [barcode, "garment_barcode"],
      [phone, "customer_phone"],
      [`Li${marker}`, "customer_name"],
    ] as const) {
      assert.ok(key, "fixture identifier must exist");
      const rows = await lookupOne(key);
      assert.equal(rows.length, 1, `lookup by ${expected} must find the order`);
      assert.equal(rows[0]?.matched_by, expected);
      assert.equal(rows[0]?.pickup_code, order.pickup_code);
      assert.equal(rows[0]?.garment_count, 1);
    }

    // The name match is case-insensitive (lower(...) LIKE lower(...)).
    const upper = await lookupOne(`LI${marker}`);
    assert.equal(upper.length, 1);
    assert.equal(upper[0]?.matched_by, "customer_name");

    // A status filter still applies to an identifier hit.
    const wrongStatus = await store.lookupOrderSummaries(DEMO_ORG_ID, DEMO_STORE_ID, {
      key: barcode,
      status: "closed",
      limit: 20,
    });
    assert.deepEqual(
      wrongStatus.filter((row) => row.ticket_no === order.ticket_no),
      [],
      "a status filter must still exclude an otherwise matching order",
    );

    // An unknown identifier returns nothing rather than the whole store.
    assert.deepEqual(await lookupOne(`BC${marker}ZZ`), []);
  } finally {
    await purgeWindow(adminPool).catch(() => undefined);
    await appPool.end();
    await adminPool.end();
  }
});
