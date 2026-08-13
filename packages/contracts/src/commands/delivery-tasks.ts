import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_EPOCH_SECONDS = 4_294_967_295;
const VersionSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const EpochSchema = z.number().int().nonnegative().max(MAX_EPOCH_SECONDS);

export const DeliveryTaskLegSchema = z.enum(["pickup", "return"]);
export const DeliveryTaskStatusSchema = z.enum([
  "offered",
  "accepted",
  "rejected",
  "transferred",
  "taken_over",
  "completed",
  "cancelled",
]);
export const DeliveryTaskSourceSchema = z.enum(["assignment", "transfer", "takeover"]);
export const DeliveryTaskResolutionReasonSchema = z.enum([
  "unavailable",
  "capacity",
  "shift_end",
  "route_conflict",
  "emergency",
  "other",
]);

export const DeliveryTaskSchema = z.strictObject({
  delivery_task_id: z.uuid(),
  delivery_order_id: z.uuid(),
  leg: DeliveryTaskLegSchema,
  assignee_staff_id: z.uuid(),
  assigned_by_staff_id: z.uuid(),
  predecessor_task_id: z.uuid().nullable(),
  source: DeliveryTaskSourceSchema,
  status: DeliveryTaskStatusSchema,
  version: VersionSchema,
  created_at: EpochSchema,
  updated_at: EpochSchema,
  accepted_at: EpochSchema.nullable(),
  rejected_at: EpochSchema.nullable(),
  transferred_at: EpochSchema.nullable(),
  taken_over_at: EpochSchema.nullable(),
  completed_at: EpochSchema.nullable(),
  cancelled_at: EpochSchema.nullable(),
  resolution_reason: DeliveryTaskResolutionReasonSchema.nullable(),
});

export const DeliveryTaskAssignInputSchema = z.strictObject({
  delivery_order_id: z.uuid(),
  leg: DeliveryTaskLegSchema,
  expected_delivery_order_version: VersionSchema,
  assignee_staff_id: z.uuid(),
});

export const DeliveryTaskRespondInputSchema = z
  .strictObject({
    delivery_order_id: z.uuid(),
    leg: DeliveryTaskLegSchema,
    delivery_task_id: z.uuid(),
    expected_version: VersionSchema,
    decision: z.enum(["accept", "reject"]),
    resolution_reason: DeliveryTaskResolutionReasonSchema.optional(),
  })
  .superRefine((input, context) => {
    if ((input.decision === "reject") !== (input.resolution_reason !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["resolution_reason"],
        message: "Only a rejection requires one controlled reason",
      });
    }
  });

const ReassignmentInputSchema = z.strictObject({
  delivery_order_id: z.uuid(),
  leg: DeliveryTaskLegSchema,
  delivery_task_id: z.uuid(),
  expected_version: VersionSchema,
  resolution_reason: DeliveryTaskResolutionReasonSchema,
});

export const DeliveryTaskTransferInputSchema = ReassignmentInputSchema.extend({
  target_staff_id: z.uuid(),
});

export const DeliveryTaskTakeoverInputSchema = ReassignmentInputSchema;

export const DeliveryTaskGetInputSchema = z.strictObject({ delivery_task_id: z.uuid() });
export const DeliveryTasksListInputSchema = z.strictObject({
  delivery_order_id: z.uuid().optional(),
  leg: DeliveryTaskLegSchema.optional(),
  assignee_staff_id: z.uuid().optional(),
  status: DeliveryTaskStatusSchema.optional(),
  active_only: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export const DeliveryTaskMutationResultSchema = z.strictObject({
  delivery_task: DeliveryTaskSchema,
  previous_task: DeliveryTaskSchema.nullable(),
});
export const DeliveryTaskGetResultSchema = z.strictObject({ delivery_task: DeliveryTaskSchema });
export const DeliveryTasksListResultSchema = z.strictObject({
  delivery_tasks: z.array(DeliveryTaskSchema).max(100),
});

const taskResultRedaction = Object.freeze([
  { path: "/delivery_task/assignee_staff_id", strategy: "mask" as const },
  { path: "/previous_task/assignee_staff_id", strategy: "mask" as const },
]);

function taskCommand<T extends z.ZodObject>(definition: {
  name: string;
  description: string;
  description_llm: string;
  input: T;
  risk: "R3" | "R4";
  invariants: readonly string[];
  sideEffects: readonly string[];
  input_redaction?: readonly { path: string; strategy: "mask" | "remove" }[];
}): CommandDefinition<T> {
  return defineCommand({
    ...definition,
    version: "1.0.0",
    idempotent: true,
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: definition.input_redaction ?? [],
    result_redaction: taskResultRedaction,
  });
}

export const deliveryTaskAssignCommand = taskCommand({
  name: "delivery.task.assign",
  description: "Offer one current delivery-order leg to an active current-store employee.",
  description_llm: "Internal online assignment with server-bound order, leg and staff authority.",
  input: DeliveryTaskAssignInputSchema,
  input_redaction: [{ path: "/assignee_staff_id", strategy: "mask" }],
  risk: "R3",
  invariants: ["rbac.delivery_assign", "delivery.task_leg", "delivery.task_assignee"],
  sideEffects: ["delivery.task.assigned", "audit.delivery_task_event"],
});

export const deliveryTaskRespondCommand = taskCommand({
  name: "delivery.task.respond",
  description: "Accept or reject an offered delivery task as its assigned employee.",
  description_llm: "Internal online assignee decision with optimistic task authority.",
  input: DeliveryTaskRespondInputSchema,
  risk: "R3",
  invariants: ["rbac.delivery_write", "delivery.task_assignee", "delivery.task_version"],
  sideEffects: ["delivery.task.responded", "audit.delivery_task_event"],
});

export const deliveryTaskTransferCommand = taskCommand({
  name: "delivery.task.transfer",
  description: "End one assigned task and offer a linked successor to another active employee.",
  description_llm: "Internal online transfer. The old task remains immutable history.",
  input: DeliveryTaskTransferInputSchema,
  input_redaction: [{ path: "/target_staff_id", strategy: "mask" }],
  risk: "R3",
  invariants: ["rbac.delivery_assign", "delivery.task_assignee", "delivery.task_successor"],
  sideEffects: ["delivery.task.transferred", "delivery.task.assigned", "audit.delivery_task_event"],
});

export const deliveryTaskTakeoverCommand = taskCommand({
  name: "delivery.task.takeover",
  description: "Manually take over one active task while preserving its predecessor.",
  description_llm: "R4 administrative custody change requiring another active administrator.",
  input: DeliveryTaskTakeoverInputSchema,
  risk: "R4",
  invariants: ["rbac.delivery_takeover", "delivery.task_active", "delivery.task_successor"],
  sideEffects: ["delivery.task.taken_over", "delivery.task.accepted", "audit.delivery_task_event"],
});

function taskQuery<T extends z.ZodObject>(definition: {
  name: string;
  description: string;
  input: T;
  max_result_rows: number;
  result_redaction: readonly { path: string; strategy: "mask" | "remove" }[];
  input_redaction?: readonly { path: string; strategy: "mask" | "remove" }[];
}): QueryDefinition<T> {
  return defineQuery({
    ...definition,
    version: "1.0.0",
    description_llm: "PII-linked internal logistics assignment record. Never exposed to AI tools.",
    risk: "R2",
    invariants: ["rbac.delivery_read"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: definition.input_redaction ?? [],
  });
}

export const deliveryTaskGetQuery = taskQuery({
  name: "delivery.task.get",
  description: "Read one current-store delivery task.",
  input: DeliveryTaskGetInputSchema,
  result_redaction: [{ path: "/delivery_task/assignee_staff_id", strategy: "mask" }],
  max_result_rows: 1,
});

export const deliveryTasksListQuery = taskQuery({
  name: "delivery.tasks.list",
  description: "List a bounded current-store delivery task worklist and assignment history.",
  input: DeliveryTasksListInputSchema,
  input_redaction: [{ path: "/assignee_staff_id", strategy: "mask" }],
  result_redaction: [{ path: "/delivery_tasks", strategy: "remove" }],
  max_result_rows: 100,
});

export const DELIVERY_TASK_COMMANDS = Object.freeze([
  deliveryTaskAssignCommand,
  deliveryTaskRespondCommand,
  deliveryTaskTransferCommand,
  deliveryTaskTakeoverCommand,
] as const);
export const DELIVERY_TASK_QUERIES = Object.freeze([
  deliveryTaskGetQuery,
  deliveryTasksListQuery,
] as const);
export const DELIVERY_TASK_COMMAND_NAMES = Object.freeze(
  DELIVERY_TASK_COMMANDS.map(({ name }) => name),
);
export const DELIVERY_TASK_QUERY_NAMES = Object.freeze(
  DELIVERY_TASK_QUERIES.map(({ name }) => name),
);

export type DeliveryTask = z.infer<typeof DeliveryTaskSchema>;
export type DeliveryTaskLeg = z.infer<typeof DeliveryTaskLegSchema>;
export type DeliveryTaskStatus = z.infer<typeof DeliveryTaskStatusSchema>;
export type DeliveryTaskResolutionReason = z.infer<typeof DeliveryTaskResolutionReasonSchema>;
export type DeliveryTaskAssignInput = z.infer<typeof DeliveryTaskAssignInputSchema>;
export type DeliveryTaskRespondInput = z.infer<typeof DeliveryTaskRespondInputSchema>;
export type DeliveryTaskTransferInput = z.infer<typeof DeliveryTaskTransferInputSchema>;
export type DeliveryTaskTakeoverInput = z.infer<typeof DeliveryTaskTakeoverInputSchema>;
export type DeliveryTasksListInput = z.infer<typeof DeliveryTasksListInputSchema>;
