import {
  DeliveryTaskConfirmationSummarySchema,
  DeliveryTaskSchema,
  type DeliveryOrder,
  type DeliveryTask,
  type DeliveryTaskConfirmationSummary,
  type DeliveryTaskLeg,
  type DeliveryTaskResolutionReason,
  type DeliveryTasksListInput,
} from "@laundry/contracts";

export type DeliveryTaskOperation = "assign" | "respond" | "transfer" | "takeover";

type RequestScope = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
}>;

export type DeliveryTaskAssignRequest = RequestScope &
  Readonly<{
    operation: "assign";
    delivery_task_id: string;
    delivery_order_id: string;
    leg: DeliveryTaskLeg;
    expected_delivery_order_version: number;
    assignee_staff_id: string;
    at: number;
  }>;

export type DeliveryTaskRespondRequest = RequestScope &
  Readonly<{
    operation: "respond";
    delivery_order_id: string;
    leg: DeliveryTaskLeg;
    delivery_task_id: string;
    expected_version: number;
    expected_delivery_order_version: number;
    decision: "accept" | "reject";
    resolution_reason: DeliveryTaskResolutionReason | null;
    at: number;
  }>;

export type DeliveryTaskTransferRequest = RequestScope &
  Readonly<{
    operation: "transfer";
    delivery_order_id: string;
    leg: DeliveryTaskLeg;
    delivery_task_id: string;
    successor_task_id: string;
    expected_version: number;
    expected_delivery_order_version: number;
    target_staff_id: string;
    resolution_reason: DeliveryTaskResolutionReason;
    at: number;
  }>;

export type DeliveryTaskTakeoverRequest = RequestScope &
  Readonly<{
    operation: "takeover";
    delivery_order_id: string;
    leg: DeliveryTaskLeg;
    delivery_task_id: string;
    successor_task_id: string;
    expected_version: number;
    expected_delivery_order_version: number;
    resolution_reason: DeliveryTaskResolutionReason;
    at: number;
  }>;

export type DeliveryTaskMutationRequest =
  | DeliveryTaskAssignRequest
  | DeliveryTaskRespondRequest
  | DeliveryTaskTransferRequest
  | DeliveryTaskTakeoverRequest;

export type DeliveryTaskPrepareRequest =
  | Omit<DeliveryTaskAssignRequest, "delivery_task_id" | "at">
  | Omit<DeliveryTaskRespondRequest, "expected_delivery_order_version" | "at">
  | Omit<
      DeliveryTaskTransferRequest,
      "successor_task_id" | "expected_delivery_order_version" | "at"
    >
  | Omit<
      DeliveryTaskTakeoverRequest,
      "successor_task_id" | "expected_delivery_order_version" | "at"
    >;

export type DeliveryTaskMutationFailure =
  "assignee_invalid" | "duplicate" | "not_found" | "state_conflict";

export type DeliveryTaskMutationResult =
  | Readonly<{
      ok: true;
      delivery_task: DeliveryTask;
      previous_task: DeliveryTask | null;
      before: DeliveryTask | null;
    }>
  | Readonly<{ ok: false; reason: DeliveryTaskMutationFailure }>;

export type DeliveryTaskListFilter = Readonly<
  Omit<DeliveryTasksListInput, "limit"> & { limit: number }
>;

export type DeliveryTaskStore = Readonly<{
  prepare: (request: DeliveryTaskPrepareRequest) => Promise<DeliveryTaskConfirmationSummary | null>;
  mutate: (request: DeliveryTaskMutationRequest) => Promise<DeliveryTaskMutationResult>;
  get: (orgId: string, storeId: string, deliveryTaskId: string) => Promise<DeliveryTask | null>;
  list: (
    orgId: string,
    storeId: string,
    filter: DeliveryTaskListFilter,
  ) => Promise<readonly DeliveryTask[]>;
  canExecuteOrderTransition: (
    orgId: string,
    storeId: string,
    deliveryOrderId: string,
    leg: DeliveryTaskLeg,
    staffId: string,
  ) => Promise<boolean>;
  settleOrderTransition: (
    input: Readonly<{
      orgId: string;
      storeId: string;
      deliveryOrder: DeliveryOrder;
      previousStatus: DeliveryOrder["status"];
      staffId: string;
      at: number;
    }>,
  ) => Promise<void>;
}>;

const terminalTimestamps = [
  "rejected_at",
  "transferred_at",
  "taken_over_at",
  "completed_at",
  "cancelled_at",
] as const;

export function freezeDeliveryTask(input: DeliveryTask): DeliveryTask {
  const row = DeliveryTaskSchema.parse(input);
  if (
    row.updated_at < row.created_at ||
    [
      row.accepted_at,
      row.rejected_at,
      row.transferred_at,
      row.taken_over_at,
      row.completed_at,
      row.cancelled_at,
    ].some((value) => value !== null && (value < row.created_at || value > row.updated_at))
  ) {
    throw new TypeError("Invalid delivery task time");
  }
  const expected = `${row.status}_at`;
  for (const field of terminalTimestamps) {
    const shouldExist = expected === field;
    if (shouldExist !== (row[field] !== null))
      throw new TypeError("Invalid delivery task terminal time");
  }
  if (
    (["offered", "rejected"].includes(row.status) && row.accepted_at !== null) ||
    (["accepted", "completed"].includes(row.status) && row.accepted_at === null)
  ) {
    throw new TypeError("Invalid delivery task acceptance time");
  }
  const needsReason = ["rejected", "transferred", "taken_over"].includes(row.status);
  if (needsReason !== (row.resolution_reason !== null)) {
    throw new TypeError("Invalid delivery task reason");
  }
  return Object.freeze({ ...row });
}

export function freezeTaskConfirmation(
  input: DeliveryTaskConfirmationSummary,
): DeliveryTaskConfirmationSummary {
  return Object.freeze(DeliveryTaskConfirmationSummarySchema.parse(input));
}

export function createdDeliveryTask(
  input: Readonly<{
    request: DeliveryTaskAssignRequest | DeliveryTaskTransferRequest | DeliveryTaskTakeoverRequest;
    source: DeliveryTask["source"];
    status: "offered" | "accepted";
    assignee_staff_id: string;
    predecessor_task_id: string | null;
  }>,
): DeliveryTask {
  const { request } = input;
  const taskId =
    request.operation === "assign" ? request.delivery_task_id : request.successor_task_id;
  return freezeDeliveryTask({
    delivery_task_id: taskId,
    delivery_order_id: request.delivery_order_id,
    leg: request.leg,
    assignee_staff_id: input.assignee_staff_id,
    assigned_by_staff_id: request.staff_id,
    predecessor_task_id: input.predecessor_task_id,
    source: input.source,
    status: input.status,
    version: 1,
    created_at: request.at,
    updated_at: request.at,
    accepted_at: input.status === "accepted" ? request.at : null,
    rejected_at: null,
    transferred_at: null,
    taken_over_at: null,
    completed_at: null,
    cancelled_at: null,
    resolution_reason: null,
  });
}
