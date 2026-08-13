import type { DeliveryOrder, DeliveryTask, DeliveryTaskStatus } from "@laundry/contracts";
import {
  DELIVERY_TASK_ACTIVE_STATUSES,
  canTransitionDeliveryTask,
  deliveryTaskAssignableOrderStatus,
  deliveryTaskLegMatchesRoute,
} from "@laundry/domain";

import type { DeliveryOrderStore } from "../delivery-orders/types.js";
import {
  createdDeliveryTask,
  freezeDeliveryTask,
  freezeTaskConfirmation,
  type DeliveryTaskMutationRequest,
  type DeliveryTaskMutationResult,
  type DeliveryTaskPrepareRequest,
  type DeliveryTaskStore,
} from "./types.js";

export type MemoryDeliveryTaskDeps = Readonly<{
  orders: Pick<DeliveryOrderStore, "get">;
  isActiveStaff: (staffId: string, adminOnly: boolean) => Promise<boolean>;
}>;

const key = (orgId: string, storeId: string, taskId: string): string =>
  `${orgId}|${storeId}|${taskId}`;

type StoredTask = Readonly<{ org_id: string; store_id: string; task: DeliveryTask }>;

function scoped(rows: ReadonlyMap<string, StoredTask>, orgId: string, storeId: string) {
  return [...rows.values()].filter((row) => row.org_id === orgId && row.store_id === storeId);
}

function activeTask(
  rows: ReadonlyMap<string, StoredTask>,
  orgId: string,
  storeId: string,
  deliveryOrderId: string,
  leg: DeliveryTask["leg"],
): DeliveryTask | null {
  return (
    scoped(rows, orgId, storeId)
      .map(({ task }) => task)
      .find(
        (task) =>
          task.delivery_order_id === deliveryOrderId &&
          task.leg === leg &&
          DELIVERY_TASK_ACTIVE_STATUSES.has(task.status),
      ) ?? null
  );
}

function latestReusablePredecessor(
  rows: ReadonlyMap<string, StoredTask>,
  request: DeliveryTaskPrepareRequest,
): DeliveryTask | null {
  const linkedPredecessors = new Set(
    scoped(rows, request.org_id, request.store_id)
      .map(({ task }) => task.predecessor_task_id)
      .filter((taskId): taskId is string => taskId !== null),
  );
  return (
    scoped(rows, request.org_id, request.store_id)
      .map(({ task }) => task)
      .filter(
        (task) =>
          task.delivery_order_id === request.delivery_order_id &&
          task.leg === request.leg &&
          (task.status === "rejected" || task.status === "cancelled") &&
          !linkedPredecessors.has(task.delivery_task_id),
      )
      .sort(
        (left, right) =>
          right.updated_at - left.updated_at ||
          right.delivery_task_id.localeCompare(left.delivery_task_id),
      )[0] ?? null
  );
}

function orderSupports(order: DeliveryOrder, leg: DeliveryTask["leg"], initial: boolean): boolean {
  if (
    !deliveryTaskLegMatchesRoute(leg, {
      collectionMethod: order.collection_method,
      returnMethod: order.return_method,
    })
  ) {
    return false;
  }
  const scheduled = deliveryTaskAssignableOrderStatus(leg);
  if (initial) return order.status === scheduled;
  return (
    order.status === scheduled ||
    (leg === "pickup"
      ? order.status === "pickup_in_progress"
      : order.status === "return_in_progress")
  );
}

function confirmation(
  input: Readonly<{
    request: DeliveryTaskPrepareRequest;
    order: DeliveryOrder;
    task: DeliveryTask | null;
  }>,
) {
  const { request, order, task } = input;
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

async function prepareFrom(
  deps: MemoryDeliveryTaskDeps,
  rows: ReadonlyMap<string, StoredTask>,
  request: DeliveryTaskPrepareRequest,
) {
  const order = await deps.orders.get(request.org_id, request.store_id, request.delivery_order_id);
  if (order === null) return null;
  const reusablePredecessor =
    request.operation === "assign" ? latestReusablePredecessor(rows, request) : null;
  if (
    !orderSupports(
      order,
      request.leg,
      request.operation === "assign" && reusablePredecessor === null,
    )
  ) {
    return null;
  }
  if (request.operation === "assign") {
    if (
      order.version !== request.expected_delivery_order_version ||
      activeTask(rows, request.org_id, request.store_id, request.delivery_order_id, request.leg) !==
        null ||
      !(await deps.isActiveStaff(request.staff_id, true)) ||
      !(await deps.isActiveStaff(request.assignee_staff_id, false))
    ) {
      return null;
    }
    return confirmation({ request, order, task: null });
  }
  const task = rows.get(key(request.org_id, request.store_id, request.delivery_task_id))?.task;
  if (
    task === undefined ||
    task.delivery_order_id !== request.delivery_order_id ||
    task.leg !== request.leg ||
    task.version !== request.expected_version ||
    !DELIVERY_TASK_ACTIVE_STATUSES.has(task.status)
  ) {
    return null;
  }
  if (request.operation === "respond") {
    if (task.status !== "offered" || task.assignee_staff_id !== request.staff_id) return null;
  } else if (request.operation === "transfer") {
    if (
      !(await deps.isActiveStaff(request.staff_id, true)) ||
      !(await deps.isActiveStaff(request.target_staff_id, false)) ||
      request.target_staff_id === task.assignee_staff_id
    ) {
      return null;
    }
  } else if (
    !(await deps.isActiveStaff(request.staff_id, true)) ||
    request.staff_id === task.assignee_staff_id
  ) {
    return null;
  }
  return confirmation({ request, order, task });
}

function resolvedTask(
  current: DeliveryTask,
  status: DeliveryTaskStatus,
  request: DeliveryTaskMutationRequest,
): DeliveryTask {
  const reason =
    request.operation === "respond"
      ? request.resolution_reason
      : request.operation === "transfer" || request.operation === "takeover"
        ? request.resolution_reason
        : null;
  return freezeDeliveryTask({
    ...current,
    status,
    version: current.version + 1,
    updated_at: request.at,
    accepted_at: status === "accepted" ? request.at : current.accepted_at,
    rejected_at: status === "rejected" ? request.at : null,
    transferred_at: status === "transferred" ? request.at : null,
    taken_over_at: status === "taken_over" ? request.at : null,
    completed_at: status === "completed" ? request.at : null,
    cancelled_at: status === "cancelled" ? request.at : null,
    resolution_reason: ["rejected", "transferred", "taken_over"].includes(status) ? reason : null,
  });
}

function setTask(
  rows: ReadonlyMap<string, StoredTask>,
  orgId: string,
  storeId: string,
  task: DeliveryTask,
) {
  return new Map(rows).set(
    key(orgId, storeId, task.delivery_task_id),
    Object.freeze({ org_id: orgId, store_id: storeId, task }),
  );
}

export function createMemoryDeliveryTaskStore(deps: MemoryDeliveryTaskDeps): DeliveryTaskStore {
  let rows: ReadonlyMap<string, StoredTask> = new Map();
  return Object.freeze({
    prepare: (request) => prepareFrom(deps, rows, request),
    async mutate(request): Promise<DeliveryTaskMutationResult> {
      const prepared = await prepareFrom(deps, rows, request);
      if (prepared === null) return Object.freeze({ ok: false, reason: "state_conflict" });
      const newTaskId =
        request.operation === "assign"
          ? request.delivery_task_id
          : request.operation === "transfer" || request.operation === "takeover"
            ? request.successor_task_id
            : null;
      if (
        prepared.delivery_order_version !== request.expected_delivery_order_version ||
        (newTaskId !== null && rows.has(key(request.org_id, request.store_id, newTaskId)))
      ) {
        return Object.freeze({ ok: false, reason: "state_conflict" });
      }
      if (request.operation === "assign") {
        const predecessor = latestReusablePredecessor(rows, request);
        const task = createdDeliveryTask({
          request,
          source: "assignment",
          status: "offered",
          assignee_staff_id: request.assignee_staff_id,
          predecessor_task_id: predecessor?.delivery_task_id ?? null,
        });
        rows = setTask(rows, request.org_id, request.store_id, task);
        return Object.freeze({
          ok: true,
          delivery_task: task,
          previous_task: predecessor,
          before: null,
        });
      }
      const current = rows.get(
        key(request.org_id, request.store_id, request.delivery_task_id),
      )?.task;
      if (current === undefined) return Object.freeze({ ok: false, reason: "not_found" });
      if (request.at < current.updated_at) {
        return Object.freeze({ ok: false, reason: "state_conflict" });
      }
      if (request.operation === "respond") {
        const status = request.decision === "accept" ? "accepted" : "rejected";
        const updated = resolvedTask(current, status, request);
        rows = setTask(rows, request.org_id, request.store_id, updated);
        return Object.freeze({
          ok: true,
          delivery_task: updated,
          previous_task: null,
          before: current,
        });
      }
      const terminalStatus = request.operation === "transfer" ? "transferred" : "taken_over";
      if (!canTransitionDeliveryTask(current.status, terminalStatus)) {
        return Object.freeze({ ok: false, reason: "state_conflict" });
      }
      const terminal = resolvedTask(current, terminalStatus, request);
      const successor = createdDeliveryTask({
        request,
        source: request.operation,
        status: request.operation === "takeover" ? "accepted" : "offered",
        assignee_staff_id:
          request.operation === "takeover" ? request.staff_id : request.target_staff_id,
        predecessor_task_id: current.delivery_task_id,
      });
      rows = setTask(
        setTask(rows, request.org_id, request.store_id, terminal),
        request.org_id,
        request.store_id,
        successor,
      );
      return Object.freeze({
        ok: true,
        delivery_task: successor,
        previous_task: terminal,
        before: current,
      });
    },
    async get(orgId, storeId, taskId) {
      return rows.get(key(orgId, storeId, taskId))?.task ?? null;
    },
    async list(orgId, storeId, filter) {
      return Object.freeze(
        scoped(rows, orgId, storeId)
          .map(({ task }) => task)
          .filter(
            (task) =>
              (filter.delivery_order_id === undefined ||
                task.delivery_order_id === filter.delivery_order_id) &&
              (filter.leg === undefined || task.leg === filter.leg) &&
              (filter.assignee_staff_id === undefined ||
                task.assignee_staff_id === filter.assignee_staff_id) &&
              (filter.status === undefined || task.status === filter.status) &&
              (filter.active_only !== true || DELIVERY_TASK_ACTIVE_STATUSES.has(task.status)),
          )
          .sort(
            (left, right) =>
              right.updated_at - left.updated_at ||
              left.delivery_task_id.localeCompare(right.delivery_task_id),
          )
          .slice(0, filter.limit),
      );
    },
    async canExecuteOrderTransition(orgId, storeId, deliveryOrderId, leg, staffId) {
      const task = activeTask(rows, orgId, storeId, deliveryOrderId, leg);
      return task?.status === "accepted" && task.assignee_staff_id === staffId;
    },
    async settleOrderTransition(input) {
      const targets = scoped(rows, input.orgId, input.storeId)
        .map(({ task }) => task)
        .filter(
          (task) =>
            task.delivery_order_id === input.deliveryOrder.delivery_order_id &&
            DELIVERY_TASK_ACTIVE_STATUSES.has(task.status) &&
            (input.deliveryOrder.status === "cancelled" ||
              (input.previousStatus === "pickup_in_progress" &&
                input.deliveryOrder.status === "picked_up" &&
                task.leg === "pickup") ||
              (input.previousStatus === "return_in_progress" &&
                input.deliveryOrder.status === "completed" &&
                task.leg === "return")),
        );
      for (const task of targets) {
        const status = input.deliveryOrder.status === "cancelled" ? "cancelled" : "completed";
        rows = setTask(
          rows,
          input.orgId,
          input.storeId,
          resolvedTask(task, status, {
            operation: "respond",
            org_id: input.orgId,
            store_id: input.storeId,
            staff_id: input.staffId,
            delivery_order_id: task.delivery_order_id,
            leg: task.leg,
            delivery_task_id: task.delivery_task_id,
            expected_version: task.version,
            expected_delivery_order_version: input.deliveryOrder.version,
            decision: "accept",
            resolution_reason: null,
            at: input.at,
          }),
        );
      }
    },
  });
}
