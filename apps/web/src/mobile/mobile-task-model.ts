import type {
  DeliveryOrder,
  DeliveryOrderCancellationReason,
  DeliveryOrderStatus,
  DeliveryTask,
  DeliveryTaskConfirmationSummary,
  DeliveryTaskRespondInput,
  DeliveryTaskStatus,
} from "@laundry/contracts";

import {
  buildDeliveryOrderTransition,
  parseDeliveryOrder,
  type DeliveryOrderView,
} from "../pages/delivery-order-model.js";
import { parseDeliveryTasks, type DeliveryTaskView } from "../pages/delivery-task-model.js";

export type MobileTaskDetail = Readonly<{
  task: DeliveryTaskView;
  order: DeliveryOrderView;
}>;

export type MobileTaskExecutionAction = Readonly<{
  targetStatus: DeliveryOrderStatus;
  label: string;
  hint: string;
}>;

/** Client-frozen authority used only because the existing order transition has no typed summary. */
export type MobileTaskTransitionAuthority = Readonly<{
  deliveryTaskId: string;
  deliveryTaskVersion: number;
  taskStatus: DeliveryTaskStatus;
  leg: DeliveryTask["leg"];
  deliveryOrderId: string;
  laundryOrderId: string;
  deliveryOrderVersion: number;
  currentStatus: DeliveryOrderStatus;
  targetStatus: DeliveryOrderStatus;
  collectionMethod: DeliveryOrder["collection_method"];
  returnMethod: DeliveryOrder["return_method"];
  cancellationReason: DeliveryOrderCancellationReason | null;
  /** Exact strict-contract snapshots; never rendered or persisted. */
  taskSnapshotKey: string;
  orderSnapshotKey: string;
}>;

const EXECUTION_ACTIONS: Readonly<
  Partial<
    Record<DeliveryTask["leg"], Partial<Record<DeliveryOrderStatus, MobileTaskExecutionAction>>>
  >
> = Object.freeze({
  pickup: Object.freeze({
    pickup_scheduled: Object.freeze({
      targetStatus: "pickup_in_progress",
      label: "开始上门取件",
      hint: "仅记录配送状态，不采集定位或现场证据。",
    }),
  }),
  return: Object.freeze({
    return_scheduled: Object.freeze({
      targetStatus: "return_in_progress",
      label: "开始送回",
      hint: "仅记录配送状态，不采集定位或现场证据。",
    }),
  }),
});

export function parseMyDeliveryTasks(
  value: unknown,
  currentStaffId: string,
): readonly DeliveryTaskView[] | null {
  const tasks = parseDeliveryTasks(value);
  if (tasks === null || tasks.some((task) => task.assignee_staff_id !== currentStaffId)) {
    return null;
  }
  return Object.freeze(
    [...tasks]
      .sort((left, right) => right.updated_at - left.updated_at)
      .map((task) => Object.freeze({ ...task })),
  );
}

export function parseMobileTaskDetail(
  taskValue: unknown,
  orderValue: unknown,
  expected: Readonly<{
    taskId: string;
    orderId: string;
    currentStaffId: string;
  }>,
): MobileTaskDetail | null {
  const tasks = parseDeliveryTasks({ delivery_tasks: [unwrapTask(taskValue)] });
  const task = tasks?.[0] ?? null;
  const order = parseDeliveryOrder(orderValue);
  if (
    task === null ||
    order === null ||
    task.delivery_task_id !== expected.taskId ||
    task.delivery_order_id !== expected.orderId ||
    task.assignee_staff_id !== expected.currentStaffId ||
    order.delivery_order_id !== task.delivery_order_id
  ) {
    return null;
  }
  return Object.freeze({ task, order });
}

function unwrapTask(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const outer = value as Readonly<Record<string, unknown>>;
  const result = "result" in outer ? outer.result : value;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  return (result as Readonly<Record<string, unknown>>).delivery_task;
}

export function mobileTaskExecutionAction(
  detail: MobileTaskDetail | null,
): MobileTaskExecutionAction | null {
  if (detail === null || detail.task.status !== "accepted") return null;
  return EXECUTION_ACTIONS[detail.task.leg]?.[detail.order.status] ?? null;
}

export function buildMobileTaskOrderTransition(
  detail: MobileTaskDetail,
  action: MobileTaskExecutionAction,
) {
  return buildDeliveryOrderTransition(detail.order, action.targetStatus);
}

function sameTransitionBody(
  left: NonNullable<ReturnType<typeof buildMobileTaskOrderTransition>>,
  right: NonNullable<ReturnType<typeof buildMobileTaskOrderTransition>>,
): boolean {
  return (
    left.delivery_order_id === right.delivery_order_id &&
    left.customer_id === right.customer_id &&
    left.expected_version === right.expected_version &&
    left.target_status === right.target_status &&
    (left.cancellation_reason ?? null) === (right.cancellation_reason ?? null)
  );
}

export function buildMobileTaskTransitionAuthority(
  detail: MobileTaskDetail,
  action: MobileTaskExecutionAction,
  body: NonNullable<ReturnType<typeof buildMobileTaskOrderTransition>>,
): MobileTaskTransitionAuthority | null {
  const currentAction = mobileTaskExecutionAction(detail);
  const rebuilt =
    currentAction === null ? null : buildMobileTaskOrderTransition(detail, currentAction);
  if (
    currentAction === null ||
    currentAction.targetStatus !== action.targetStatus ||
    rebuilt === null ||
    !sameTransitionBody(rebuilt, body)
  ) {
    return null;
  }
  return Object.freeze({
    deliveryTaskId: detail.task.delivery_task_id,
    deliveryTaskVersion: detail.task.version,
    taskStatus: detail.task.status,
    leg: detail.task.leg,
    deliveryOrderId: detail.order.delivery_order_id,
    laundryOrderId: detail.order.laundry_order_id,
    deliveryOrderVersion: detail.order.version,
    currentStatus: detail.order.status,
    targetStatus: action.targetStatus,
    collectionMethod: detail.order.collection_method,
    returnMethod: detail.order.return_method,
    cancellationReason: body.cancellation_reason ?? null,
    taskSnapshotKey: JSON.stringify(detail.task),
    orderSnapshotKey: JSON.stringify(detail.order),
  });
}

export function mobileTaskTransitionAuthorityKey(
  scope: string,
  body: NonNullable<ReturnType<typeof buildMobileTaskOrderTransition>>,
  authority: MobileTaskTransitionAuthority,
): string {
  return JSON.stringify([
    scope,
    body.delivery_order_id,
    body.customer_id,
    body.expected_version,
    body.target_status,
    body.cancellation_reason ?? null,
    authority.deliveryTaskId,
    authority.deliveryTaskVersion,
    authority.taskStatus,
    authority.leg,
    authority.deliveryOrderId,
    authority.laundryOrderId,
    authority.deliveryOrderVersion,
    authority.currentStatus,
    authority.targetStatus,
    authority.collectionMethod,
    authority.returnMethod,
    authority.cancellationReason,
    authority.taskSnapshotKey,
    authority.orderSnapshotKey,
  ]);
}

export function mobileTaskTransitionStillMatches(
  scope: string,
  detail: MobileTaskDetail | null,
  body: NonNullable<ReturnType<typeof buildMobileTaskOrderTransition>>,
  authority: MobileTaskTransitionAuthority,
  authorityKey: string,
): detail is MobileTaskDetail {
  if (detail === null) return false;
  const action = mobileTaskExecutionAction(detail);
  if (action === null) return false;
  const rebuiltBody = buildMobileTaskOrderTransition(detail, action);
  if (rebuiltBody === null) return false;
  const rebuiltAuthority = buildMobileTaskTransitionAuthority(detail, action, rebuiltBody);
  return (
    rebuiltAuthority !== null &&
    sameTransitionBody(rebuiltBody, body) &&
    authorityKey === mobileTaskTransitionAuthorityKey(scope, body, authority) &&
    authorityKey === mobileTaskTransitionAuthorityKey(scope, rebuiltBody, rebuiltAuthority)
  );
}

export function mobileTaskResponseSummaryMatches(
  detail: MobileTaskDetail,
  currentStaffId: string,
  body: DeliveryTaskRespondInput,
  summary: DeliveryTaskConfirmationSummary,
): boolean {
  return (
    summary.operation === "respond" &&
    summary.delivery_order_id === detail.order.delivery_order_id &&
    summary.delivery_order_version === detail.order.version &&
    summary.leg === detail.task.leg &&
    summary.delivery_task_id === detail.task.delivery_task_id &&
    summary.delivery_task_version === detail.task.version &&
    summary.current_status === detail.task.status &&
    summary.from_assignee_staff_id === currentStaffId &&
    summary.to_assignee_staff_id === currentStaffId &&
    summary.decision === body.decision &&
    summary.resolution_reason === (body.resolution_reason ?? null)
  );
}

export function mobileTaskResponseResultMatches(
  updated: DeliveryTaskView,
  detail: MobileTaskDetail,
  currentStaffId: string,
  body: DeliveryTaskRespondInput,
): boolean {
  const expectedStatus = body.decision === "accept" ? "accepted" : "rejected";
  const before = detail.task;
  return (
    updated.delivery_task_id === before.delivery_task_id &&
    updated.delivery_order_id === before.delivery_order_id &&
    updated.leg === before.leg &&
    updated.assignee_staff_id === currentStaffId &&
    updated.assigned_by_staff_id === before.assigned_by_staff_id &&
    updated.predecessor_task_id === before.predecessor_task_id &&
    updated.source === before.source &&
    updated.created_at === before.created_at &&
    updated.updated_at >= before.updated_at &&
    updated.version === before.version + 1 &&
    updated.status === expectedStatus &&
    updated.resolution_reason === (body.resolution_reason ?? null) &&
    (body.decision === "accept"
      ? updated.accepted_at !== null && updated.rejected_at === before.rejected_at
      : updated.rejected_at !== null && updated.accepted_at === before.accepted_at) &&
    updated.transferred_at === before.transferred_at &&
    updated.taken_over_at === before.taken_over_at &&
    updated.completed_at === before.completed_at &&
    updated.cancelled_at === before.cancelled_at
  );
}

export function mobileTaskTransitionResultMatches(
  updated: DeliveryOrderView,
  detail: MobileTaskDetail,
  body: NonNullable<ReturnType<typeof buildMobileTaskOrderTransition>>,
): boolean {
  const before = detail.order;
  return (
    updated.delivery_order_id === before.delivery_order_id &&
    updated.laundry_order_id === before.laundry_order_id &&
    updated.customer_id === body.customer_id &&
    updated.collection_method === before.collection_method &&
    updated.return_method === before.return_method &&
    updated.pickup_appointment_id === before.pickup_appointment_id &&
    updated.return_appointment_id === before.return_appointment_id &&
    updated.pickup_fee_cents === before.pickup_fee_cents &&
    updated.return_fee_cents === before.return_fee_cents &&
    updated.total_fee_cents === before.total_fee_cents &&
    updated.created_at === before.created_at &&
    updated.updated_at >= before.updated_at &&
    updated.version === body.expected_version + 1 &&
    updated.status === body.target_status &&
    updated.cancellation_reason === (body.cancellation_reason ?? null) &&
    (body.target_status === "completed"
      ? updated.completed_at !== null
      : updated.completed_at === before.completed_at) &&
    updated.cancelled_at === before.cancelled_at
  );
}

export function mobileTaskDetailStillMatches(
  detail: MobileTaskDetail | null,
  expected: Readonly<{
    taskId: string;
    taskVersion: number;
    taskStatus: DeliveryTaskStatus;
    orderId: string;
    orderVersion: number;
  }>,
): detail is MobileTaskDetail {
  return (
    detail !== null &&
    detail.task.delivery_task_id === expected.taskId &&
    detail.task.version === expected.taskVersion &&
    detail.task.status === expected.taskStatus &&
    detail.order.delivery_order_id === expected.orderId &&
    detail.order.version === expected.orderVersion
  );
}

export function mobileTaskAvailabilityCopy(
  task: DeliveryTask,
  order: DeliveryOrder | null,
): string {
  if (task.status === "offered") return "请先接受或拒绝任务。";
  if (task.status === "accepted") {
    if (order === null) return "正在读取订单可执行状态…";
    return mobileTaskExecutionAction({ task, order }) === null
      ? "订单当前不在此任务的可执行节点，请刷新或等待门店准备。"
      : "当前任务可在线执行下一步。";
  }
  const terminalCopy: Readonly<
    Record<Exclude<DeliveryTaskStatus, "offered" | "accepted">, string>
  > = Object.freeze({
    rejected: "该任务已拒绝，不可继续执行。",
    transferred: "该任务已转派给其他员工。",
    taken_over: "该任务已由管理员接管。",
    completed: "该任务已完成。",
    cancelled: "该任务已取消。",
  });
  return terminalCopy[task.status] ?? "任务状态已变化，请刷新。";
}
