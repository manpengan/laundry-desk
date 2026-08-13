import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryOrder } from "@laundry/contracts";

import { createMemoryDeliveryTaskStore } from "../delivery-tasks/memory-store.js";
import type { DeliveryTaskStore } from "../delivery-tasks/types.js";
import type { DeliveryOrderStore } from "../delivery-orders/types.js";
import { createMemoryDeliveryEvidenceStore } from "./memory-store.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";
const EVIDENCE = "77777777-7777-4777-8777-777777777777";
const PHOTO = "88888888-8888-4888-8888-888888888888";
const NOW = 1_800_000_000;

function pickupOrder(status: DeliveryOrder["status"] = "pickup_in_progress", version = 4) {
  return Object.freeze({
    delivery_order_id: ORDER,
    laundry_order_id: "99999999-9999-4999-8999-999999999999",
    customer_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    collection_method: "pickup" as const,
    return_method: "self_pickup" as const,
    pickup_appointment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    return_appointment_id: null,
    pickup_fee_cents: 800,
    return_fee_cents: 0,
    total_fee_cents: 800,
    status,
    version,
    created_at: NOW - 100,
    updated_at: NOW - 10,
    completed_at: null,
    cancelled_at: null,
    cancellation_reason: null,
  }) satisfies DeliveryOrder;
}

async function harness() {
  let order: DeliveryOrder = pickupOrder("pickup_scheduled", 4);
  const orders: DeliveryOrderStore = Object.freeze({
    async create() {
      return Object.freeze({ ok: false as const, reason: "duplicate" as const });
    },
    async get(orgId, storeId, orderId) {
      return orgId === ORG && storeId === STORE && orderId === ORDER ? order : null;
    },
    async list() {
      return Object.freeze([order]);
    },
    async transition(request) {
      if (
        request.org_id !== ORG ||
        request.store_id !== STORE ||
        request.delivery_order_id !== ORDER ||
        request.expected_version !== order.version ||
        request.target_status !== "picked_up"
      ) {
        return Object.freeze({ ok: false as const, reason: "state_conflict" as const });
      }
      const before = order;
      order = pickupOrder("picked_up", order.version + 1);
      await tasks.settleOrderTransition({
        orgId: ORG,
        storeId: STORE,
        deliveryOrder: order,
        previousStatus: before.status,
        staffId: request.staff_id,
        at: request.at,
      });
      return Object.freeze({ ok: true as const, delivery_order: order, before });
    },
  });
  const tasks: DeliveryTaskStore = createMemoryDeliveryTaskStore({
    orders: Object.freeze({ get: orders.get }),
    isActiveStaff: async (staffId) => [STAFF, OTHER].includes(staffId),
  });
  const assigned = await tasks.mutate({
    operation: "assign",
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    delivery_task_id: TASK,
    delivery_order_id: ORDER,
    leg: "pickup",
    expected_delivery_order_version: 4,
    assignee_staff_id: STAFF,
    at: NOW - 5,
  });
  assert.equal(assigned.ok, true);
  const accepted = await tasks.mutate({
    operation: "respond",
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    delivery_order_id: ORDER,
    leg: "pickup",
    delivery_task_id: TASK,
    expected_version: 1,
    expected_delivery_order_version: 4,
    decision: "accept",
    resolution_reason: null,
    at: NOW - 4,
  });
  assert.equal(accepted.ok, true);
  order = pickupOrder("pickup_in_progress", 5);
  return Object.freeze({ evidence: createMemoryDeliveryEvidenceStore(orders, tasks), tasks });
}

const upload = Object.freeze({
  attachment_id: PHOTO,
  org_id: ORG,
  store_id: STORE,
  staff_id: STAFF,
  delivery_order_id: ORDER,
  delivery_task_id: TASK,
  leg: "pickup" as const,
  expected_delivery_task_version: 2,
  kind: "photo" as const,
  storage_key: "delivery-private.jpg",
  content_type: "image/jpeg" as const,
  content_sha256: "a".repeat(64),
  byte_size: 128,
  captured_at: NOW - 2,
  at: NOW - 2,
});

const record = Object.freeze({
  delivery_evidence_id: EVIDENCE,
  delivery_order_id: ORDER,
  delivery_task_id: TASK,
  leg: "pickup" as const,
  expected_delivery_order_version: 5,
  expected_delivery_task_version: 2,
  event_kind: "pickup" as const,
  outcome: "complete_leg" as const,
  captured_at: NOW - 1,
  gps: Object.freeze({
    latitude_e7: 251_234_567,
    longitude_e7: 1_215_678_901,
    accuracy_mm: 4_000,
    captured_at: NOW - 1,
  }),
  attachment_ids: [PHOTO],
});

test("memory evidence binds upload replay and completion to the accepted exact assignee", async () => {
  const { evidence, tasks } = await harness();
  const registered = await evidence.registerAttachment(upload);
  assert.equal(registered.ok, true);
  if (!registered.ok) return;
  assert.equal(registered.replay, false);
  assert.equal((await evidence.registerAttachment(upload)).ok, true);
  assert.deepEqual(
    await evidence.registerAttachment({ ...upload, content_sha256: "b".repeat(64) }),
    { ok: false, reason: "conflict" },
  );

  assert.equal(
    await evidence.prepare({ ...record, org_id: ORG, store_id: STORE, staff_id: OTHER, at: NOW }),
    null,
  );
  const authority = await evidence.prepare({
    ...record,
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    at: NOW,
  });
  assert.notEqual(authority, null);
  if (authority === null) return;
  assert.deepEqual(
    {
      has_gps: authority.has_gps,
      photo_count: authority.photo_count,
      signature_count: authority.signature_count,
    },
    { has_gps: true, photo_count: 1, signature_count: 0 },
  );

  const completed = await evidence.record({
    ...record,
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    at: NOW,
    authority,
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.delivery_order.status, "picked_up");
  assert.equal(completed.delivery_task.status, "completed");
  assert.equal((await tasks.get(ORG, STORE, TASK))?.status, "completed");
  assert.equal(Object.isFrozen(completed.evidence), true);
  assert.equal((await evidence.list(ORG, STORE, STAFF, TASK, 50)).length, 1);
  assert.deepEqual(await evidence.list(ORG, STORE, OTHER, TASK, 50), []);
  assert.notEqual(await evidence.authorizedAttachment(ORG, STORE, STAFF, PHOTO), null);
  assert.equal(await evidence.authorizedAttachment(ORG, STORE, OTHER, PHOTO), null);
  assert.deepEqual(
    await evidence.record({
      ...record,
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      at: NOW,
      authority,
    }),
    { ok: false, reason: "duplicate" },
  );
});

test("memory completion rejects missing required media or GPS", async () => {
  const { evidence } = await harness();
  assert.equal(
    await evidence.prepare({
      ...record,
      attachment_ids: [],
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      at: NOW,
    }),
    null,
  );
  await evidence.registerAttachment(upload);
  assert.equal(
    await evidence.prepare({
      ...record,
      gps: null,
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      at: NOW,
    }),
    null,
  );
});
