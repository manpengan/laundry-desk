import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const LocalTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

const minutesSinceMidnight = (value: string): number => {
  const [hours = "", minutes = ""] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
};

export const AutomationToolSchema = z.literal("notification.delivery_batch.enqueue");
export const AutomationPolicyStatusSchema = z.enum([
  "pending_approval",
  "active",
  "paused",
  "quota_paused",
  "archived",
]);
export const AutomationRunOutcomeSchema = z.enum(["executed", "failed", "skipped", "denied"]);

export const AutomationObjectFilterSchema = z.strictObject({
  min_age_days: z.union([z.literal(30), z.literal(90), z.literal(180)]),
  unpaid_only: z.boolean(),
  garment_statuses: z
    .array(z.enum(["ready", "racked"]))
    .min(1)
    .max(2)
    .refine((values) => new Set(values).size === values.length, {
      message: "garment statuses must be unique",
    })
    .readonly(),
  max_objects: PositiveSafeIntegerSchema.max(10),
});

export const AutomationScheduleSchema = z
  .strictObject({
    cadence: z.literal("daily"),
    local_time: LocalTimeSchema,
    days_of_week: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine(
        (values) =>
          new Set(values).size === values.length &&
          values.every((value, index) => index === 0 || value > values[index - 1]!),
        { message: "days_of_week must be unique and sorted" },
      )
      .readonly(),
    window_start_local: LocalTimeSchema,
    window_end_local: LocalTimeSchema,
  })
  .superRefine((value, context) => {
    const start = minutesSinceMidnight(value.window_start_local);
    const end = minutesSinceMidnight(value.window_end_local);
    const scheduled = minutesSinceMidnight(value.local_time);
    if (start >= end) {
      context.addIssue({
        code: "custom",
        path: ["window_end_local"],
        message: "automation windows may not cross midnight",
      });
    }
    if (scheduled < start || scheduled >= end) {
      context.addIssue({
        code: "custom",
        path: ["local_time"],
        message: "scheduled time must be inside the allowed window",
      });
    }
  });

export const AutomationLimitsSchema = z.strictObject({
  max_runs_per_day: PositiveSafeIntegerSchema.max(24),
  max_amount_cents: NonNegativeSafeIntegerSchema.max(100_000),
});

export const AutomationPolicyDraftSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(128),
    tool: AutomationToolSchema,
    object_filter: AutomationObjectFilterSchema,
    schedule: AutomationScheduleSchema,
    limits: AutomationLimitsSchema,
    valid_from: ExactUtcTimestampSchema,
    valid_until: ExactUtcTimestampSchema.nullable(),
    reason: z.string().trim().min(1).max(256),
  })
  .superRefine((value, context) => {
    if (value.valid_until !== null && value.valid_until <= value.valid_from) {
      context.addIssue({
        code: "custom",
        path: ["valid_until"],
        message: "valid_until must be later than valid_from",
      });
    }
  });

export const AutomationPolicyCreateInputSchema = AutomationPolicyDraftSchema;
export const AutomationPolicyUpdateInputSchema = AutomationPolicyDraftSchema.extend({
  policy_id: z.uuid(),
  expected_version: PositiveSafeIntegerSchema,
}).strict();

const PolicyTransitionBaseSchema = z.strictObject({
  policy_id: z.uuid(),
  expected_version: PositiveSafeIntegerSchema,
  reason: z.string().trim().min(1).max(256),
});

export const AutomationPolicyApproveInputSchema = PolicyTransitionBaseSchema;
export const AutomationPolicyPauseInputSchema = PolicyTransitionBaseSchema;
export const AutomationPolicyResumeInputSchema = PolicyTransitionBaseSchema;
export const AutomationPolicyArchiveInputSchema = PolicyTransitionBaseSchema;

export const AutomationPolicyListInputSchema = z.strictObject({
  status: AutomationPolicyStatusSchema.optional(),
  limit: PositiveSafeIntegerSchema.max(50).optional(),
});
export const AutomationPolicyGetInputSchema = z.strictObject({ policy_id: z.uuid() });
export const AutomationRunListInputSchema = z.strictObject({
  policy_id: z.uuid(),
  limit: PositiveSafeIntegerSchema.max(100).optional(),
});

export const AutomationPolicySchema = z.strictObject({
  policy_id: z.uuid(),
  store_id: z.uuid(),
  name: z.string().min(1).max(128),
  tool: AutomationToolSchema,
  tool_version: z.literal("0.1.0"),
  object_filter: AutomationObjectFilterSchema,
  schedule: AutomationScheduleSchema,
  limits: AutomationLimitsSchema,
  status: AutomationPolicyStatusSchema,
  row_version: PositiveSafeIntegerSchema,
  valid_from: ExactUtcTimestampSchema,
  valid_until: ExactUtcTimestampSchema.nullable(),
  approved_by_staff_id: z.uuid().nullable(),
  approved_at: ExactUtcTimestampSchema.nullable(),
  next_run_at: ExactUtcTimestampSchema.nullable(),
  last_run_at: ExactUtcTimestampSchema.nullable(),
  last_outcome: AutomationRunOutcomeSchema.nullable(),
  consecutive_failures: NonNegativeSafeIntegerSchema.max(3),
  created_at: ExactUtcTimestampSchema,
  updated_at: ExactUtcTimestampSchema,
});

export const AutomationRunSchema = z.strictObject({
  run_id: z.uuid(),
  policy_id: z.uuid(),
  tool: AutomationToolSchema,
  decision: z.literal("policy"),
  outcome: AutomationRunOutcomeSchema,
  args_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  object_count: NonNegativeSafeIntegerSchema.max(10),
  amount_cents: NonNegativeSafeIntegerSchema.max(100_000),
  error_code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
    .nullable(),
  started_at: ExactUtcTimestampSchema,
  completed_at: ExactUtcTimestampSchema,
});

export const AutomationPolicyMutationResultSchema = z.strictObject({
  policy: AutomationPolicySchema,
});
export const AutomationPolicyListResultSchema = z.strictObject({
  policies: z.array(AutomationPolicySchema).max(50),
});
export const AutomationPolicyGetResultSchema = z.strictObject({
  policy: AutomationPolicySchema,
});
export const AutomationRunListResultSchema = z.strictObject({
  runs: z.array(AutomationRunSchema).max(100),
});

export type AutomationPolicyDraft = z.output<typeof AutomationPolicyDraftSchema>;
export type AutomationPolicy = z.output<typeof AutomationPolicySchema>;
export type AutomationRun = z.output<typeof AutomationRunSchema>;
