import { z } from "zod";

import {
  DeliveryTaskLegSchema,
  DeliveryTaskResolutionReasonSchema,
  DeliveryTaskStatusSchema,
} from "../commands/delivery-tasks.js";

const VersionSchema = z.number().int().positive().max(2_147_483_647);

export const DeliveryTaskConfirmationOperationSchema = z.enum([
  "assign",
  "respond",
  "transfer",
  "takeover",
]);

/** Server-derived WYSIWYS card for one task custody mutation. */
export const DeliveryTaskConfirmationSummarySchema = z
  .object({
    kind: z.literal("delivery_task_operation"),
    operation: DeliveryTaskConfirmationOperationSchema,
    delivery_order_id: z.uuid(),
    delivery_order_version: VersionSchema,
    leg: DeliveryTaskLegSchema,
    delivery_task_id: z.uuid().nullable(),
    delivery_task_version: VersionSchema.nullable(),
    current_status: DeliveryTaskStatusSchema.nullable(),
    from_assignee_staff_id: z.uuid().nullable(),
    to_assignee_staff_id: z.uuid(),
    decision: z.enum(["accept", "reject"]).nullable(),
    resolution_reason: DeliveryTaskResolutionReasonSchema.nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    const isAssign = summary.operation === "assign";
    if (
      isAssign !==
      (summary.delivery_task_id === null &&
        summary.delivery_task_version === null &&
        summary.current_status === null &&
        summary.from_assignee_staff_id === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["delivery_task_id"],
        message: "invalid task snapshot",
      });
    }
    if ((summary.operation === "respond") !== (summary.decision !== null)) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "invalid response decision",
      });
    }
    const reasonRequired =
      summary.operation === "transfer" ||
      summary.operation === "takeover" ||
      summary.decision === "reject";
    if (reasonRequired !== (summary.resolution_reason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["resolution_reason"],
        message: "invalid task resolution reason",
      });
    }
  });

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type DeliveryTaskConfirmationSummary = DeepReadonly<
  z.output<typeof DeliveryTaskConfirmationSummarySchema>
>;
