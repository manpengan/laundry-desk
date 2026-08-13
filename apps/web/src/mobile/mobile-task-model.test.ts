import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryOrder, DeliveryTask } from "@laundry/contracts";

import {
  buildMobileTaskOrderTransition,
  buildMobileTaskTransitionAuthority,
  mobileTaskAvailabilityCopy,
  mobileTaskDetailStillMatches,
  mobileTaskExecutionAction,
  mobileTaskResponseResultMatches,
  mobileTaskResponseSummaryMatches,
  mobileTaskTransitionAuthorityKey,
  mobileTaskTransitionResultMatches,
  mobileTaskTransitionStillMatches,
  parseMobileTaskDetail,
  parseMyDeliveryTasks,
} from "./mobile-task-model.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "33333333-3333-4333-8333-333333333333";

const ORDER: DeliveryOrder = Object.freeze({
  delivery_order_id: ORDER_ID,
  laundry_order_id: "44444444-4444-4444-8444-444444444444",
  customer_id: "55555555-5555-4555-8555-555555555555",
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
  assignee_staff_id: STAFF_ID,
  assigned_by_staff_id: "66666666-6666-4666-8666-666666666666",
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

function busResult(result: unknown): unknown {
  return Object.freeze({ execution: "executed", result });
}

test("my-task parsing is strict, assignee-bound and newest-first", () => {
  const older = Object.freeze({ ...TASK, updated_at: TASK.updated_at - 1, version: 1 });
  assert.deepEqual(parseMyDeliveryTasks(busResult({ delivery_tasks: [older, TASK] }), STAFF_ID), [
    TASK,
    older,
  ]);
  assert.equal(
    parseMyDeliveryTasks(
      busResult({
        delivery_tasks: [{ ...TASK, assignee_staff_id: "77777777-7777-4777-8777-777777777777" }],
      }),
      STAFF_ID,
    ),
    null,
  );
  assert.equal(
    parseMyDeliveryTasks(busResult({ delivery_tasks: [{ ...TASK, gps: [1, 2] }] }), STAFF_ID),
    null,
  );
});

test("detail parsing binds task, order and current employee without expanding evidence", () => {
  const detail = parseMobileTaskDetail(
    busResult({ delivery_task: TASK }),
    busResult({ delivery_order: ORDER }),
    { taskId: TASK_ID, orderId: ORDER_ID, currentStaffId: STAFF_ID },
  );
  assert.deepEqual(detail, { task: TASK, order: ORDER });
  assert.doesNotMatch(JSON.stringify(detail), /gps|latitude|longitude|photo|signature/iu);
  assert.equal(
    parseMobileTaskDetail(
      busResult({ delivery_task: TASK }),
      busResult({ delivery_order: ORDER }),
      {
        taskId: TASK_ID,
        orderId: ORDER_ID,
        currentStaffId: "77777777-7777-4777-8777-777777777777",
      },
    ),
    null,
  );
  assert.equal(
    parseMobileTaskDetail(
      busResult({ delivery_task: { ...TASK, signature: "unexpected" } }),
      busResult({ delivery_order: ORDER }),
      { taskId: TASK_ID, orderId: ORDER_ID, currentStaffId: STAFF_ID },
    ),
    null,
  );
});

test("accepted pickup and return tasks expose only start actions; evidence owns completion", () => {
  const pickup = Object.freeze({
    task: Object.freeze({ ...TASK, status: "accepted" as const }),
    order: ORDER,
  });
  const pickupAction = mobileTaskExecutionAction(pickup);
  assert.equal(pickupAction?.targetStatus, "pickup_in_progress");
  assert.deepEqual(
    pickupAction === null ? null : buildMobileTaskOrderTransition(pickup, pickupAction),
    {
      delivery_order_id: ORDER_ID,
      customer_id: ORDER.customer_id,
      expected_version: 4,
      target_status: "pickup_in_progress",
    },
  );

  const returnDetail = Object.freeze({
    task: Object.freeze({ ...TASK, status: "accepted" as const, leg: "return" as const }),
    order: Object.freeze({ ...ORDER, status: "return_scheduled" as const }),
  });
  assert.equal(mobileTaskExecutionAction(returnDetail)?.targetStatus, "return_in_progress");
  assert.equal(
    mobileTaskExecutionAction({
      ...returnDetail,
      order: { ...returnDetail.order, status: "return_in_progress" },
    }),
    null,
  );
  assert.equal(
    mobileTaskExecutionAction({
      ...pickup,
      order: { ...ORDER, status: "pickup_in_progress" },
    }),
    null,
  );
  assert.equal(
    mobileTaskExecutionAction({ ...pickup, order: { ...ORDER, status: "at_store" } }),
    null,
  );
  assert.equal(mobileTaskExecutionAction({ ...pickup, task: TASK }), null);
});

test("confirmation snapshots reject task or order version changes", () => {
  const detail = Object.freeze({ task: TASK, order: ORDER });
  const expected = Object.freeze({
    taskId: TASK_ID,
    taskVersion: 2,
    taskStatus: "offered" as const,
    orderId: ORDER_ID,
    orderVersion: 4,
  });
  assert.equal(mobileTaskDetailStillMatches(detail, expected), true);
  assert.equal(
    mobileTaskDetailStillMatches({ ...detail, task: { ...TASK, version: 3 } }, expected),
    false,
  );
  assert.equal(
    mobileTaskDetailStillMatches({ ...detail, order: { ...ORDER, version: 5 } }, expected),
    false,
  );
  assert.match(mobileTaskAvailabilityCopy(TASK, ORDER), /先接受或拒绝/u);
});

test("transition pending freezes complete task, order and route authority", () => {
  const detail = Object.freeze({
    task: Object.freeze({ ...TASK, status: "accepted" as const }),
    order: ORDER,
  });
  const action = mobileTaskExecutionAction(detail);
  assert.ok(action);
  if (action === null) return;
  const body = buildMobileTaskOrderTransition(detail, action);
  assert.ok(body);
  if (body === null) return;
  const authority = buildMobileTaskTransitionAuthority(detail, action, body);
  assert.deepEqual(authority, {
    deliveryTaskId: TASK_ID,
    deliveryTaskVersion: 2,
    taskStatus: "accepted",
    leg: "pickup",
    deliveryOrderId: ORDER_ID,
    laundryOrderId: ORDER.laundry_order_id,
    deliveryOrderVersion: 4,
    currentStatus: "pickup_scheduled",
    targetStatus: "pickup_in_progress",
    collectionMethod: "pickup",
    returnMethod: "delivery",
    cancellationReason: null,
    taskSnapshotKey: JSON.stringify(detail.task),
    orderSnapshotKey: JSON.stringify(detail.order),
  });
  assert.ok(authority);
  if (authority === null) return;
  const scope = "session:store:staff:v1";
  const authorityKey = mobileTaskTransitionAuthorityKey(scope, body, authority);
  assert.equal(
    mobileTaskTransitionStillMatches(scope, detail, body, authority, authorityKey),
    true,
  );
  assert.equal(
    mobileTaskTransitionStillMatches(
      scope,
      { ...detail, task: { ...detail.task, version: 3 } },
      body,
      authority,
      authorityKey,
    ),
    false,
  );
  assert.equal(
    mobileTaskTransitionStillMatches(
      scope,
      { ...detail, order: { ...ORDER, total_fee_cents: ORDER.total_fee_cents + 1 } },
      body,
      authority,
      authorityKey,
    ),
    false,
  );
  assert.equal(
    mobileTaskTransitionStillMatches(
      scope,
      {
        ...detail,
        task: {
          ...detail.task,
          delivery_task_id: "77777777-7777-4777-8777-777777777777",
        },
      },
      body,
      authority,
      authorityKey,
    ),
    false,
  );
  assert.equal(
    mobileTaskTransitionStillMatches(
      scope,
      { ...detail, order: { ...ORDER, status: "pickup_in_progress", version: 5 } },
      body,
      authority,
      authorityKey,
    ),
    false,
  );
  assert.equal(mobileTaskTransitionStillMatches(scope, null, body, authority, authorityKey), false);
  assert.equal(
    mobileTaskTransitionStillMatches("new-session:store", detail, body, authority, authorityKey),
    false,
  );
});

test("respond confirmation binds the server summary to the exact detail and decision", () => {
  const detail = Object.freeze({ task: TASK, order: ORDER });
  const body = Object.freeze({
    delivery_order_id: ORDER_ID,
    leg: "pickup" as const,
    delivery_task_id: TASK_ID,
    expected_version: 2,
    decision: "accept" as const,
  });
  const summary = Object.freeze({
    kind: "delivery_task_operation" as const,
    operation: "respond" as const,
    delivery_order_id: ORDER_ID,
    delivery_order_version: 4,
    leg: "pickup" as const,
    delivery_task_id: TASK_ID,
    delivery_task_version: 2,
    current_status: "offered" as const,
    from_assignee_staff_id: STAFF_ID,
    to_assignee_staff_id: STAFF_ID,
    decision: "accept" as const,
    resolution_reason: null,
  });
  assert.equal(mobileTaskResponseSummaryMatches(detail, STAFF_ID, body, summary), true);
  assert.equal(
    mobileTaskResponseSummaryMatches(detail, STAFF_ID, body, {
      ...summary,
      delivery_order_version: 5,
    }),
    false,
  );
  assert.equal(
    mobileTaskResponseSummaryMatches(detail, STAFF_ID, body, {
      ...summary,
      decision: "reject",
      resolution_reason: "capacity",
    }),
    false,
  );
  assert.equal(
    mobileTaskResponseResultMatches(
      { ...TASK, status: "accepted", version: 3, accepted_at: TASK.updated_at + 1 },
      detail,
      STAFF_ID,
      body,
    ),
    true,
  );
  assert.equal(
    mobileTaskResponseResultMatches(
      { ...TASK, status: "accepted", version: 4, accepted_at: TASK.updated_at + 1 },
      detail,
      STAFF_ID,
      body,
    ),
    false,
  );
});

test("transition success must preserve immutable order identity and advance exactly once", () => {
  const detail = Object.freeze({
    task: Object.freeze({ ...TASK, status: "accepted" as const }),
    order: ORDER,
  });
  const action = mobileTaskExecutionAction(detail);
  assert.ok(action);
  if (action === null) return;
  const body = buildMobileTaskOrderTransition(detail, action);
  assert.ok(body);
  if (body === null) return;
  const updated = Object.freeze({
    ...ORDER,
    status: "pickup_in_progress" as const,
    version: 5,
    updated_at: ORDER.updated_at + 1,
  });

  assert.equal(mobileTaskTransitionResultMatches(updated, detail, body), true);
  assert.equal(
    mobileTaskTransitionResultMatches(
      { ...updated, laundry_order_id: "88888888-8888-4888-8888-888888888888" },
      detail,
      body,
    ),
    false,
  );
  assert.equal(
    mobileTaskTransitionResultMatches(
      { ...updated, total_fee_cents: updated.total_fee_cents + 1 },
      detail,
      body,
    ),
    false,
  );
});
