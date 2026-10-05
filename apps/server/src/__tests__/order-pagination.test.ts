import assert from "node:assert/strict";
import test from "node:test";
import { OrderListInputSchema } from "@laundry/contracts";
import { executeQuery } from "../bus/execute-query.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STORE_ID, DEMO_STAFF_A_ID } from "../local/demo-ids.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import type { GarmentRecord, OrderRecord, OrderListSummary } from "../order/types.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";

const CUSTOMER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id = (index: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`;
function order(index: number, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    order_id: id(index),
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    ticket_no: `SYNTHETIC-${index}`,
    pickup_code: `PK${index}`,
    status: "open",
    customer_id: CUSTOMER,
    customer_phone: "13800000111",
    customer_name: "合成测试客户%",
    note: null,
    lines: [],
    subtotal_cents: 3000,
    original_cents: 3000,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: 3000,
    paid_cents: 1000,
    balance_cents: 2000,
    created_at: 1000 + index,
    updated_at: 1000 + index,
    business_date: "2026-10-01",
    created_by_staff_id: DEMO_STAFF_A_ID,
    ...overrides,
  };
}
function garment(row: OrderRecord): GarmentRecord {
  return {
    garment_id: id(999),
    order_id: row.order_id,
    org_id: row.org_id,
    store_id: row.store_id,
    line_index: 0,
    seq: 1,
    barcode: "SYNTHETICREADY",
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 3000,
    color: null,
    brand: null,
    status: "racked",
  };
}
async function fixture() {
  const store = createMemoryOrderStore();
  for (let i = 1; i <= 51; i += 1) await store.insertOrder(order(i), []);
  const ready = order(52, {
    status: "closed",
    paid_cents: 3000,
    balance_cents: 0,
    business_date: "2020-01-01",
  });
  await store.insertOrder(ready, [garment(ready)]);
  await store.insertOrder(order(53, { store_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }), []);
  const { queryRegistry } = createRegisteredM1Bus({
    platform: {
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    },
    order: { store, catalog: createMemoryCatalogStore() },
  });
  const read = async (body: Readonly<Record<string, unknown>>, permissions = ["staff_read"]) =>
    executeQuery(
      new FakeSqlClient(),
      { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID, staffId: DEMO_STAFF_A_ID },
      "order.list",
      body,
      {
        registry: queryRegistry,
        actor: { staffId: DEMO_STAFF_A_ID, deviceId: id(998), via: "ui", permissions },
      },
    );
  return { read };
}
type Page = { orders: readonly OrderListSummary[]; total: number; offset: number; limit: number };
test("51 debts and 52 customer orders remain reachable without cross-store rows", async () => {
  const { read } = await fixture();
  const first = await read({ min_balance_cents: 1, offset: 0, limit: 50 });
  const last = await read({ min_balance_cents: 1, offset: 50, limit: 50 });
  assert.ok(first.ok);
  assert.ok(last.ok);
  const a = first.data.result as Page,
    b = last.data.result as Page;
  assert.equal(a.total, 51);
  assert.equal(a.orders.length, 50);
  assert.equal(b.orders.length, 1);
  assert.equal(b.orders[0]?.order_id, id(1));
  assert.equal(new Set([...a.orders, ...b.orders].map((row) => row.order_id)).size, 51);
  const history = await read({ customer_id: CUSTOMER, offset: 20, limit: 20 });
  assert.ok(history.ok);
  assert.equal((history.data.result as Page).total, 52);
  assert.equal((history.data.result as Page).orders.length, 20);
  const final = await read({ customer_id: CUSTOMER, offset: 40, limit: 20 });
  assert.ok(final.ok);
  assert.equal((final.data.result as Page).orders.length, 12);
  const beyond = await read({ offset: 100, limit: 50 });
  assert.ok(beyond.ok);
  assert.equal((beyond.data.result as Page).total, 52);
  assert.deepEqual((beyond.data.result as Page).orders, []);
});
test("exact ticket, literal customer text, date range, status and ready garments compose", async () => {
  const { read } = await fixture();
  const response = await read({
    ticket_no: "SYNTHETIC-52",
    customer_query: "%",
    status: "closed",
    date_from: "2019-01-01",
    date_to: "2020-12-31",
    ready_for_pickup: true,
    offset: 0,
    limit: 50,
  });
  assert.ok(response.ok);
  const page = response.data.result as Page;
  assert.equal(page.total, 1);
  assert.equal(page.orders[0]?.balance_cents, 0);
  assert.equal(page.orders[0]?.garment_count, 1);
  const wrong = await read({
    ticket_no: "SYNTHETIC-5",
    ready_for_pickup: true,
    offset: 0,
    limit: 50,
  });
  assert.ok(wrong.ok);
  assert.equal((wrong.data.result as Page).total, 0);
  const invalid = await read({ date_from: "2026-10-01", date_to: "2020-01-01", offset: 0 });
  assert.equal(invalid.ok, false);
});
test("order paging rejects excessive work and tenant input remains server-owned", () => {
  for (const body of [
    { offset: -1 },
    { offset: 1_000_001 },
    { limit: 51 },
    { customer_query: " " },
    { org_id: DEMO_ORG_ID },
    { store_id: DEMO_STORE_ID },
    { ticket_no: "x".repeat(65) },
  ]) {
    assert.equal(OrderListInputSchema.safeParse(body).success, false);
  }
});
