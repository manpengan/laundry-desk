import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

export const FulfillmentGarmentStatusSchema = z.enum([
  "received",
  "washing",
  "ready",
  "racked",
  "picked_up",
  "delivered",
  "reworked",
  "lost",
]);

export const FulfillmentOperationalTargetSchema = z.enum(["washing", "ready", "racked"]);
export const GarmentIncidentKindSchema = z.enum(["damage", "other"]);

const GarmentIdSchema = z.uuid();
const ReasonSchema = z.string().trim().min(1).max(256);
const CompensationCentsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const GarmentTransitionInputSchema = z.strictObject({
  garment_id: GarmentIdSchema,
  target_status: FulfillmentOperationalTargetSchema,
  note: z.string().trim().max(256).optional(),
});

export const GarmentBulkTransitionInputSchema = z.strictObject({
  garment_ids: z.array(GarmentIdSchema).min(2).max(50),
  target_status: FulfillmentOperationalTargetSchema,
  note: z.string().trim().max(256).optional(),
});

export const GarmentReworkInputSchema = z.strictObject({
  garment_ids: z.array(GarmentIdSchema).min(1).max(50),
  reason: ReasonSchema,
});

export const GarmentIncidentRecordInputSchema = z.strictObject({
  garment_id: GarmentIdSchema,
  kind: GarmentIncidentKindSchema,
  note: ReasonSchema,
  compensation_cents: CompensationCentsSchema.optional(),
});

export const GarmentMarkLostInputSchema = z.strictObject({
  garment_id: GarmentIdSchema,
  reason: ReasonSchema,
  compensation_cents: CompensationCentsSchema,
});

export const FulfillmentWorkbenchInputSchema = z.strictObject({
  statuses: z.array(FulfillmentGarmentStatusSchema).min(1).max(8).optional(),
  key: z.string().trim().min(1).max(128).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export type FulfillmentWorkbenchRow = Readonly<{
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
  customer_name: string | null;
  customer_phone_masked: string | null;
  service_code: string;
  category_code: string;
  color: string | null;
  brand: string | null;
  status: z.output<typeof FulfillmentGarmentStatusSchema>;
  updated_at: number;
  incident_count: number;
}>;

export type FulfillmentWorkbenchResult = Readonly<{
  garments: readonly FulfillmentWorkbenchRow[];
}>;

type TransitionInput = typeof GarmentTransitionInputSchema;
type BulkTransitionInput = typeof GarmentBulkTransitionInputSchema;
type ReworkInput = typeof GarmentReworkInputSchema;
type IncidentInput = typeof GarmentIncidentRecordInputSchema;
type LostInput = typeof GarmentMarkLostInputSchema;
type WorkbenchInput = typeof FulfillmentWorkbenchInputSchema;

export const garmentTransitionCommand: CommandDefinition<TransitionInput> = defineCommand({
  name: "garment.transition",
  version: "0.1.0",
  description: "Move one garment through the normal fulfillment status machine.",
  description_llm:
    "Move one garment to washing, ready, or racked. The server validates the current status and appends an immutable status log.",
  input: GarmentTransitionInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write", "garment.transition_allowed"],
  idempotent: true,
  sideEffects: ["garment.status_changed", "audit.garment_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

export const garmentBulkTransitionCommand: CommandDefinition<BulkTransitionInput> = defineCommand({
  name: "garment.bulk_transition",
  version: "0.1.0",
  description: "Atomically move 2 to 50 garments through one normal fulfillment transition.",
  description_llm:
    "Move a bounded garment batch to washing, ready, or racked. The entire batch fails when any row is missing or has an invalid current status.",
  input: GarmentBulkTransitionInputSchema,
  risk: "R3",
  invariants: ["rbac.order_write", "garment.batch_transition_allowed"],
  idempotent: true,
  sideEffects: ["garment.status_changed", "audit.garment_batch_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/garment_ids" } },
  hard_limits: { max_batch: 50 },
});

export const garmentReworkCommand: CommandDefinition<ReworkInput> = defineCommand({
  name: "garment.rework",
  version: "0.1.0",
  description: "Return one or more eligible garments to rework with a mandatory reason.",
  description_llm:
    "Atomically mark washing, ready, or racked garments as reworked and retain the reason in status history.",
  input: GarmentReworkInputSchema,
  risk: "R3",
  invariants: ["rbac.order_write", "garment.rework_allowed"],
  idempotent: true,
  sideEffects: ["garment.reworked", "audit.garment_batch_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/garment_ids" } },
  hard_limits: { max_batch: 50 },
});

export const garmentIncidentRecordCommand: CommandDefinition<IncidentInput> = defineCommand({
  name: "garment.incident.record",
  version: "0.1.0",
  description: "Append a damage or other operational incident to one active garment.",
  description_llm:
    "Record an operational incident with a mandatory note and optional integer-fen compensation. This does not change the garment status.",
  input: GarmentIncidentRecordInputSchema,
  risk: "R3",
  invariants: ["rbac.order_write"],
  idempotent: true,
  sideEffects: ["garment.incident_recorded", "audit.garment_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

export const garmentMarkLostCommand: CommandDefinition<LostInput> = defineCommand({
  name: "garment.mark_lost",
  version: "0.1.0",
  description: "Mark one active garment lost and append a compensation incident.",
  description_llm:
    "High-risk terminal transition to lost. Requires another authorized staff step-up and records the reason plus integer-fen compensation.",
  input: GarmentMarkLostInputSchema,
  risk: "R4",
  invariants: ["rbac.order_write", "garment.loss_allowed"],
  idempotent: true,
  sideEffects: ["garment.lost", "garment.incident_recorded", "audit.garment_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [],
  size_measures: { amount: { kind: "field", path: "/compensation_cents" } },
  hard_limits: { max_amount_cents: 5_000_000 },
});

export const fulfillmentWorkbenchQuery: QueryDefinition<WorkbenchInput> = defineQuery({
  name: "fulfillment.workbench",
  version: "0.1.0",
  description: "List a bounded, store-scoped garment production workbench.",
  description_llm:
    "List up to 100 garments by status or ticket/barcode/customer key. Phone is always masked in the returned row.",
  input: FulfillmentWorkbenchInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/key", strategy: "mask" }],
  result_redaction: [{ path: "/garments/*/customer_phone_masked", strategy: "mask" }],
  max_result_rows: 100,
});

export const FULFILLMENT_COMMANDS = Object.freeze([
  garmentTransitionCommand,
  garmentBulkTransitionCommand,
  garmentReworkCommand,
  garmentIncidentRecordCommand,
  garmentMarkLostCommand,
] as const);

export const FULFILLMENT_COMMAND_NAMES = Object.freeze(
  FULFILLMENT_COMMANDS.map((command) => command.name),
);

export const FULFILLMENT_QUERIES = Object.freeze([fulfillmentWorkbenchQuery] as const);
export const FULFILLMENT_QUERY_NAMES = Object.freeze(
  FULFILLMENT_QUERIES.map((query) => query.name),
);

export const M3_FULFILLMENT_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] =
  Object.freeze([...FULFILLMENT_COMMANDS]);
export const M3_FULFILLMENT_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] =
  Object.freeze([...FULFILLMENT_QUERIES]);
