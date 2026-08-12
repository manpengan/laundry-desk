import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryOrder, DeliveryOrderTransitionInput } from "@laundry/contracts";

import type { SessionView } from "../auth/types.js";
import {
  createDeliveryOrderRequestAuthority,
  createDeliveryOrderStepUpCloseGate,
  deliveryOrderDetailAuthorityKey,
  deliveryOrderSessionScope,
  deliveryOrderTransitionAuthorityKey,
  deliveryOrderTransitionStillMatches,
} from "./delivery-order-request-authority.js";

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function session(overrides: Partial<SessionView["session"]> = {}): SessionView {
  return Object.freeze({
    session: Object.freeze({
      session_id: "11111111-1111-4111-8111-111111111111",
      session_version: 1,
      org_id: "22222222-2222-4222-8222-222222222222",
      store_id: "33333333-3333-4333-8333-333333333333",
      staff_id: "44444444-4444-4444-8444-444444444444",
      device_id: "55555555-5555-4555-8555-555555555555",
      permission_version: 1,
      ...overrides,
    }),
    role: "admin",
    features: Object.freeze({ delivery_enabled: true }),
    display: Object.freeze({
      store_name: "门店",
      staff_name: "管理员",
      org_code: "org",
      store_code: "store",
    }),
  });
}

const ORDER: DeliveryOrder = Object.freeze({
  delivery_order_id: "66666666-6666-4666-8666-666666666666",
  laundry_order_id: "77777777-7777-4777-8777-777777777777",
  customer_id: "88888888-8888-4888-8888-888888888888",
  collection_method: "pickup",
  return_method: "delivery",
  pickup_appointment_id: null,
  return_appointment_id: null,
  pickup_fee_cents: 500,
  return_fee_cents: 600,
  total_fee_cents: 1100,
  status: "pickup_scheduled",
  version: 3,
  created_at: 1_800_000_000,
  updated_at: 1_800_000_000,
  completed_at: null,
  cancelled_at: null,
  cancellation_reason: null,
});

test("A detail response cannot overwrite a later B selection", async () => {
  const scope = deliveryOrderSessionScope(session());
  const authority = createDeliveryOrderRequestAuthority(scope);
  const first = deferred<string>();
  const second = deferred<string>();
  const accepted: string[] = [];
  const firstToken = authority.begin("detail", deliveryOrderDetailAuthorityKey(scope, "A"));
  const firstRead = first.promise.then((value) => {
    if (authority.isCurrent(firstToken)) accepted.push(value);
  });
  const secondToken = authority.begin("detail", deliveryOrderDetailAuthorityKey(scope, "B"));
  const secondRead = second.promise.then((value) => {
    if (authority.isCurrent(secondToken)) accepted.push(value);
  });

  second.resolve("B");
  await secondRead;
  first.resolve("A");
  await firstRead;
  assert.deepEqual(accepted, ["B"]);
});

test("a response from the previous session or store is rejected", async () => {
  const oldScope = deliveryOrderSessionScope(session());
  let current = createDeliveryOrderRequestAuthority(oldScope);
  const response = deferred<string>();
  const token = current.begin("list", oldScope);
  const accepted: string[] = [];
  const read = response.promise.then((value) => {
    if (current.isCurrent(token)) accepted.push(value);
  });

  current = createDeliveryOrderRequestAuthority(
    deliveryOrderSessionScope(
      session({
        session_id: "99999999-9999-4999-8999-999999999999",
        store_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ),
  );
  response.resolve("old-customer-context");
  await read;
  assert.deepEqual(accepted, []);
});

test("changing transition target or reason invalidates the first-hop response", async () => {
  const scope = deliveryOrderSessionScope(session());
  const authority = createDeliveryOrderRequestAuthority(scope);
  const firstBody: DeliveryOrderTransitionInput = Object.freeze({
    delivery_order_id: ORDER.delivery_order_id,
    customer_id: ORDER.customer_id,
    expected_version: ORDER.version,
    target_status: "cancelled",
    cancellation_reason: "customer_request",
  });
  const response = deferred<string>();
  const token = authority.begin(
    "transition",
    deliveryOrderTransitionAuthorityKey(scope, firstBody),
  );
  const accepted: string[] = [];
  const read = response.promise.then((value) => {
    if (authority.isCurrent(token)) accepted.push(value);
  });

  authority.invalidate("transition");
  response.resolve("stale-confirm-ref");
  await read;
  assert.deepEqual(accepted, []);
  assert.equal(deliveryOrderTransitionStillMatches(firstBody, ORDER, "store_request"), false);
  assert.equal(deliveryOrderTransitionStillMatches(firstBody, ORDER, "customer_request"), true);
});

test("approved step-up auto-close keeps the in-flight confirmation token current", async () => {
  const scope = deliveryOrderSessionScope(session());
  const authority = createDeliveryOrderRequestAuthority(scope);
  const closeGate = createDeliveryOrderStepUpCloseGate();
  const response = deferred<string>();
  const token = authority.begin("transition", "frozen-confirm-authority");
  let busy = true;
  const accepted: string[] = [];
  const confirm = response.promise.then((value) => {
    if (!authority.isCurrent(token)) return;
    accepted.push(value);
    busy = false;
  });

  // StepUpConfirmDialog calls onApproved first and onClose immediately after.
  closeGate.markApproved();
  if (closeGate.consumeClose()) authority.invalidate("transition");
  response.resolve("confirmed");
  await confirm;
  assert.deepEqual(accepted, ["confirmed"]);
  assert.equal(busy, false);

  closeGate.reset();
  assert.equal(closeGate.consumeClose(), true, "operator cancellation must invalidate");
});
