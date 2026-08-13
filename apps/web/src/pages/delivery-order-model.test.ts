import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryOrder } from "@laundry/contracts";

import {
  buildDeliveryOrderListInput,
  buildDeliveryOrderTransition,
  formatDeliveryOrderFee,
  nextDeliveryOrderStatuses,
  parseDeliveryOrder,
  parseDeliveryOrderMutation,
  parseDeliveryOrders,
  shortDeliveryOrderId,
} from "./delivery-order-model.js";

const ORDER: DeliveryOrder = Object.freeze({
  delivery_order_id: "11111111-1111-4111-8111-111111111111",
  laundry_order_id: "22222222-2222-4222-8222-222222222222",
  customer_id: "33333333-3333-4333-8333-333333333333",
  collection_method: "pickup",
  return_method: "delivery",
  pickup_appointment_id: "44444444-4444-4444-8444-444444444444",
  return_appointment_id: "55555555-5555-4555-8555-555555555555",
  pickup_fee_cents: 800,
  return_fee_cents: 900,
  total_fee_cents: 1700,
  status: "pickup_scheduled",
  version: 1,
  created_at: 1_800_000_000,
  updated_at: 1_800_000_000,
  completed_at: null,
  cancelled_at: null,
  cancellation_reason: null,
});

test("delivery order parsers accept only the strict contract envelopes", () => {
  assert.deepEqual(parseDeliveryOrders({ delivery_orders: [ORDER] }), [ORDER]);
  assert.deepEqual(parseDeliveryOrder({ result: { delivery_order: ORDER } }), ORDER);
  assert.deepEqual(parseDeliveryOrderMutation({ delivery_order: ORDER }), ORDER);
  assert.equal(
    parseDeliveryOrders({ delivery_orders: [{ ...ORDER, driver_phone: "private" }] }),
    null,
  );
  assert.equal(parseDeliveryOrder({ delivery_order: { ...ORDER, org_id: "injected" } }), null);
});

test("transition builder carries CAS and a controlled reason only for cancellation", () => {
  assert.deepEqual(buildDeliveryOrderTransition(ORDER, "pickup_in_progress"), {
    delivery_order_id: ORDER.delivery_order_id,
    customer_id: ORDER.customer_id,
    expected_version: 1,
    target_status: "pickup_in_progress",
  });
  assert.deepEqual(buildDeliveryOrderTransition(ORDER, "cancelled", "store_request"), {
    delivery_order_id: ORDER.delivery_order_id,
    customer_id: ORDER.customer_id,
    expected_version: 1,
    target_status: "cancelled",
    cancellation_reason: "store_request",
  });
  assert.equal(buildDeliveryOrderTransition(ORDER, "completed"), null);
});

test("route-specific next states never invent a task or evidence transition", () => {
  assert.deepEqual(nextDeliveryOrderStatuses(ORDER), ["pickup_in_progress", "cancelled"]);
  assert.deepEqual(
    nextDeliveryOrderStatuses({ ...ORDER, status: "at_store", return_method: "self_pickup" }),
    ["self_pickup_ready", "cancelled"],
  );
  assert.deepEqual(nextDeliveryOrderStatuses({ ...ORDER, status: "completed" }), []);
});

test("bounded worklist filter and integer-fen formatter are stable", () => {
  assert.deepEqual(buildDeliveryOrderListInput(null), { limit: 100 });
  assert.deepEqual(buildDeliveryOrderListInput("return_scheduled"), {
    status: "return_scheduled",
    limit: 100,
  });
  assert.equal(formatDeliveryOrderFee(805), "¥8.05");
  assert.equal(shortDeliveryOrderId(ORDER.delivery_order_id), "11111111");
});
