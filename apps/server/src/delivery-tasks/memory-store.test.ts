import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryOrder } from "@laundry/contracts";

import type { DeliveryOrderHandlerDeps } from "../delivery-orders/handlers.js";
import type {
  DeliveryOrderStore,
  DeliveryOrderTransitionRequest,
} from "../delivery-orders/types.js";
import { bindMemoryDeliveryTaskOrderAuthority } from "./order-authority.js";
import { createMemoryDeliveryTaskStore } from "./memory-store.js";
import type { DeliveryTaskMutationResult, DeliveryTaskStore } from "./types.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN_TWO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const STAFF_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const INACTIVE = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const TASK_ONE = "33333333-3333-4333-8333-333333333333";
const TASK_TWO = "44444444-4444-4444-8444-444444444444";
const TASK_THREE = "55555555-5555-4555-8555-555555555555";
const NOW = 1_800_000_000;

function deliveryOrder(
  status: DeliveryOrder["status"] = "pickup_scheduled",
  version = 3,
): DeliveryOrder {
  return Object.freeze({
    delivery_order_id: ORDER,
    laundry_order_id: "66666666-6666-4666-8666-666666666666",
    customer_id: "77777777-7777-4777-8777-777777777777",
    collection_method: "pickup",
    return_method: "delivery",
    pickup_appointment_id: "88888888-8888-4888-8888-888888888888",
    return_appointment_id: "99999999-9999-4999-8999-999999999999",
    pickup_fee_cents: 800,
    return_fee_cents: 900,
    total_fee_cents: 1_700,
    status,
    version,
    created_at: NOW - 100,
    updated_at: NOW - 10,
    completed_at: status === "completed" ? NOW - 10 : null,
    cancelled_at: status === "cancelled" ? NOW - 10 : null,
    cancellation_reason: status === "cancelled" ? "other" : null,
  });
}

function successful(result: DeliveryTaskMutationResult) {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected successful task mutation");
  return result;
}

function harness() {
  let order = deliveryOrder();
  const roles = new Map<string, "admin" | "staff">([
    [ADMIN, "admin"],
    [ADMIN_TWO, "admin"],
    [STAFF_A, "staff"],
    [STAFF_B, "staff"],
  ] as const);
  const store = createMemoryDeliveryTaskStore({
    orders: Object.freeze({
      get: async (orgId: string, storeId: string, orderId: string) =>
        orgId === ORG && storeId === STORE && orderId === ORDER ? order : null,
    }),
    isActiveStaff: async (staffId, adminOnly) => {
      const role = roles.get(staffId);
      return role !== undefined && (!adminOnly || role === "admin");
    },
  });
  return Object.freeze({
    store,
    order: () => order,
    setOrder: (next: DeliveryOrder) => {
      order = next;
    },
  });
}

function assign(
  store: DeliveryTaskStore,
  overrides: Readonly<Partial<Parameters<DeliveryTaskStore["mutate"]>[0]>> = {},
) {
  return store.mutate({
    operation: "assign",
    org_id: ORG,
    store_id: STORE,
    staff_id: ADMIN,
    delivery_task_id: TASK_ONE,
    delivery_order_id: ORDER,
    leg: "pickup",
    expected_delivery_order_version: 3,
    assignee_staff_id: STAFF_A,
    at: NOW,
    ...overrides,
  } as Parameters<DeliveryTaskStore["mutate"]>[0]);
}

function respond(
  store: DeliveryTaskStore,
  taskId = TASK_ONE,
  staffId = STAFF_A,
  expectedVersion = 1,
  decision: "accept" | "reject" = "accept",
  expectedOrderVersion = 3,
  at = NOW + 1,
) {
  return store.mutate({
    operation: "respond",
    org_id: ORG,
    store_id: STORE,
    staff_id: staffId,
    delivery_order_id: ORDER,
    leg: "pickup",
    delivery_task_id: taskId,
    expected_version: expectedVersion,
    expected_delivery_order_version: expectedOrderVersion,
    decision,
    resolution_reason: decision === "reject" ? "capacity" : null,
    at,
  });
}

test("assignment binds one active leg to current-store active staff with CAS", async () => {
  const { store } = harness();
  const assigned = successful(await assign(store));
  assert.equal(assigned.delivery_task.status, "offered");
  assert.equal(assigned.delivery_task.assignee_staff_id, STAFF_A);
  assert.equal(Object.isFrozen(assigned.delivery_task), true);
  assert.equal((await assign(store, { delivery_task_id: TASK_TWO })).ok, false);

  const inactive = harness();
  assert.equal((await assign(inactive.store, { assignee_staff_id: INACTIVE })).ok, false);
  assert.equal((await assign(inactive.store, { expected_delivery_order_version: 4 })).ok, false);
  assert.equal((await assign(inactive.store, { staff_id: STAFF_A })).ok, false);
  assert.equal(await store.get(ORG, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", TASK_ONE), null);
});

test("only the offered assignee can accept or reject and stale versions fail closed", async () => {
  const { store } = harness();
  successful(await assign(store));
  assert.equal((await respond(store, TASK_ONE, STAFF_B)).ok, false);
  const accepted = successful(await respond(store));
  assert.equal(accepted.delivery_task.status, "accepted");
  assert.equal(accepted.delivery_task.version, 2);
  assert.equal(accepted.delivery_task.accepted_at, NOW + 1);
  assert.equal((await respond(store)).ok, false);
});

test("admin transfer preserves immutable predecessor and rejects successor id collision", async () => {
  const { store } = harness();
  successful(await assign(store));
  successful(await respond(store));
  const transferred = successful(
    await store.mutate({
      operation: "transfer",
      org_id: ORG,
      store_id: STORE,
      staff_id: ADMIN,
      delivery_order_id: ORDER,
      leg: "pickup",
      delivery_task_id: TASK_ONE,
      successor_task_id: TASK_TWO,
      expected_version: 2,
      expected_delivery_order_version: 3,
      target_staff_id: STAFF_B,
      resolution_reason: "shift_end",
      at: NOW + 2,
    }),
  );
  assert.equal(transferred.previous_task?.status, "transferred");
  assert.equal(transferred.delivery_task.status, "offered");
  assert.equal(transferred.delivery_task.predecessor_task_id, TASK_ONE);
  assert.equal((await store.get(ORG, STORE, TASK_ONE))?.status, "transferred");

  const collision = await store.mutate({
    operation: "transfer",
    org_id: ORG,
    store_id: STORE,
    staff_id: ADMIN,
    delivery_order_id: ORDER,
    leg: "pickup",
    delivery_task_id: TASK_TWO,
    successor_task_id: TASK_ONE,
    expected_version: 1,
    expected_delivery_order_version: 3,
    target_staff_id: STAFF_A,
    resolution_reason: "route_conflict",
    at: NOW + 3,
  });
  assert.equal(collision.ok, false);
  assert.equal((await store.get(ORG, STORE, TASK_TWO))?.status, "offered");
});

test("manual takeover changes custody to another active admin and creates an accepted successor", async () => {
  const { store } = harness();
  successful(await assign(store));
  successful(await respond(store));
  const takeover = successful(
    await store.mutate({
      operation: "takeover",
      org_id: ORG,
      store_id: STORE,
      staff_id: ADMIN_TWO,
      delivery_order_id: ORDER,
      leg: "pickup",
      delivery_task_id: TASK_ONE,
      successor_task_id: TASK_TWO,
      expected_version: 2,
      expected_delivery_order_version: 3,
      resolution_reason: "emergency",
      at: NOW + 2,
    }),
  );
  assert.equal(takeover.previous_task?.status, "taken_over");
  assert.equal(takeover.delivery_task.status, "accepted");
  assert.equal(takeover.delivery_task.assignee_staff_id, ADMIN_TWO);
  assert.equal(takeover.delivery_task.accepted_at, NOW + 2);

  const self = harness();
  successful(await assign(self.store, { assignee_staff_id: ADMIN_TWO }));
  assert.equal(
    (
      await self.store.mutate({
        operation: "takeover",
        org_id: ORG,
        store_id: STORE,
        staff_id: ADMIN_TWO,
        delivery_order_id: ORDER,
        leg: "pickup",
        delivery_task_id: TASK_ONE,
        successor_task_id: TASK_TWO,
        expected_version: 1,
        expected_delivery_order_version: 3,
        resolution_reason: "emergency",
        at: NOW + 1,
      })
    ).ok,
    false,
  );
});

test("an in-progress leg can be reoffered after rejection without reusing linked history", async () => {
  const { store, setOrder } = harness();
  successful(await assign(store));
  successful(await respond(store, TASK_ONE, STAFF_A, 1, "reject"));
  setOrder(deliveryOrder("pickup_in_progress", 4));
  const reoffered = successful(
    await assign(store, {
      delivery_task_id: TASK_TWO,
      expected_delivery_order_version: 4,
      assignee_staff_id: STAFF_B,
      at: NOW + 2,
    }),
  );
  assert.equal(reoffered.delivery_task.predecessor_task_id, TASK_ONE);
  successful(await respond(store, TASK_TWO, STAFF_B, 1, "reject", 4, NOW + 3));
  const next = successful(
    await assign(store, {
      delivery_task_id: TASK_THREE,
      expected_delivery_order_version: 4,
      assignee_staff_id: STAFF_A,
      at: NOW + 4,
    }),
  );
  assert.equal(next.delivery_task.predecessor_task_id, TASK_TWO);
});

test("order execution requires the accepted assignee and settles task truth", async () => {
  let order = deliveryOrder();
  const base: DeliveryOrderStore = Object.freeze({
    create: async () => Object.freeze({ ok: false as const, reason: "feature_disabled" as const }),
    get: async (orgId, storeId, orderId) =>
      orgId === ORG && storeId === STORE && orderId === ORDER ? order : null,
    list: async () => Object.freeze([order]),
    transition: async (request: DeliveryOrderTransitionRequest) => {
      if (request.expected_version !== order.version) {
        return Object.freeze({ ok: false as const, reason: "state_conflict" as const });
      }
      const before = order;
      order = Object.freeze({
        ...order,
        status: request.target_status,
        version: order.version + 1,
        updated_at: request.at,
      });
      return Object.freeze({ ok: true as const, delivery_order: order, before });
    },
  });
  const tasks = createMemoryDeliveryTaskStore({
    orders: base,
    isActiveStaff: async (staffId, adminOnly) =>
      [ADMIN, STAFF_A].includes(staffId) && (!adminOnly || staffId === ADMIN),
  });
  const wrapped = bindMemoryDeliveryTaskOrderAuthority(
    Object.freeze({ store: base }) as DeliveryOrderHandlerDeps,
    tasks,
  ).store;
  const start = Object.freeze({
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF_A,
    delivery_order_id: ORDER,
    customer_id: order.customer_id,
    expected_version: 3,
    target_status: "pickup_in_progress" as const,
    cancellation_reason: null,
    at: NOW + 1,
  });
  assert.equal((await wrapped.transition(start)).ok, false);
  successful(await assign(tasks));
  successful(await respond(tasks));
  assert.equal((await wrapped.transition(start)).ok, true);
  assert.equal(
    (
      await wrapped.transition({
        ...start,
        expected_version: 4,
        target_status: "picked_up",
        at: NOW + 2,
      })
    ).ok,
    true,
  );
  assert.equal((await tasks.get(ORG, STORE, TASK_ONE))?.status, "completed");
});
