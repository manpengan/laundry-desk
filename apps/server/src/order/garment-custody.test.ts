import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryOrderStore } from "./memory-store.js";
import type { GarmentRecord, OrderRecord } from "./types.js";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const STORE_ID = "10000000-0000-4000-8000-000000000002";
const STAFF_ID = "10000000-0000-4000-8000-000000000003";
const ORDER_ID = "10000000-0000-4000-8000-000000000004";
const GARMENT_ID = "10000000-0000-4000-8000-000000000005";
const BATCH_ID = "10000000-0000-4000-8000-000000000006";

function order(): OrderRecord {
  return Object.freeze({
    order_id: ORDER_ID,
    org_id: ORG_ID,
    store_id: STORE_ID,
    ticket_no: "20260812-0001",
    pickup_code: "P202608120001",
    status: "open",
    customer_id: null,
    customer_phone: null,
    customer_name: null,
    note: null,
    lines: Object.freeze([]),
    subtotal_cents: 1_000,
    original_cents: 1_000,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: 1_000,
    paid_cents: 0,
    balance_cents: 1_000,
    created_at: 1_723_392_000,
    updated_at: 1_723_392_000,
    business_date: "2026-08-12",
    created_by_staff_id: STAFF_ID,
  });
}

function reservedGarment(): GarmentRecord {
  return Object.freeze({
    garment_id: GARMENT_ID,
    order_id: ORDER_ID,
    org_id: ORG_ID,
    store_id: STORE_ID,
    line_index: 0,
    seq: 1,
    barcode: "G202608120001",
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1_000,
    color: null,
    brand: null,
    status: "ready",
    custody_state: "to_factory",
    active_production_batch_id: BATCH_ID,
  });
}

test("pickup cannot remove a garment reserved by an active factory batch", async () => {
  const store = createMemoryOrderStore();
  await store.insertOrder(order(), Object.freeze([reservedGarment()]));

  const result = await store.applyPickup(
    ORG_ID,
    STORE_ID,
    ORDER_ID,
    Object.freeze([GARMENT_ID]),
    1_000,
    1_723_392_100,
    Object.freeze({ staffId: STAFF_ID }),
  );

  assert.equal(result, null);
});

test("cancellation cannot release an order whose garment is outside store custody", async () => {
  const store = createMemoryOrderStore();
  await store.insertOrder(order(), Object.freeze([reservedGarment()]));

  const result = await store.cancelOpenOrder?.(
    ORG_ID,
    STORE_ID,
    ORDER_ID,
    "operational_error",
    STAFF_ID,
    1_723_392_100,
    "2026-08-12",
  );

  assert.equal(result, null);
});
