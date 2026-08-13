import {
  DeliveryTaskAssignInputSchema,
  DeliveryTaskMutationResultSchema,
  DeliveryTaskRespondInputSchema,
  DeliveryTasksListInputSchema,
  DeliveryTasksListResultSchema,
  DeliveryTaskTakeoverInputSchema,
  DeliveryTaskTransferInputSchema,
  type DeliveryOrder,
  type DeliveryTask,
  type DeliveryTaskAssignInput,
  type DeliveryTaskConfirmationSummary,
  type DeliveryTaskLeg,
  type DeliveryTaskResolutionReason,
  type DeliveryTaskRespondInput,
  type DeliveryTasksListInput,
  type DeliveryTaskStatus,
  type DeliveryTaskTakeoverInput,
  type DeliveryTaskTransferInput,
} from "@laundry/contracts";

export type DeliveryTaskView = Readonly<DeliveryTask>;
export type DeliveryTaskCommand =
  | "delivery.task.assign"
  | "delivery.task.respond"
  | "delivery.task.transfer"
  | "delivery.task.takeover";
export type DeliveryTaskCommandBody =
  | DeliveryTaskAssignInput
  | DeliveryTaskRespondInput
  | DeliveryTaskTransferInput
  | DeliveryTaskTakeoverInput;
export type DeliveryTaskPendingAction = Readonly<{
  command: DeliveryTaskCommand;
  body: DeliveryTaskCommandBody;
  confirmRef: string;
  kind: "confirm" | "step_up";
  summary: DeliveryTaskConfirmationSummary;
}>;
export type DeliveryTaskCandidate = Readonly<{
  key: string;
  delivery_order_id: string;
  leg: DeliveryTaskLeg;
  order_version: number;
}>;

export const DELIVERY_TASK_STATUS_LABELS: Readonly<Record<DeliveryTaskStatus, string>> =
  Object.freeze({
    offered: "待接单",
    accepted: "已接单",
    rejected: "已拒绝",
    transferred: "已转派",
    taken_over: "已接管",
    completed: "已完成",
    cancelled: "已取消",
  });
export const DELIVERY_TASK_LEG_LABELS: Readonly<Record<DeliveryTaskLeg, string>> = Object.freeze({
  pickup: "上门取件",
  return: "送回到家",
});
export const DELIVERY_TASK_REASON_LABELS: Readonly<Record<DeliveryTaskResolutionReason, string>> =
  Object.freeze({
    unavailable: "当前无法执行",
    capacity: "运力不足",
    shift_end: "班次结束",
    route_conflict: "路线冲突",
    emergency: "紧急接管",
    other: "其他受控原因",
  });

function unwrapBusResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  return "result" in record ? record.result : value;
}

export function parseDeliveryTasks(value: unknown): readonly DeliveryTaskView[] | null {
  const parsed = DeliveryTasksListResultSchema.safeParse(unwrapBusResult(value));
  return parsed.success
    ? Object.freeze(parsed.data.delivery_tasks.map((task) => Object.freeze({ ...task })))
    : null;
}

export function parseDeliveryTaskMutation(value: unknown): DeliveryTaskView | null {
  const parsed = DeliveryTaskMutationResultSchema.safeParse(unwrapBusResult(value));
  return parsed.success ? Object.freeze({ ...parsed.data.delivery_task }) : null;
}

export function buildDeliveryTaskListInput(
  assigneeStaffId: string | null,
  activeOnly = true,
): DeliveryTasksListInput | null {
  const parsed = DeliveryTasksListInputSchema.safeParse({
    ...(assigneeStaffId === null ? {} : { assignee_staff_id: assigneeStaffId }),
    active_only: activeOnly,
    limit: 100,
  });
  return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

export function deliveryTaskCandidates(
  orders: readonly DeliveryOrder[],
): readonly DeliveryTaskCandidate[] {
  return Object.freeze(
    orders.flatMap((order) => {
      const rows: DeliveryTaskCandidate[] = [];
      if (order.collection_method === "pickup" && order.status === "pickup_scheduled") {
        rows.push(
          Object.freeze({
            key: `${order.delivery_order_id}:pickup`,
            delivery_order_id: order.delivery_order_id,
            leg: "pickup",
            order_version: order.version,
          }),
        );
      }
      if (order.return_method === "delivery" && order.status === "return_scheduled") {
        rows.push(
          Object.freeze({
            key: `${order.delivery_order_id}:return`,
            delivery_order_id: order.delivery_order_id,
            leg: "return",
            order_version: order.version,
          }),
        );
      }
      return rows;
    }),
  );
}

export function buildDeliveryTaskAssign(
  candidate: DeliveryTaskCandidate,
  assigneeStaffId: string,
): DeliveryTaskAssignInput | null {
  const parsed = DeliveryTaskAssignInputSchema.safeParse({
    delivery_order_id: candidate.delivery_order_id,
    leg: candidate.leg,
    expected_delivery_order_version: candidate.order_version,
    assignee_staff_id: assigneeStaffId,
  });
  return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

export function buildDeliveryTaskResponse(
  task: DeliveryTaskView,
  decision: "accept" | "reject",
  reason: DeliveryTaskResolutionReason,
): DeliveryTaskRespondInput | null {
  const parsed = DeliveryTaskRespondInputSchema.safeParse({
    delivery_order_id: task.delivery_order_id,
    leg: task.leg,
    delivery_task_id: task.delivery_task_id,
    expected_version: task.version,
    decision,
    ...(decision === "reject" ? { resolution_reason: reason } : {}),
  });
  return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

export function buildDeliveryTaskTransfer(
  task: DeliveryTaskView,
  targetStaffId: string,
  reason: DeliveryTaskResolutionReason,
): DeliveryTaskTransferInput | null {
  const parsed = DeliveryTaskTransferInputSchema.safeParse({
    delivery_order_id: task.delivery_order_id,
    leg: task.leg,
    delivery_task_id: task.delivery_task_id,
    expected_version: task.version,
    target_staff_id: targetStaffId,
    resolution_reason: reason,
  });
  return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

export function buildDeliveryTaskTakeover(
  task: DeliveryTaskView,
  reason: DeliveryTaskResolutionReason,
): DeliveryTaskTakeoverInput | null {
  const parsed = DeliveryTaskTakeoverInputSchema.safeParse({
    delivery_order_id: task.delivery_order_id,
    leg: task.leg,
    delivery_task_id: task.delivery_task_id,
    expected_version: task.version,
    resolution_reason: reason,
  });
  return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

export function deliveryTaskPendingStillMatches(
  pending: DeliveryTaskPendingAction,
  tasks: readonly DeliveryTaskView[],
  candidates: readonly DeliveryTaskCandidate[],
): boolean {
  const summary = pending.summary;
  if (summary.operation === "assign") {
    return candidates.some(
      (candidate) =>
        candidate.delivery_order_id === summary.delivery_order_id &&
        candidate.leg === summary.leg &&
        candidate.order_version === summary.delivery_order_version,
    );
  }
  return tasks.some(
    (task) =>
      task.delivery_task_id === summary.delivery_task_id &&
      task.delivery_order_id === summary.delivery_order_id &&
      task.leg === summary.leg &&
      task.version === summary.delivery_task_version &&
      task.status === summary.current_status &&
      task.assignee_staff_id === summary.from_assignee_staff_id,
  );
}

export function shortDeliveryTaskId(value: string): string {
  return value.slice(0, 8);
}
