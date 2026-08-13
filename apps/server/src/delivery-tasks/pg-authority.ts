import type { DeliveryTask } from "@laundry/contracts";

import type { SqlClient } from "../db/types.js";
import {
  activeStaff,
  activeTaskForLeg,
  latestReusablePredecessor,
  lockDeliveryOrder,
  lockTask,
  orderSupportsTask,
  type DeliveryOrderTaskRow,
} from "./pg-support.js";
import { freezeTaskConfirmation, type DeliveryTaskPrepareRequest } from "./types.js";

export type PreparedTaskAuthority = Readonly<{
  summary: ReturnType<typeof freezeTaskConfirmation>;
  order: DeliveryOrderTaskRow;
  task: DeliveryTask | null;
  predecessor: DeliveryTask | null;
}>;

function summaryFor(
  request: DeliveryTaskPrepareRequest,
  order: DeliveryOrderTaskRow,
  task: DeliveryTask | null,
) {
  const toStaff =
    request.operation === "assign"
      ? request.assignee_staff_id
      : request.operation === "transfer"
        ? request.target_staff_id
        : request.operation === "takeover"
          ? request.staff_id
          : (task?.assignee_staff_id ?? request.staff_id);
  return freezeTaskConfirmation({
    kind: "delivery_task_operation",
    operation: request.operation,
    delivery_order_id: order.delivery_order_id,
    delivery_order_version: order.version,
    leg: request.leg,
    delivery_task_id: task?.delivery_task_id ?? null,
    delivery_task_version: task?.version ?? null,
    current_status: task?.status ?? null,
    from_assignee_staff_id: task?.assignee_staff_id ?? null,
    to_assignee_staff_id: toStaff,
    decision: request.operation === "respond" ? request.decision : null,
    resolution_reason:
      request.operation === "respond"
        ? request.resolution_reason
        : request.operation === "transfer" || request.operation === "takeover"
          ? request.resolution_reason
          : null,
  });
}

async function prepareAssignment(
  client: SqlClient,
  request: Extract<DeliveryTaskPrepareRequest, Readonly<{ operation: "assign" }>>,
  order: DeliveryOrderTaskRow,
): Promise<PreparedTaskAuthority | null> {
  const active = await activeTaskForLeg(client, request);
  const predecessor = await latestReusablePredecessor(client, request);
  if (
    order.version !== request.expected_delivery_order_version ||
    !orderSupportsTask(order, request.leg, predecessor === null) ||
    active !== null ||
    !(await activeStaff(client, request, request.staff_id, true)) ||
    !(await activeStaff(client, request, request.assignee_staff_id, false))
  ) {
    return null;
  }
  return Object.freeze({
    summary: summaryFor(request, order, null),
    order,
    task: null,
    predecessor,
  });
}

async function prepareExisting(
  client: SqlClient,
  request: Exclude<DeliveryTaskPrepareRequest, Readonly<{ operation: "assign" }>>,
  order: DeliveryOrderTaskRow,
): Promise<PreparedTaskAuthority | null> {
  if (!orderSupportsTask(order, request.leg, false)) return null;
  const task = await lockTask(client, request);
  if (
    task === null ||
    task.delivery_order_id !== request.delivery_order_id ||
    task.leg !== request.leg ||
    task.version !== request.expected_version ||
    (task.status !== "offered" && task.status !== "accepted")
  ) {
    return null;
  }
  if (request.operation === "respond") {
    if (task.status !== "offered" || task.assignee_staff_id !== request.staff_id) return null;
  } else if (request.operation === "transfer") {
    if (
      !(await activeStaff(client, request, request.staff_id, true)) ||
      !(await activeStaff(client, request, request.target_staff_id, false)) ||
      request.target_staff_id === task.assignee_staff_id
    ) {
      return null;
    }
  } else if (
    !(await activeStaff(client, request, request.staff_id, true)) ||
    request.staff_id === task.assignee_staff_id
  ) {
    return null;
  }
  return Object.freeze({
    summary: summaryFor(request, order, task),
    order,
    task,
    predecessor: null,
  });
}

/** Lock order first, then task, then staff rows for every task mutation. */
export async function preparePgTaskAuthority(
  client: SqlClient,
  request: DeliveryTaskPrepareRequest,
): Promise<PreparedTaskAuthority | null> {
  const order = await lockDeliveryOrder(client, request);
  if (order === null) return null;
  return request.operation === "assign"
    ? prepareAssignment(client, request, order)
    : prepareExisting(client, request, order);
}
