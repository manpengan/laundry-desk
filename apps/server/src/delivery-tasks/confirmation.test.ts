import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryOrder } from "@laundry/contracts";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext, DomainEvent } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createMemoryDeliveryTaskStore } from "./memory-store.js";
import type { DeliveryTaskHandlerDeps } from "./handlers.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const ADMIN = TENANT.staffId;
const STAFF = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CUSTOMER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TASK = "11111111-1111-4111-8111-111111111111";
const SUCCESSOR = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY = "33333333-3333-4333-8333-333333333333";
const NOW = 1_800_000_000;

const order: DeliveryOrder = Object.freeze({
  delivery_order_id: ORDER,
  laundry_order_id: "44444444-4444-4444-8444-444444444444",
  customer_id: CUSTOMER,
  collection_method: "pickup",
  return_method: "self_pickup",
  pickup_appointment_id: "55555555-5555-4555-8555-555555555555",
  return_appointment_id: null,
  pickup_fee_cents: 800,
  return_fee_cents: 0,
  total_fee_cents: 800,
  status: "pickup_scheduled",
  version: 3,
  created_at: NOW - 100,
  updated_at: NOW - 10,
  completed_at: null,
  cancelled_at: null,
  cancellation_reason: null,
});

function harness() {
  const store = createMemoryDeliveryTaskStore({
    orders: Object.freeze({
      get: async (orgId: string, storeId: string, orderId: string) =>
        orgId === TENANT.orgId && storeId === TENANT.storeId && orderId === ORDER ? order : null,
    }),
    isActiveStaff: async (staffId, adminOnly) =>
      [ADMIN, STAFF].includes(staffId) && (!adminOnly || staffId === ADMIN),
  });
  const ids = [TASK, SUCCESSOR];
  const deps: DeliveryTaskHandlerDeps = Object.freeze({
    store,
    orders: Object.freeze({ get: async () => order }),
    now: () => NOW,
    newId: () => ids.shift() ?? SUCCESSOR,
  });
  return Object.freeze({ store, deps });
}

function confirmationDetail(result: Awaited<ReturnType<typeof executeCommand>>) {
  assert.equal(result.ok, false);
  if (result.ok || !("detail" in result.error) || result.error.detail?.kind !== "confirmation") {
    throw new Error("expected confirmation detail");
  }
  return result.error.detail;
}

test("R3 assignment uses one reusable server-derived WYSIWYS card and customer owner", async () => {
  const { store, deps } = harness();
  const pendingStore = new MemoryPendingActionStore();
  const { registry, chainHooks } = createRegisteredM1Bus({ deliveryTasks: deps }, pendingStore);
  const actor: ActorContext = Object.freeze({
    staffId: ADMIN,
    deviceId: null,
    via: "ui",
    permissions: Object.freeze(["delivery_assign"]),
  });
  const input = Object.freeze({
    delivery_order_id: ORDER,
    leg: "pickup",
    expected_delivery_order_version: 3,
    assignee_staff_id: STAFF,
  });
  const options = Object.freeze({
    registry,
    chainHooks,
    pendingStore,
    actor,
    idempotencyKey: IDEMPOTENCY,
  });
  const first = confirmationDetail(
    await executeCommand(new FakeSqlClient(), TENANT, "delivery.task.assign", input, options),
  );
  const replay = confirmationDetail(
    await executeCommand(new FakeSqlClient(), TENANT, "delivery.task.assign", input, options),
  );
  assert.equal(first.confirm_ref, replay.confirm_ref);
  assert.deepEqual(first.summary, {
    kind: "delivery_task_operation",
    operation: "assign",
    delivery_order_id: ORDER,
    delivery_order_version: 3,
    leg: "pickup",
    delivery_task_id: null,
    delivery_task_version: null,
    current_status: null,
    from_assignee_staff_id: null,
    to_assignee_staff_id: STAFF,
    decision: null,
    resolution_reason: null,
  });
  const pending = await pendingStore.get(first.confirm_ref);
  assert.equal(pending?.privacySubjectCustomerId, CUSTOMER);
  assert.equal(pendingStore.size(), 1);
  assert.equal((await store.list(TENANT.orgId, TENANT.storeId, { limit: 10 })).length, 0);

  const events: DomainEvent[][] = [];
  const client = new FakeSqlClient();
  const executed = await executeCommand(
    client,
    TENANT,
    "delivery.task.assign",
    {},
    {
      ...options,
      confirmRef: first.confirm_ref,
      eventBus: {
        publish: (batch) => {
          events.push([...batch]);
        },
      },
    },
  );
  assert.equal(executed.ok, true);
  assert.equal((await store.get(TENANT.orgId, TENANT.storeId, TASK))?.status, "offered");
  assert.match(client.sqlSequence().join("\n"), /INSERT INTO audit_log/iu);
  assert.equal(client.sqlSequence().at(-1), "COMMIT");
  assert.equal(events[0]?.[0]?.type, "delivery.task.assigned");
});

test("R4 takeover freezes current custody and explicitly requires another administrator", async () => {
  const { store, deps } = harness();
  const assigned = await store.mutate({
    operation: "assign",
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    staff_id: ADMIN,
    delivery_task_id: TASK,
    delivery_order_id: ORDER,
    leg: "pickup",
    expected_delivery_order_version: 3,
    assignee_staff_id: STAFF,
    at: NOW,
  });
  assert.equal(assigned.ok, true);
  const accepted = await store.mutate({
    operation: "respond",
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    staff_id: STAFF,
    delivery_order_id: ORDER,
    leg: "pickup",
    delivery_task_id: TASK,
    expected_version: 1,
    expected_delivery_order_version: 3,
    decision: "accept",
    resolution_reason: null,
    at: NOW + 1,
  });
  assert.equal(accepted.ok, true);

  const pendingStore = new MemoryPendingActionStore();
  const { registry, chainHooks } = createRegisteredM1Bus({ deliveryTasks: deps }, pendingStore);
  const actor: ActorContext = Object.freeze({
    staffId: ADMIN,
    deviceId: null,
    via: "ui",
    permissions: Object.freeze(["delivery_takeover"]),
  });
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "delivery.task.takeover",
    {
      delivery_order_id: ORDER,
      leg: "pickup",
      delivery_task_id: TASK,
      expected_version: 2,
      resolution_reason: "emergency",
    },
    {
      registry,
      chainHooks,
      pendingStore,
      actor,
      idempotencyKey: IDEMPOTENCY,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "POLICY_STEP_UP_REQUIRED");
  const detail = confirmationDetail(result);
  assert.equal(detail.summary?.kind, "delivery_task_operation");
  if (detail.summary?.kind !== "delivery_task_operation") return;
  assert.equal(detail.summary.current_status, "accepted");
  assert.equal(detail.summary.from_assignee_staff_id, STAFF);
  assert.equal(detail.summary.to_assignee_staff_id, ADMIN);
  assert.equal(detail.summary.delivery_task_version, 2);
  assert.equal((await pendingStore.get(detail.confirm_ref))?.requiresOtherApprover, true);
  assert.equal((await store.get(TENANT.orgId, TENANT.storeId, TASK))?.status, "accepted");
});
