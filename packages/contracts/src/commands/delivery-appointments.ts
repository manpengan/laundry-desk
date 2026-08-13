import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import { DeliveryDirectionSchema, DeliveryServiceAreaCodeSchema } from "./delivery-policy.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_EPOCH_SECONDS = 4_294_967_295;
const VersionSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const EpochSchema = z.number().int().nonnegative().max(MAX_EPOCH_SECONDS);

export const DeliveryAppointmentStatusSchema = z.enum(["scheduled", "cancelled"]);
export const DeliveryAppointmentCancellationReasonSchema = z.enum([
  "customer_request",
  "store_request",
  "unreachable",
  "duplicate",
  "other",
]);

export const DeliveryAppointmentSchema = z.strictObject({
  appointment_id: z.uuid(),
  customer_id: z.uuid(),
  address_id: z.uuid(),
  direction: DeliveryDirectionSchema,
  service_area_code: DeliveryServiceAreaCodeSchema,
  scheduled_start_at: EpochSchema,
  scheduled_end_at: EpochSchema,
  fee_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  status: DeliveryAppointmentStatusSchema,
  version: VersionSchema,
  policy_version: VersionSchema,
  created_at: EpochSchema,
  updated_at: EpochSchema,
  cancelled_at: EpochSchema.nullable(),
  cancellation_reason: DeliveryAppointmentCancellationReasonSchema.nullable(),
});

export const DeliveryAppointmentCreateInputSchema = z.strictObject({
  customer_id: z.uuid(),
  address_id: z.uuid(),
  direction: DeliveryDirectionSchema,
  service_area_code: DeliveryServiceAreaCodeSchema,
  requested_start_at: EpochSchema,
  expected_policy_version: VersionSchema,
});

export const DeliveryAppointmentRescheduleInputSchema = z.strictObject({
  appointment_id: z.uuid(),
  customer_id: z.uuid(),
  expected_version: VersionSchema,
  expected_policy_version: VersionSchema,
  requested_start_at: EpochSchema,
});

export const DeliveryAppointmentCancelInputSchema = z.strictObject({
  appointment_id: z.uuid(),
  customer_id: z.uuid(),
  expected_version: VersionSchema,
  reason: DeliveryAppointmentCancellationReasonSchema,
});

export const DeliveryAppointmentGetInputSchema = z.strictObject({ appointment_id: z.uuid() });

export const DeliveryAppointmentAddressSchema = z.strictObject({
  address_id: z.uuid(),
  label: z.string().trim().min(1).max(32),
  address: z.string().trim().min(1).max(256),
  is_default: z.boolean(),
});

export const DeliveryAppointmentAddressesListInputSchema = z.strictObject({
  customer_id: z.uuid(),
});

export const DeliveryAppointmentAddressesListResultSchema = z.strictObject({
  customer_id: z.uuid(),
  addresses: z.array(DeliveryAppointmentAddressSchema).max(100),
});

export const DeliveryAppointmentsListInputSchema = z
  .strictObject({
    customer_id: z.uuid().optional(),
    status: DeliveryAppointmentStatusSchema.optional(),
    from_start_at: EpochSchema.optional(),
    to_start_at: EpochSchema.optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .refine(
    ({ from_start_at, to_start_at }) =>
      from_start_at === undefined || to_start_at === undefined || from_start_at <= to_start_at,
    { message: "Appointment time range is reversed" },
  );

export const DeliveryAppointmentMutationResultSchema = z.strictObject({
  appointment: DeliveryAppointmentSchema,
});
export const DeliveryAppointmentGetResultSchema = DeliveryAppointmentMutationResultSchema;
export const DeliveryAppointmentsListResultSchema = z.strictObject({
  appointments: z.array(DeliveryAppointmentSchema).max(100),
});

const piiInputRedaction = Object.freeze([
  { path: "/customer_id", strategy: "mask" as const },
  { path: "/address_id", strategy: "mask" as const },
]);
const piiResultRedaction = Object.freeze([
  { path: "/appointment/customer_id", strategy: "mask" as const },
  { path: "/appointment/address_id", strategy: "mask" as const },
]);

export const deliveryAppointmentCreateCommand: CommandDefinition<
  typeof DeliveryAppointmentCreateInputSchema
> = defineCommand({
  name: "delivery.appointment.create",
  version: "1.0.0",
  description: "Reserve one delivery slot for an active customer address in the current store.",
  description_llm:
    "Internal counter operation. Revalidates the current feature, policy version, address ownership and slot capacity in one transaction.",
  input: DeliveryAppointmentCreateInputSchema,
  risk: "R3",
  invariants: ["rbac.delivery_write", "delivery.policy_version_matches", "delivery.capacity"],
  idempotent: true,
  sideEffects: ["delivery.appointment.created", "audit.delivery_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: piiInputRedaction,
  result_redaction: piiResultRedaction,
});

export const deliveryAppointmentRescheduleCommand: CommandDefinition<
  typeof DeliveryAppointmentRescheduleInputSchema
> = defineCommand({
  name: "delivery.appointment.reschedule",
  version: "1.0.0",
  description: "Move one scheduled delivery appointment to another policy-valid slot.",
  description_llm:
    "Internal counter operation. Uses optimistic appointment and policy versions and atomically moves the capacity hold.",
  input: DeliveryAppointmentRescheduleInputSchema,
  risk: "R3",
  invariants: ["rbac.delivery_write", "delivery.appointment_version", "delivery.capacity"],
  idempotent: true,
  sideEffects: ["delivery.appointment.rescheduled", "audit.delivery_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/customer_id", strategy: "mask" }],
  result_redaction: piiResultRedaction,
});

export const deliveryAppointmentCancelCommand: CommandDefinition<
  typeof DeliveryAppointmentCancelInputSchema
> = defineCommand({
  name: "delivery.appointment.cancel",
  version: "1.0.0",
  description: "Cancel one scheduled delivery appointment with a controlled reason code.",
  description_llm:
    "Internal counter operation. Cancellation remains available when delivery or appointment intake is paused.",
  input: DeliveryAppointmentCancelInputSchema,
  risk: "R3",
  invariants: ["rbac.delivery_write", "delivery.appointment_version"],
  idempotent: true,
  sideEffects: ["delivery.appointment.cancelled", "audit.delivery_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/customer_id", strategy: "mask" }],
  result_redaction: piiResultRedaction,
});

export const deliveryAppointmentGetQuery: QueryDefinition<
  typeof DeliveryAppointmentGetInputSchema
> = defineQuery({
  name: "delivery.appointment.get",
  version: "1.0.0",
  description: "Load one current-store delivery appointment by opaque id.",
  description_llm: "PII-linked internal record. Never exposed to AI tools.",
  input: DeliveryAppointmentGetInputSchema,
  risk: "R2",
  invariants: ["rbac.delivery_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: piiResultRedaction,
  max_result_rows: 1,
});

export const deliveryAppointmentAddressesListQuery: QueryDefinition<
  typeof DeliveryAppointmentAddressesListInputSchema
> = defineQuery({
  name: "delivery.appointment.addresses.list",
  version: "1.0.0",
  description: "List bounded active addresses across one customer's canonical merge group.",
  description_llm: "PII delivery address data. Never exposed to AI tools.",
  input: DeliveryAppointmentAddressesListInputSchema,
  risk: "R2",
  invariants: ["rbac.delivery_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/customer_id", strategy: "mask" }],
  result_redaction: [
    { path: "/customer_id", strategy: "mask" },
    { path: "/addresses", strategy: "remove" },
  ],
  max_result_rows: 100,
});

export const deliveryAppointmentsListQuery: QueryDefinition<
  typeof DeliveryAppointmentsListInputSchema
> = defineQuery({
  name: "delivery.appointments.list",
  version: "1.0.0",
  description: "List a bounded current-store delivery appointment worklist.",
  description_llm: "PII-linked internal worklist. Never exposed to AI tools.",
  input: DeliveryAppointmentsListInputSchema,
  risk: "R2",
  invariants: ["rbac.delivery_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/customer_id", strategy: "mask" }],
  result_redaction: [{ path: "/appointments", strategy: "remove" }],
  max_result_rows: 100,
});

export const DELIVERY_APPOINTMENT_COMMANDS = Object.freeze([
  deliveryAppointmentCreateCommand,
  deliveryAppointmentRescheduleCommand,
  deliveryAppointmentCancelCommand,
] as const);
export const DELIVERY_APPOINTMENT_QUERIES = Object.freeze([
  deliveryAppointmentGetQuery,
  deliveryAppointmentAddressesListQuery,
  deliveryAppointmentsListQuery,
] as const);
export const DELIVERY_APPOINTMENT_COMMAND_NAMES = Object.freeze(
  DELIVERY_APPOINTMENT_COMMANDS.map(({ name }) => name),
);
export const DELIVERY_APPOINTMENT_QUERY_NAMES = Object.freeze(
  DELIVERY_APPOINTMENT_QUERIES.map(({ name }) => name),
);

export type DeliveryAppointment = z.infer<typeof DeliveryAppointmentSchema>;
export type DeliveryAppointmentCreateInput = z.infer<typeof DeliveryAppointmentCreateInputSchema>;
export type DeliveryAppointmentRescheduleInput = z.infer<
  typeof DeliveryAppointmentRescheduleInputSchema
>;
export type DeliveryAppointmentCancelInput = z.infer<typeof DeliveryAppointmentCancelInputSchema>;
export type DeliveryAppointmentAddress = z.infer<typeof DeliveryAppointmentAddressSchema>;
export type DeliveryAppointmentAddressesListResult = z.infer<
  typeof DeliveryAppointmentAddressesListResultSchema
>;
export type DeliveryAppointmentsListInput = z.infer<typeof DeliveryAppointmentsListInputSchema>;
