import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_QUOTE_EPOCH_SECONDS = 4_294_967_295;

export const DeliveryServiceAreaCodeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u, "Expected lowercase service area code");

export const DeliveryDirectionSchema = z.enum(["pickup", "return"]);

export const DeliveryServiceAreaSchema = z.strictObject({
  code: DeliveryServiceAreaCodeSchema,
  name: z.string().trim().min(1).max(64),
  fee_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  is_active: z.boolean(),
});

export const DeliveryWeeklyWindowSchema = z
  .strictObject({
    weekday: z.number().int().min(1).max(7),
    start_minute: z.number().int().nonnegative().max(1_439),
    end_minute: z.number().int().positive().max(1_440),
  })
  .refine(({ start_minute, end_minute }) => end_minute > start_minute, {
    message: "Delivery window end must be after start",
  });

const DeliveryServiceAreasSchema = z
  .array(DeliveryServiceAreaSchema)
  .max(20)
  .refine((areas) => new Set(areas.map(({ code }) => code)).size === areas.length, {
    message: "Service area codes must be unique",
  });

const DeliveryWeeklyWindowsSchema = z
  .array(DeliveryWeeklyWindowSchema)
  .max(28)
  .refine(
    (windows) =>
      new Set(windows.map(({ weekday, start_minute }) => `${weekday}:${start_minute}`)).size ===
      windows.length,
    { message: "Weekly window starts must be unique" },
  );

const DeliveryPolicyFields = {
  accepting_appointments: z.boolean(),
  minimum_lead_minutes: z.number().int().nonnegative().max(10_080),
  maximum_advance_days: z.number().int().positive().max(365),
  slot_minutes: z.number().int().min(15).max(240),
  max_appointments_per_slot: z.number().int().positive().max(100),
  service_areas: DeliveryServiceAreasSchema,
  weekly_windows: DeliveryWeeklyWindowsSchema,
} as const;

export const DeliveryPolicySchema = z.strictObject({
  version: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  ...DeliveryPolicyFields,
  updated_at: z.number().int().nonnegative().nullable(),
});

export const DeliveryPolicyGetInputSchema = z.strictObject({});
export const DeliveryPolicyGetResultSchema = z.strictObject({ policy: DeliveryPolicySchema });

export const DeliveryPolicySetInputSchema = z.strictObject({
  expected_version: z
    .number()
    .int()
    .nonnegative()
    .max(POSTGRES_INTEGER_MAX - 1),
  ...DeliveryPolicyFields,
});

export const DeliveryAvailabilityQuoteInputSchema = z.strictObject({
  direction: DeliveryDirectionSchema,
  service_area_code: DeliveryServiceAreaCodeSchema,
  requested_start_at: z.number().int().nonnegative().max(MAX_QUOTE_EPOCH_SECONDS),
});

export const DeliveryAvailabilityReasonSchema = z.enum([
  "available",
  "delivery_disabled",
  "policy_not_configured",
  "appointments_paused",
  "service_area_unavailable",
  "outside_booking_horizon",
  "outside_service_window",
  "slot_misaligned",
]);

export const DeliveryAvailabilityQuoteSchema = z.strictObject({
  policy_version: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  feature_enabled: z.boolean(),
  can_request_appointment: z.boolean(),
  reason: DeliveryAvailabilityReasonSchema,
  direction: DeliveryDirectionSchema,
  service_area_code: DeliveryServiceAreaCodeSchema,
  requested_start_at: z.number().int().nonnegative().max(MAX_QUOTE_EPOCH_SECONDS),
  requested_end_at: z.number().int().nonnegative().max(MAX_QUOTE_EPOCH_SECONDS).nullable(),
  fee_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX).nullable(),
  capacity_status: z.literal("not_checked"),
  max_appointments_per_slot: z.number().int().positive().max(100).nullable(),
  timezone: z.string().trim().min(1).max(128),
});

export const DeliveryAvailabilityQuoteResultSchema = z.strictObject({
  quote: DeliveryAvailabilityQuoteSchema,
});

type GetInput = typeof DeliveryPolicyGetInputSchema;
type SetInput = typeof DeliveryPolicySetInputSchema;
type QuoteInput = typeof DeliveryAvailabilityQuoteInputSchema;

export const deliveryPolicyGetQuery: QueryDefinition<GetInput> = defineQuery({
  name: "delivery.policy.get",
  version: "1.0.0",
  description: "Load the authenticated store's delivery coverage and appointment policy.",
  description_llm:
    "Internal booking and configuration read. The authenticated session supplies the only store scope; mutation remains administrator-only.",
  input: DeliveryPolicyGetInputSchema,
  risk: "R0",
  invariants: ["rbac.delivery_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
});

export const deliveryPolicySetCommand: CommandDefinition<SetInput> = defineCommand({
  name: "delivery.policy.set",
  version: "1.0.0",
  description: "Replace the authenticated store's delivery policy using optimistic concurrency.",
  description_llm:
    "Not exposed to AI. R5 configuration requires another administrator's step-up approval and never enables the delivery feature flag.",
  input: DeliveryPolicySetInputSchema,
  risk: "R5",
  invariants: ["rbac.settings_admin", "delivery.policy_version_matches"],
  idempotent: true,
  sideEffects: ["delivery.policy.changed", "audit.config_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/weekly_windows" } },
  hard_limits: { max_batch: 28 },
});

export const deliveryAvailabilityQuoteQuery: QueryDefinition<QuoteInput> = defineQuery({
  name: "delivery.availability.quote",
  version: "1.0.0",
  description: "Evaluate one policy-only delivery appointment quote for the authenticated store.",
  description_llm:
    "Internal policy quote only. It does not create or hold an appointment, check occupied capacity, accept an address, or identify a customer.",
  input: DeliveryAvailabilityQuoteInputSchema,
  risk: "R1",
  invariants: ["rbac.delivery_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
});

export const DELIVERY_POLICY_COMMANDS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  deliveryPolicySetCommand,
]);

export const DELIVERY_POLICY_QUERIES: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  deliveryPolicyGetQuery,
  deliveryAvailabilityQuoteQuery,
]);

export const DELIVERY_POLICY_COMMAND_NAMES = Object.freeze(["delivery.policy.set"] as const);

export const DELIVERY_POLICY_QUERY_NAMES = Object.freeze([
  "delivery.policy.get",
  "delivery.availability.quote",
] as const);

export type DeliveryDirection = z.infer<typeof DeliveryDirectionSchema>;
export type DeliveryServiceArea = z.infer<typeof DeliveryServiceAreaSchema>;
export type DeliveryWeeklyWindow = z.infer<typeof DeliveryWeeklyWindowSchema>;
export type DeliveryPolicy = z.infer<typeof DeliveryPolicySchema>;
export type DeliveryPolicySetInput = z.infer<typeof DeliveryPolicySetInputSchema>;
export type DeliveryAvailabilityQuoteInput = z.infer<typeof DeliveryAvailabilityQuoteInputSchema>;
export type DeliveryAvailabilityQuote = z.infer<typeof DeliveryAvailabilityQuoteSchema>;
