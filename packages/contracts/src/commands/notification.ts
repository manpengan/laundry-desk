import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const PhoneSchema = z.string().regex(/^1[3-9]\d{9}$/u);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const PickupReminderAgeDaysSchema = z.union([z.literal(30), z.literal(90), z.literal(180)]);
export const PickupReminderGarmentStatusSchema = z.enum(["ready", "racked"]);
export const PickupReminderGroupingSchema = z.enum(["order", "customer"]);

const ReminderStatusesSchema = z
  .array(PickupReminderGarmentStatusSchema)
  .min(1)
  .max(2)
  .refine((statuses) => new Set(statuses).size === statuses.length, {
    message: "Garment statuses must be unique",
  });

export const PickupReminderListInputSchema = z.strictObject({
  min_age_days: PickupReminderAgeDaysSchema.optional(),
  unpaid_only: z.boolean().optional(),
  garment_statuses: ReminderStatusesSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const SupportedTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (template) =>
      !template
        .replace(/\{\{(?:tickets|garment_count|balance_cents)\}\}/gu, "")
        .match(/\{\{|\}\}/u),
    { message: "Template contains an unsupported placeholder" },
  );

export const NotificationManualListCreateInputSchema = z.strictObject({
  order_ids: z
    .array(z.uuid())
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Order ids must be unique" }),
  group_by: PickupReminderGroupingSchema,
  message_template: SupportedTemplateSchema,
  format: z.literal("csv"),
  min_age_days: PickupReminderAgeDaysSchema,
  unpaid_only: z.boolean(),
  garment_statuses: ReminderStatusesSchema,
});

export const PickupReminderCandidateSchema = z.strictObject({
  order_id: z.uuid(),
  ticket_no: z.string().min(1).max(64),
  customer_id: z.uuid().nullable(),
  customer_name: z.string().max(128).nullable(),
  customer_phone: PhoneSchema,
  garment_count: PositiveSafeIntegerSchema,
  balance_cents: NonNegativeSafeIntegerSchema,
  received_at: ExactUtcTimestampSchema,
  overdue_days: NonNegativeSafeIntegerSchema,
  garment_statuses: ReminderStatusesSchema,
  last_contact_at: ExactUtcTimestampSchema.nullable(),
});

export const PickupReminderListResultSchema = z.strictObject({
  generated_at: ExactUtcTimestampSchema,
  channels: z.strictObject({
    manual: z.literal(true),
    sms: z.literal(false),
    wechat: z.literal(false),
  }),
  candidates: z.array(PickupReminderCandidateSchema).max(200),
});

export const NotificationManualListRowSchema = z.strictObject({
  order_ids: z.array(z.uuid()).min(1).max(50),
  ticket_nos: z.array(z.string().min(1).max(64)).min(1).max(50),
  customer_name: z.string().max(128).nullable(),
  customer_phone: PhoneSchema,
  garment_count: PositiveSafeIntegerSchema,
  balance_cents: NonNegativeSafeIntegerSchema,
  message: z.string().min(1).max(1_024),
});

export const NotificationManualListCreateResultSchema = z.strictObject({
  batch_id: z.uuid(),
  generated_at: ExactUtcTimestampSchema,
  channel: z.literal("manual"),
  status: z.literal("list_generated"),
  cost_cents: z.literal(0),
  recipient_count: PositiveSafeIntegerSchema.max(50),
  order_count: PositiveSafeIntegerSchema.max(50),
  filename: z.string().regex(/^pickup-reminders-\d{8}-[0-9a-f]{8}\.csv$/u),
  content_sha256: Sha256Schema,
  csv: z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 1_048_576, {
      message: "CSV must not exceed 1 MiB",
    }),
  rows: z.array(NotificationManualListRowSchema).min(1).max(50),
});

export const pickupReminderListQuery: QueryDefinition<typeof PickupReminderListInputSchema> =
  defineQuery({
    name: "notification.pickup_reminders.list",
    version: "0.1.0",
    description: "List store-scoped pickup reminder candidates for manual contact.",
    description_llm:
      "Return a bounded PII-bearing counter worklist for human contact. This query is deliberately excluded from the AI tool projection and does not imply that any message was sent.",
    input: PickupReminderListInputSchema,
    risk: "R2",
    invariants: ["rbac.customer_read"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [],
    result_redaction: [{ path: "/candidates/*/customer_phone", strategy: "mask" }],
    max_result_rows: 200,
  });

export const notificationManualListCreateCommand: CommandDefinition<
  typeof NotificationManualListCreateInputSchema
> = defineCommand({
  name: "notification.manual_list.create",
  version: "0.1.0",
  description: "Generate an audited manual pickup-reminder CSV for 1 to 50 current candidates.",
  description_llm:
    "After R3 confirmation, lock and revalidate the selected orders, render a deterministic CSV and record only hashes. This creates a manual list; it never sends or marks a notification delivered.",
  input: NotificationManualListCreateInputSchema,
  risk: "R3",
  invariants: ["rbac.customer_read", "notification.selection_current"],
  idempotent: true,
  sideEffects: ["notification.manual_list_generated", "audit.notification_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [
    { path: "/rows/*/customer_phone", strategy: "mask" },
    { path: "/csv", strategy: "remove" },
  ],
  size_measures: { batch: { kind: "array_length", path: "/order_ids" } },
  hard_limits: { max_batch: 50 },
});

export const NOTIFICATION_COMMANDS = Object.freeze([notificationManualListCreateCommand] as const);
export const NOTIFICATION_QUERIES = Object.freeze([pickupReminderListQuery] as const);
export const NOTIFICATION_COMMAND_NAMES = Object.freeze([
  "notification.manual_list.create",
] as const);
export const NOTIFICATION_QUERY_NAMES = Object.freeze([
  "notification.pickup_reminders.list",
] as const);
export const NOTIFICATION_DEFINITIONS = Object.freeze([
  ...NOTIFICATION_COMMANDS,
  ...NOTIFICATION_QUERIES,
]);

export type PickupReminderCandidate = z.output<typeof PickupReminderCandidateSchema>;
export type PickupReminderListResult = z.output<typeof PickupReminderListResultSchema>;
export type NotificationManualListCreateInput = z.output<
  typeof NotificationManualListCreateInputSchema
>;
export type NotificationManualListCreateResult = z.output<
  typeof NotificationManualListCreateResultSchema
>;
