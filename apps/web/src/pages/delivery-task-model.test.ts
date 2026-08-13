import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeliveryOrder,
  DeliveryTask,
  DeliveryTaskConfirmationSummary,
} from "@laundry/contracts";

import {
  buildDeliveryTaskAssign,
  buildDeliveryTaskListInput,
  buildDeliveryTaskResponse,
  buildDeliveryTaskTakeover,
  buildDeliveryTaskTransfer,
  deliveryTaskCandidates,
  deliveryTaskPendingStillMatches,
  parseDeliveryTaskMutation,
  parseDeliveryTasks,
  type DeliveryTaskPendingAction,
} from "./delivery-task-model.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_A = "33333333-3333-4333-8333-333333333333";
const STAFF_B = "44444444-4444-4444-8444-444444444444";

const ORDER: DeliveryOrder = Object.freeze({
  delivery_order_id: ORDER_ID,
  laundry_order_id: "55555555-5555-4555-8555-555555555555",
  customer_id: "66666666-6666-4666-8666-666666666666",
  collection_method: "pickup",
  return_method: "delivery",
  pickup_appointment_id: null,
  return_appointment_id: null,
  pickup_fee_cents: 800,
  return_fee_cents: 900,
  total_fee_cents: 1_700,
  status: "pickup_scheduled",
  version: 4,
  created_at: 1_800_000_000,
  updated_at: 1_800_000_010,
  completed_at: null,
  cancelled_at: null,
  cancellation_reason: null,
});

const TASK: DeliveryTask = Object.freeze({
  delivery_task_id: TASK_ID,
  delivery_order_id: ORDER_ID,
  leg: "pickup",
  assignee_staff_id: STAFF_A,
  assigned_by_staff_id: STAFF_B,
  predecessor_task_id: null,
  source: "assignment",
  status: "offered",
  version: 2,
  created_at: 1_800_000_000,
  updated_at: 1_800_000_010,
  accepted_at: null,
  rejected_at: null,
  transferred_at: null,
  taken_over_at: null,
  completed_at: null,
  cancelled_at: null,
  resolution_reason: null,
});

test("task response parsers remain strict and bounded", () => {
  assert.deepEqual(parseDeliveryTasks({ result: { delivery_tasks: [TASK] } }), [TASK]);
  assert.deepEqual(parseDeliveryTaskMutation({ delivery_task: TASK, previous_task: null }), TASK);
  assert.equal(parseDeliveryTasks({ delivery_tasks: [{ ...TASK, gps: [1, 2] }] }), null);
  assert.deepEqual(buildDeliveryTaskListInput(STAFF_A), {
    assignee_staff_id: STAFF_A,
    active_only: true,
    limit: 100,
  });
});

test("scheduled order candidates freeze leg and order CAS for assignment", () => {
  const candidates = deliveryTaskCandidates([ORDER]);
  assert.deepEqual(candidates, [
    {
      key: `${ORDER_ID}:pickup`,
      delivery_order_id: ORDER_ID,
      leg: "pickup",
      order_version: 4,
    },
  ]);
  assert.deepEqual(buildDeliveryTaskAssign(candidates[0]!, STAFF_A), {
    delivery_order_id: ORDER_ID,
    leg: "pickup",
    expected_delivery_order_version: 4,
    assignee_staff_id: STAFF_A,
  });
  assert.deepEqual(deliveryTaskCandidates([{ ...ORDER, status: "return_scheduled" }]), [
    {
      key: `${ORDER_ID}:return`,
      delivery_order_id: ORDER_ID,
      leg: "return",
      order_version: 4,
    },
  ]);
});

test("respond, transfer and takeover builders bind the visible task version", () => {
  assert.deepEqual(buildDeliveryTaskResponse(TASK, "accept", "other"), {
    delivery_order_id: ORDER_ID,
    leg: "pickup",
    delivery_task_id: TASK_ID,
    expected_version: 2,
    decision: "accept",
  });
  assert.deepEqual(buildDeliveryTaskResponse(TASK, "reject", "capacity"), {
    delivery_order_id: ORDER_ID,
    leg: "pickup",
    delivery_task_id: TASK_ID,
    expected_version: 2,
    decision: "reject",
    resolution_reason: "capacity",
  });
  assert.equal(buildDeliveryTaskTransfer(TASK, "not-a-uuid", "other"), null);
  assert.deepEqual(buildDeliveryTaskTransfer(TASK, STAFF_B, "shift_end"), {
    delivery_order_id: ORDER_ID,
    leg: "pickup",
    delivery_task_id: TASK_ID,
    expected_version: 2,
    target_staff_id: STAFF_B,
    resolution_reason: "shift_end",
  });
  assert.deepEqual(buildDeliveryTaskTakeover(TASK, "emergency"), {
    delivery_order_id: ORDER_ID,
    leg: "pickup",
    delivery_task_id: TASK_ID,
    expected_version: 2,
    resolution_reason: "emergency",
  });
});

test("confirmation resume rejects stale task and order snapshots", () => {
  const summary: DeliveryTaskConfirmationSummary = Object.freeze({
    kind: "delivery_task_operation",
    operation: "respond",
    delivery_order_id: ORDER_ID,
    delivery_order_version: 4,
    leg: "pickup",
    delivery_task_id: TASK_ID,
    delivery_task_version: 2,
    current_status: "offered",
    from_assignee_staff_id: STAFF_A,
    to_assignee_staff_id: STAFF_A,
    decision: "accept",
    resolution_reason: null,
  });
  const pending: DeliveryTaskPendingAction = Object.freeze({
    command: "delivery.task.respond",
    body: buildDeliveryTaskResponse(TASK, "accept", "other")!,
    confirmRef: "77777777-7777-4777-8777-777777777777",
    kind: "confirm",
    summary,
  });
  assert.equal(deliveryTaskPendingStillMatches(pending, [TASK], []), true);
  assert.equal(deliveryTaskPendingStillMatches(pending, [{ ...TASK, version: 3 }], []), false);
  const assignPending: DeliveryTaskPendingAction = Object.freeze({
    command: "delivery.task.assign",
    body: buildDeliveryTaskAssign(deliveryTaskCandidates([ORDER])[0]!, STAFF_A)!,
    confirmRef: pending.confirmRef,
    kind: "confirm",
    summary: Object.freeze({
      ...summary,
      operation: "assign",
      delivery_task_id: null,
      delivery_task_version: null,
      current_status: null,
      from_assignee_staff_id: null,
      decision: null,
    }),
  });
  assert.equal(
    deliveryTaskPendingStillMatches(assignPending, [], deliveryTaskCandidates([ORDER])),
    true,
  );
  assert.equal(
    deliveryTaskPendingStillMatches(
      assignPending,
      [],
      deliveryTaskCandidates([{ ...ORDER, version: 5 }]),
    ),
    false,
  );
});
