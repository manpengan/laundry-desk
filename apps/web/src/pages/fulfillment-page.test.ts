import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFulfillmentRows,
  transitionCommandForCount,
  unwrapFulfillmentResult,
} from "./fulfillment-model.js";

const ROW = Object.freeze({
  garment_id: "11111111-1111-4111-8111-111111111111",
  order_id: "22222222-2222-4222-8222-222222222222",
  ticket_no: "20260730-0001",
  barcode: "ABC123",
  customer_name: "张三",
  customer_phone_masked: "138****0111",
  service_code: "wash",
  category_code: "shirt",
  color: "白色",
  brand: null,
  status: "washing",
  updated_at: 1_722_297_600,
  incident_count: 0,
});

test("fulfillment parser accepts masked bounded workbench rows", () => {
  const parsed = parseFulfillmentRows(unwrapFulfillmentResult({ result: { garments: [ROW] } }));
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0]?.status, "washing");
  assert.equal(parsed?.[0]?.customer_phone_masked, "138****0111");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed?.[0]), true);
});

test("fulfillment parser rejects unknown status and unsafe counters", () => {
  assert.equal(parseFulfillmentRows({ garments: [{ ...ROW, status: "unknown" }] }), null);
  assert.equal(
    parseFulfillmentRows({ garments: [{ ...ROW, incident_count: Number.MAX_SAFE_INTEGER + 1 }] }),
    null,
  );
});

test("single and batch transitions use separate risk contracts", () => {
  assert.equal(transitionCommandForCount(1), "garment.transition");
  assert.equal(transitionCommandForCount(2), "garment.bulk_transition");
  assert.equal(transitionCommandForCount(50), "garment.bulk_transition");
});
