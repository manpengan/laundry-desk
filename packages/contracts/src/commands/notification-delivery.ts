import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import {
  PickupReminderAgeDaysSchema,
  PickupReminderStatusesSchema,
} from "./notification-shared.js";

const SafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CostCentsSchema = SafeIntegerSchema.max(100_000);
const ProviderCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u);
const SafeErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);

export const NotificationDeliveryChannelSchema = z.literal("sms");
export const NotificationTemplateCodeSchema = z.literal("pickup_reminder_v1");
export const NotificationProviderAssuranceSchema = z.enum(["software_only", "external"]);
export const NotificationCapabilityStateSchema = z.enum(["disabled", "software_only", "external"]);
export const NotificationDeliveryStatusSchema = z.enum([
  "queued",
  "sending",
  "retry_wait",
  "accepted",
  "delivered",
  "manual_required",
  "cancelled",
]);
export type NotificationDeliveryStatus = z.output<typeof NotificationDeliveryStatusSchema>;
export const NotificationBatchStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "attention_required",
  "cancelled",
]);

const UniqueOrderIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Order ids must be unique" });

export const NotificationDeliveryBatchEnqueueInputSchema = z.strictObject({
  order_ids: UniqueOrderIdsSchema,
  channel: NotificationDeliveryChannelSchema,
  template_code: NotificationTemplateCodeSchema,
  max_cost_cents: CostCentsSchema,
  min_age_days: PickupReminderAgeDaysSchema,
  unpaid_only: z.boolean(),
  garment_statuses: PickupReminderStatusesSchema,
});

export const NotificationDeliveryBatchEnqueueResultSchema = z.strictObject({
  batch_id: z.uuid(),
  status: z.literal("queued"),
  assurance: NotificationProviderAssuranceSchema,
  provider_code: ProviderCodeSchema,
  channel: NotificationDeliveryChannelSchema,
  template_code: NotificationTemplateCodeSchema,
  template_version: z.number().int().positive().max(1_000_000),
  recipient_count: z.number().int().positive().max(50),
  order_count: z.number().int().positive().max(50),
  estimated_cost_cents: CostCentsSchema,
  max_cost_cents: CostCentsSchema,
  created_at: ExactUtcTimestampSchema,
});

export const NotificationDeliveryCapabilityInputSchema = z.strictObject({});
export const NotificationDeliveryCapabilityResultSchema = z
  .strictObject({
    state: NotificationCapabilityStateSchema,
    provider_code: ProviderCodeSchema.nullable(),
    channels: z.strictObject({
      manual: z.literal("available"),
      sms: NotificationCapabilityStateSchema,
      wechat: z.literal("disabled"),
    }),
    templates: z
      .array(
        z.strictObject({
          code: NotificationTemplateCodeSchema,
          version: z.number().int().positive().max(1_000_000),
          channel: NotificationDeliveryChannelSchema,
        }),
      )
      .max(10),
    max_batch: z.literal(50),
    r4_threshold: z.literal(10),
    unit_cost_cents: CostCentsSchema.nullable(),
    max_batch_cost_cents: CostCentsSchema.nullable(),
  })
  .superRefine((value, context) => {
    const disabled = value.state === "disabled";
    const invalidDisabled =
      disabled &&
      (value.provider_code !== null ||
        value.channels.sms !== "disabled" ||
        value.templates.length !== 0 ||
        value.unit_cost_cents !== null ||
        value.max_batch_cost_cents !== null);
    const invalidEnabled =
      !disabled &&
      (value.provider_code === null ||
        value.channels.sms !== value.state ||
        value.templates.length === 0 ||
        value.unit_cost_cents === null ||
        value.max_batch_cost_cents === null);
    if (invalidDisabled || invalidEnabled) {
      context.addIssue({
        code: "custom",
        message: "Notification capability shape is inconsistent",
      });
    }
  });

const NotificationDeliveryCountsSchema = z.strictObject({
  queued: z.number().int().nonnegative().max(50),
  sending: z.number().int().nonnegative().max(50),
  retry_wait: z.number().int().nonnegative().max(50),
  accepted: z.number().int().nonnegative().max(50),
  delivered: z.number().int().nonnegative().max(50),
  manual_required: z.number().int().nonnegative().max(50),
  cancelled: z.number().int().nonnegative().max(50),
});

export const NotificationDeliveryBatchSummarySchema = z.strictObject({
  batch_id: z.uuid(),
  status: NotificationBatchStatusSchema,
  assurance: NotificationProviderAssuranceSchema,
  provider_code: ProviderCodeSchema,
  channel: NotificationDeliveryChannelSchema,
  template_code: NotificationTemplateCodeSchema,
  template_version: z.number().int().positive().max(1_000_000),
  recipient_count: z.number().int().positive().max(50),
  counts: NotificationDeliveryCountsSchema,
  spent_cost_cents: CostCentsSchema,
  max_cost_cents: CostCentsSchema,
  created_at: ExactUtcTimestampSchema,
  updated_at: ExactUtcTimestampSchema,
});

export const NotificationDeliveryBatchesListInputSchema = z.strictObject({
  limit: z.number().int().positive().max(20).optional(),
});
export const NotificationDeliveryBatchesListResultSchema = z.strictObject({
  batches: z.array(NotificationDeliveryBatchSummarySchema).max(20),
});

export const NotificationDeliveryBatchGetInputSchema = z.strictObject({ batch_id: z.uuid() });
export const NotificationDeliveryViewSchema = z.strictObject({
  delivery_id: z.uuid(),
  order_id: z.uuid(),
  ticket_no: z.string().min(1).max(64),
  status: NotificationDeliveryStatusSchema,
  attempt_count: z.number().int().nonnegative().max(5),
  next_attempt_at: ExactUtcTimestampSchema.nullable(),
  last_error_code: SafeErrorCodeSchema.nullable(),
  cost_cents: CostCentsSchema,
  updated_at: ExactUtcTimestampSchema,
});
export const NotificationDeliveryBatchGetResultSchema = z.strictObject({
  batch: NotificationDeliveryBatchSummarySchema,
  deliveries: z.array(NotificationDeliveryViewSchema).max(50),
});

export const notificationDeliveryBatchEnqueueCommand: CommandDefinition<
  typeof NotificationDeliveryBatchEnqueueInputSchema
> = defineCommand({
  name: "notification.delivery_batch.enqueue",
  version: "0.1.0",
  description: "Queue 1 to 50 current pickup reminders through a configured provider adapter.",
  description_llm:
    "Online-only administrator action. The server revalidates every order, renders an approved template and stores no phone or message body in the outbox.",
  input: NotificationDeliveryBatchEnqueueInputSchema,
  risk: "R3",
  invariants: [
    "rbac.customer_read",
    "rbac.notification_send",
    "notification.provider_ready",
    "notification.selection_current",
  ],
  idempotent: true,
  sideEffects: ["notification.delivery_queued", "audit.notification_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/order_ids", strategy: "remove" }],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/order_ids" } },
  hard_limits: { max_batch: 50 },
  risk_escalation: { max_batch: 10 },
});

export const notificationDeliveryCapabilityQuery: QueryDefinition<
  typeof NotificationDeliveryCapabilityInputSchema
> = defineQuery({
  name: "notification.delivery.capability.get",
  version: "0.1.0",
  description: "Read the current notification provider assurance and bounded template catalog.",
  description_llm:
    "Return only safe capability metadata. A software-only provider is never evidence of real SMS or WeChat delivery.",
  input: NotificationDeliveryCapabilityInputSchema,
  risk: "R1",
  invariants: ["rbac.customer_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 10,
});

export const notificationDeliveryBatchesListQuery: QueryDefinition<
  typeof NotificationDeliveryBatchesListInputSchema
> = defineQuery({
  name: "notification.delivery_batches.list",
  version: "0.1.0",
  description: "List recent store-scoped notification delivery batches and derived counts.",
  description_llm: "PII-adjacent operational status; never expose it to the AI projection.",
  input: NotificationDeliveryBatchesListInputSchema,
  risk: "R2",
  invariants: ["rbac.customer_read", "rbac.notification_send"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 20,
});

export const notificationDeliveryBatchGetQuery: QueryDefinition<
  typeof NotificationDeliveryBatchGetInputSchema
> = defineQuery({
  name: "notification.delivery_batch.get",
  version: "0.1.0",
  description: "Read one bounded delivery batch for status and manual fallback.",
  description_llm: "Returns order references and safe status codes only; never phones or messages.",
  input: NotificationDeliveryBatchGetInputSchema,
  risk: "R2",
  invariants: ["rbac.customer_read", "rbac.notification_send"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [
    { path: "/deliveries/*/order_id", strategy: "remove" },
    { path: "/deliveries/*/ticket_no", strategy: "mask" },
  ],
  max_result_rows: 50,
});

export const NOTIFICATION_DELIVERY_COMMANDS = Object.freeze([
  notificationDeliveryBatchEnqueueCommand,
] as const);
export const NOTIFICATION_DELIVERY_QUERIES = Object.freeze([
  notificationDeliveryCapabilityQuery,
  notificationDeliveryBatchesListQuery,
  notificationDeliveryBatchGetQuery,
] as const);
export const NOTIFICATION_DELIVERY_COMMAND_NAMES = Object.freeze([
  "notification.delivery_batch.enqueue",
] as const);
export const NOTIFICATION_DELIVERY_QUERY_NAMES = Object.freeze([
  "notification.delivery.capability.get",
  "notification.delivery_batches.list",
  "notification.delivery_batch.get",
] as const);

export type NotificationDeliveryBatchEnqueueInput = z.output<
  typeof NotificationDeliveryBatchEnqueueInputSchema
>;
export type NotificationDeliveryBatchEnqueueResult = z.output<
  typeof NotificationDeliveryBatchEnqueueResultSchema
>;
export type NotificationDeliveryCapabilityResult = z.output<
  typeof NotificationDeliveryCapabilityResultSchema
>;
export type NotificationDeliveryBatchSummary = z.output<
  typeof NotificationDeliveryBatchSummarySchema
>;
export type NotificationDeliveryBatchGetResult = z.output<
  typeof NotificationDeliveryBatchGetResultSchema
>;
