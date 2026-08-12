import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import {
  FactoryBatchStatusSchema,
  FactoryCodeSchema,
  FactoryHandoffBarcodeSchema,
  FactoryHandoffCheckpointSchema,
  GarmentQualityOutcomeSchema,
  GarmentQualityReworkReasonSchema,
} from "./factory-handoff-results.js";

const NonNegativeVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const BatchIdSchema = z.uuid();
const GarmentIdSchema = z.uuid();

const uniqueValues = (values: readonly string[]): boolean => new Set(values).size === values.length;
const UniqueGarmentIdsSchema = z
  .array(GarmentIdSchema)
  .min(1)
  .max(100)
  .refine(uniqueValues, { message: "Garment ids must be unique" });
const OptionalMissingGarmentIdsSchema = z
  .array(GarmentIdSchema)
  .max(100)
  .refine(uniqueValues, { message: "Garment ids must be unique" });
const UniqueScannedBarcodesSchema = z
  .array(FactoryHandoffBarcodeSchema)
  .min(1)
  .max(100)
  .refine(uniqueValues, { message: "Scanned barcodes must be unique" });

export const FactoryBatchCancelReasonSchema = z.enum([
  "duplicate_batch",
  "customer_request",
  "operational_error",
]);
export const FactoryHandoffDiscrepancyReasonSchema = z.enum([
  "manifest_corrected",
  "recount_verified",
  "exception_accepted",
]);

export const FactoryBatchCreateInputSchema = z.strictObject({
  factory_code: FactoryCodeSchema,
  garment_ids: UniqueGarmentIdsSchema,
});
export const FactoryBatchCancelInputSchema = z.strictObject({
  batch_id: BatchIdSchema,
  expected_version: NonNegativeVersionSchema,
  reason_code: FactoryBatchCancelReasonSchema,
});
export const FactoryHandoffCheckpointRecordInputSchema = z.strictObject({
  batch_id: BatchIdSchema,
  checkpoint: FactoryHandoffCheckpointSchema,
  expected_version: NonNegativeVersionSchema,
  garment_ids: UniqueGarmentIdsSchema,
  scanned_barcodes: UniqueScannedBarcodesSchema,
});
export const FactoryHandoffDiscrepancyResolveInputSchema = z.strictObject({
  batch_id: BatchIdSchema,
  attempt_id: z.uuid(),
  expected_version: NonNegativeVersionSchema,
  garment_ids: OptionalMissingGarmentIdsSchema,
  reason_code: FactoryHandoffDiscrepancyReasonSchema,
});

export const FactoryQualityCheckSchema = z
  .strictObject({
    garment_id: GarmentIdSchema,
    outcome: GarmentQualityOutcomeSchema,
    reason_code: GarmentQualityReworkReasonSchema.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.outcome === "rework") !== (value.reason_code !== null)) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "Only rework quality checks require a reason code",
      });
    }
  });

export const FactoryQualityCheckRecordInputSchema = z
  .strictObject({
    batch_id: BatchIdSchema,
    expected_version: NonNegativeVersionSchema,
    garment_ids: z
      .array(GarmentIdSchema)
      .min(1)
      .max(50)
      .refine(uniqueValues, { message: "Garment ids must be unique" }),
    checks: z.array(FactoryQualityCheckSchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    const checkIds = value.checks.map(({ garment_id }) => garment_id);
    const sameSet =
      checkIds.length === value.garment_ids.length &&
      new Set(checkIds).size === checkIds.length &&
      checkIds.every((garmentId) => value.garment_ids.includes(garmentId));
    if (!sameSet) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Quality checks must cover exactly the submitted garment ids",
      });
    }
  });

export const FactoryHandoffBatchesListInputSchema = z.strictObject({
  statuses: z
    .array(FactoryBatchStatusSchema)
    .min(1)
    .max(6)
    .refine(uniqueValues, { message: "Batch statuses must be unique" })
    .optional(),
  limit: z.number().int().positive().max(20).optional(),
});
export const FactoryHandoffBatchGetInputSchema = z.strictObject({ batch_id: BatchIdSchema });

export const factoryBatchCreateCommand: CommandDefinition<typeof FactoryBatchCreateInputSchema> =
  defineCommand({
    name: "fulfillment.batch.create",
    version: "1.0.0",
    description: "Create one store-scoped factory handoff batch from 1 to 100 eligible garments.",
    description_llm:
      "Online-only internal custody operation. The server revalidates every garment and derives ticket, barcode and manifest evidence.",
    input: FactoryBatchCreateInputSchema,
    risk: "R3",
    invariants: [
      "rbac.fulfillment_handoff",
      "fulfillment.authenticated_device",
      "fulfillment.batch_manifest_eligible",
    ],
    idempotent: true,
    sideEffects: ["fulfillment.batch_created", "audit.fulfillment_event"],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [{ path: "/garment_ids", strategy: "remove" }],
    result_redaction: [],
    size_measures: { batch: { kind: "array_length", path: "/garment_ids" } },
    hard_limits: { max_batch: 100 },
    risk_escalation: { max_batch: 50 },
  });

export const factoryBatchCancelCommand: CommandDefinition<typeof FactoryBatchCancelInputSchema> =
  defineCommand({
    name: "fulfillment.batch.cancel",
    version: "1.0.0",
    description: "Cancel a packing handoff batch with optimistic concurrency.",
    description_llm:
      "Online-only internal custody action. Cancellation releases active manifest members back to store custody and never deletes evidence.",
    input: FactoryBatchCancelInputSchema,
    risk: "R3",
    invariants: [
      "rbac.fulfillment_handoff",
      "fulfillment.authenticated_device",
      "fulfillment.batch_cancellable",
    ],
    idempotent: true,
    sideEffects: ["fulfillment.batch_cancelled", "audit.fulfillment_event"],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [],
    result_redaction: [],
  });

export const factoryHandoffCheckpointRecordCommand: CommandDefinition<
  typeof FactoryHandoffCheckpointRecordInputSchema
> = defineCommand({
  name: "fulfillment.handoff.checkpoint.record",
  version: "1.0.0",
  description: "Record one complete manifest scan at the next store/factory custody checkpoint.",
  description_llm:
    "The server verifies the submitted manifest snapshot, computes exact barcode differences and advances only a fully matched checkpoint.",
  input: FactoryHandoffCheckpointRecordInputSchema,
  risk: "R3",
  invariants: [
    "rbac.fulfillment_handoff",
    "fulfillment.authenticated_device",
    "fulfillment.handoff_next_checkpoint",
    "fulfillment.manifest_snapshot_current",
  ],
  idempotent: true,
  sideEffects: ["fulfillment.handoff_attempt_recorded", "audit.fulfillment_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [
    { path: "/garment_ids", strategy: "remove" },
    { path: "/scanned_barcodes", strategy: "remove" },
  ],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/garment_ids" } },
  hard_limits: { max_batch: 100 },
  risk_escalation: { max_batch: 50 },
});

export const factoryHandoffDiscrepancyResolveCommand: CommandDefinition<
  typeof FactoryHandoffDiscrepancyResolveInputSchema
> = defineCommand({
  name: "fulfillment.handoff.discrepancy.resolve",
  version: "1.0.0",
  description: "Resolve the latest blocked handoff difference under a second administrator.",
  description_llm:
    "The server requires exactly the latest attempt's missing garment ids, never adds unexpected scans to the manifest, and advances only matched remaining custody.",
  input: FactoryHandoffDiscrepancyResolveInputSchema,
  risk: "R4",
  invariants: [
    "rbac.fulfillment_handoff",
    "rbac.fulfillment_reconcile",
    "fulfillment.authenticated_device",
    "fulfillment.latest_discrepancy_current",
  ],
  idempotent: true,
  sideEffects: ["fulfillment.handoff_discrepancy_resolved", "audit.fulfillment_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/garment_ids", strategy: "remove" }],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/garment_ids" } },
  hard_limits: { max_batch: 100 },
});

export const factoryQualityCheckRecordCommand: CommandDefinition<
  typeof FactoryQualityCheckRecordInputSchema
> = defineCommand({
  name: "fulfillment.quality_check.record",
  version: "1.0.0",
  description:
    "Record pass or controlled rework decisions for 1 to 50 factory-received batch garments.",
  description_llm:
    "The server verifies the batch manifest and records immutable QC evidence. Rework uses a controlled reason and the garment lifecycle remains authoritative.",
  input: FactoryQualityCheckRecordInputSchema,
  risk: "R3",
  invariants: [
    "rbac.fulfillment_handoff",
    "rbac.fulfillment_qc",
    "fulfillment.authenticated_device",
    "fulfillment.batch_returned",
  ],
  idempotent: true,
  sideEffects: ["fulfillment.quality_checked", "garment.reworked", "audit.fulfillment_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [
    { path: "/garment_ids", strategy: "remove" },
    { path: "/checks", strategy: "remove" },
  ],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/garment_ids" } },
  hard_limits: { max_batch: 50 },
});

export const factoryHandoffBatchesListQuery: QueryDefinition<
  typeof FactoryHandoffBatchesListInputSchema
> = defineQuery({
  name: "fulfillment.batches.list",
  version: "1.0.0",
  description: "List recent handoff batches and eligible garments for the authenticated store.",
  description_llm:
    "PII-adjacent internal custody view containing ticket and garment barcodes but no customer name or phone; never expose it to AI tools.",
  input: FactoryHandoffBatchesListInputSchema,
  risk: "R2",
  invariants: ["rbac.fulfillment_handoff"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [
    { path: "/eligible_garments/*/garment_id", strategy: "remove" },
    { path: "/eligible_garments/*/order_id", strategy: "remove" },
    { path: "/eligible_garments/*/ticket_no", strategy: "mask" },
    { path: "/eligible_garments/*/barcode", strategy: "mask" },
  ],
  max_result_rows: 120,
});

export const factoryHandoffBatchGetQuery: QueryDefinition<
  typeof FactoryHandoffBatchGetInputSchema
> = defineQuery({
  name: "fulfillment.batch.get",
  version: "1.0.0",
  description: "Read one bounded handoff batch, manifest, discrepancy and quality evidence.",
  description_llm:
    "PII-adjacent internal custody evidence with ticket and garment barcodes but no customer identity; never expose it to AI tools.",
  input: FactoryHandoffBatchGetInputSchema,
  risk: "R2",
  invariants: ["rbac.fulfillment_handoff"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [
    { path: "/manifest/*/garment_id", strategy: "remove" },
    { path: "/manifest/*/order_id", strategy: "remove" },
    { path: "/manifest/*/ticket_no", strategy: "mask" },
    { path: "/manifest/*/barcode", strategy: "mask" },
    { path: "/latest_attempt/matched_barcodes", strategy: "mask" },
    { path: "/latest_attempt/missing_barcodes", strategy: "mask" },
    { path: "/latest_attempt/unexpected_barcodes", strategy: "mask" },
    { path: "/quality_checks/*/garment_id", strategy: "remove" },
  ],
  max_result_rows: 205,
});

export const FACTORY_HANDOFF_COMMANDS = Object.freeze([
  factoryBatchCreateCommand,
  factoryBatchCancelCommand,
  factoryHandoffCheckpointRecordCommand,
  factoryHandoffDiscrepancyResolveCommand,
  factoryQualityCheckRecordCommand,
] as const);
export const FACTORY_HANDOFF_QUERIES = Object.freeze([
  factoryHandoffBatchesListQuery,
  factoryHandoffBatchGetQuery,
] as const);
export const FACTORY_HANDOFF_COMMAND_NAMES = Object.freeze(
  FACTORY_HANDOFF_COMMANDS.map(({ name }) => name),
);
export const FACTORY_HANDOFF_QUERY_NAMES = Object.freeze(
  FACTORY_HANDOFF_QUERIES.map(({ name }) => name),
);

export type FactoryBatchCreateInput = z.output<typeof FactoryBatchCreateInputSchema>;
export type FactoryBatchCancelInput = z.output<typeof FactoryBatchCancelInputSchema>;
export type FactoryHandoffCheckpointRecordInput = z.output<
  typeof FactoryHandoffCheckpointRecordInputSchema
>;
export type FactoryHandoffDiscrepancyResolveInput = z.output<
  typeof FactoryHandoffDiscrepancyResolveInputSchema
>;
export type FactoryQualityCheckRecordInput = z.output<typeof FactoryQualityCheckRecordInputSchema>;
