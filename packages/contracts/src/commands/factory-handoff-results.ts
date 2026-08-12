import { z } from "zod";

import { FulfillmentGarmentStatusSchema } from "./fulfillment.js";

const SafeCountSchema = z.number().int().nonnegative().max(100);
const PositiveVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const EpochSecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sorted = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1]! <= value);
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const FactoryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_.-]{0,31}$/u, "Expected a controlled uppercase factory code");
export const FactoryHandoffDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const FactoryHandoffBarcodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, "Barcode must not contain control characters")
  .refine((value) => new TextEncoder().encode(value).byteLength <= 64, {
    message: "Barcode must be at most 64 UTF-8 bytes",
  });
export const FactoryHandoffCheckpointSchema = z.enum([
  "store_dispatch",
  "factory_receive",
  "factory_dispatch",
  "store_receive",
]);
export const FactoryBatchStatusSchema = z.enum([
  "packing",
  "store_dispatched",
  "factory_received",
  "factory_dispatched",
  "store_received",
  "cancelled",
]);
export const GarmentCustodyStateSchema = z.enum([
  "store",
  "to_factory",
  "factory",
  "to_store",
  "exception",
]);
export const FactoryBatchMemberStateSchema = z.enum(["active", "exception", "completed"]);
export const GarmentQualityStatusSchema = z.enum(["pending", "pass", "rework"]);
export const GarmentQualityOutcomeSchema = z.enum(["pass", "rework"]);
export const GarmentQualityReworkReasonSchema = z.enum([
  "stain_remaining",
  "damage_found",
  "finish_incomplete",
  "other",
]);

export const FactoryHandoffMutationResultSchema = z.strictObject({
  batch_id: z.uuid(),
  status: FactoryBatchStatusSchema,
  version: PositiveVersionSchema,
  manifest_digest: FactoryHandoffDigestSchema,
});
export const FactoryHandoffBatchCreateResultSchema = FactoryHandoffMutationResultSchema.extend({
  status: z.literal("packing"),
}).strict();
export const FactoryHandoffBatchCancelResultSchema = FactoryHandoffMutationResultSchema.extend({
  status: z.literal("cancelled"),
}).strict();

const differenceCountsShape = {
  matched_count: SafeCountSchema,
  missing_count: SafeCountSchema,
  unexpected_count: SafeCountSchema,
};

const batchStatusBeforeCheckpoint = {
  store_dispatch: "packing",
  factory_receive: "store_dispatched",
  factory_dispatch: "factory_received",
  store_receive: "factory_dispatched",
} as const;
const batchStatusAfterCheckpoint = {
  store_dispatch: "store_dispatched",
  factory_receive: "factory_received",
  factory_dispatch: "factory_dispatched",
  store_receive: "store_received",
} as const;

export const FactoryHandoffCheckpointRecordResultSchema = FactoryHandoffMutationResultSchema.extend(
  {
    checkpoint: FactoryHandoffCheckpointSchema,
    attempt_id: z.uuid(),
    outcome: z.enum(["matched", "discrepancy"]),
    ...differenceCountsShape,
  },
)
  .strict()
  .superRefine((value, context) => {
    const hasDifference = value.missing_count + value.unexpected_count > 0;
    if ((value.outcome === "discrepancy") !== hasDifference) {
      context.addIssue({ code: "custom", path: ["outcome"], message: "Invalid scan outcome" });
    }
    const expectedStatus =
      value.outcome === "matched"
        ? batchStatusAfterCheckpoint[value.checkpoint]
        : batchStatusBeforeCheckpoint[value.checkpoint];
    if (value.status !== expectedStatus) {
      context.addIssue({ code: "custom", path: ["status"], message: "Invalid batch status" });
    }
  });

export const FactoryHandoffDiscrepancyResolveResultSchema =
  FactoryHandoffMutationResultSchema.extend({
    checkpoint: FactoryHandoffCheckpointSchema,
    attempt_id: z.uuid(),
    ...differenceCountsShape,
  })
    .strict()
    .superRefine((value, context) => {
      if (value.missing_count + value.unexpected_count === 0) {
        context.addIssue({ code: "custom", path: ["missing_count"], message: "No discrepancy" });
      }
      if (value.status !== batchStatusAfterCheckpoint[value.checkpoint]) {
        context.addIssue({ code: "custom", path: ["status"], message: "Invalid batch status" });
      }
    });

export const FactoryQualityCheckRecordResultSchema = FactoryHandoffMutationResultSchema.extend({
  status: z.literal("factory_received"),
  pass_count: SafeCountSchema.max(50),
  rework_count: SafeCountSchema.max(50),
})
  .strict()
  .refine(
    ({ pass_count, rework_count }) =>
      pass_count + rework_count > 0 && pass_count + rework_count <= 50,
    {
      path: ["pass_count"],
      message: "Quality check count must be between 1 and 50",
    },
  );

export const FactoryHandoffBatchSummarySchema = z
  .strictObject({
    batch_id: z.uuid(),
    factory_code: FactoryCodeSchema,
    status: FactoryBatchStatusSchema,
    version: PositiveVersionSchema,
    manifest_count: SafeCountSchema,
    exception_count: SafeCountSchema,
    updated_at: EpochSecondsSchema,
  })
  .refine(({ exception_count, manifest_count }) => exception_count <= manifest_count, {
    path: ["exception_count"],
    message: "Exception count cannot exceed the manifest",
  });

export const FactoryHandoffEligibleGarmentSchema = z.strictObject({
  garment_id: z.uuid(),
  order_id: z.uuid(),
  ticket_no: z.string().min(1).max(64),
  barcode: FactoryHandoffBarcodeSchema,
  status: FulfillmentGarmentStatusSchema,
  custody_state: GarmentCustodyStateSchema,
});

export const FactoryHandoffManifestGarmentSchema = FactoryHandoffEligibleGarmentSchema.extend({
  member_state: FactoryBatchMemberStateSchema,
  qc_status: GarmentQualityStatusSchema,
}).strict();

export const FactoryHandoffCheckpointViewSchema = z.strictObject({
  checkpoint: FactoryHandoffCheckpointSchema,
  completed_at: EpochSecondsSchema,
  ...differenceCountsShape,
});

const BarcodeListSchema = z
  .array(FactoryHandoffBarcodeSchema)
  .max(100)
  .refine((values) => unique(values) && sorted(values), { message: "Must be unique and sorted" });
export const FactoryHandoffAttemptViewSchema = z
  .strictObject({
    attempt_id: z.uuid(),
    checkpoint: FactoryHandoffCheckpointSchema,
    outcome: z.enum(["matched", "discrepancy"]),
    matched_barcodes: BarcodeListSchema,
    missing_barcodes: BarcodeListSchema,
    unexpected_barcodes: BarcodeListSchema,
    recorded_at: EpochSecondsSchema,
  })
  .superRefine((value, context) => {
    const all = [
      ...value.matched_barcodes,
      ...value.missing_barcodes,
      ...value.unexpected_barcodes,
    ];
    if (!unique(all)) {
      context.addIssue({ code: "custom", path: ["matched_barcodes"], message: "Sets overlap" });
    }
    const hasDifference = value.missing_barcodes.length + value.unexpected_barcodes.length > 0;
    if ((value.outcome === "discrepancy") !== hasDifference) {
      context.addIssue({ code: "custom", path: ["outcome"], message: "Invalid scan outcome" });
    }
  });

export const FactoryQualityCheckViewSchema = z
  .strictObject({
    garment_id: z.uuid(),
    outcome: GarmentQualityOutcomeSchema,
    reason_code: GarmentQualityReworkReasonSchema.nullable(),
    inspected_at: EpochSecondsSchema,
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

export const FactoryHandoffBatchesListResultSchema = z.strictObject({
  batches: z.array(FactoryHandoffBatchSummarySchema).max(20),
  eligible_garments: z.array(FactoryHandoffEligibleGarmentSchema).max(100),
});

export const FactoryHandoffBatchGetResultSchema = z.strictObject({
  batch: FactoryHandoffBatchSummarySchema,
  manifest: z.array(FactoryHandoffManifestGarmentSchema).max(100),
  checkpoints: z.array(FactoryHandoffCheckpointViewSchema).max(4),
  latest_attempt: FactoryHandoffAttemptViewSchema.nullable(),
  quality_checks: z.array(FactoryQualityCheckViewSchema).max(100),
});

export type FactoryHandoffMutationResult = z.output<typeof FactoryHandoffMutationResultSchema>;
export type FactoryBatchStatus = z.output<typeof FactoryBatchStatusSchema>;
export type FactoryHandoffCheckpoint = z.output<typeof FactoryHandoffCheckpointSchema>;
export type GarmentCustodyState = z.output<typeof GarmentCustodyStateSchema>;
export type FactoryBatchMemberState = z.output<typeof FactoryBatchMemberStateSchema>;
export type GarmentQualityStatus = z.output<typeof GarmentQualityStatusSchema>;
export type GarmentQualityOutcome = z.output<typeof GarmentQualityOutcomeSchema>;
export type GarmentQualityReworkReason = z.output<typeof GarmentQualityReworkReasonSchema>;
export type FactoryHandoffBatchSummary = z.output<typeof FactoryHandoffBatchSummarySchema>;
export type FactoryHandoffEligibleGarment = z.output<typeof FactoryHandoffEligibleGarmentSchema>;
export type FactoryHandoffManifestGarment = z.output<typeof FactoryHandoffManifestGarmentSchema>;
export type FactoryHandoffCheckpointView = z.output<typeof FactoryHandoffCheckpointViewSchema>;
export type FactoryHandoffAttemptView = z.output<typeof FactoryHandoffAttemptViewSchema>;
export type FactoryQualityCheckView = z.output<typeof FactoryQualityCheckViewSchema>;
export type FactoryHandoffBatchCreateResult = z.output<
  typeof FactoryHandoffBatchCreateResultSchema
>;
export type FactoryHandoffBatchCancelResult = z.output<
  typeof FactoryHandoffBatchCancelResultSchema
>;
export type FactoryHandoffCheckpointRecordResult = z.output<
  typeof FactoryHandoffCheckpointRecordResultSchema
>;
export type FactoryHandoffDiscrepancyResolveResult = z.output<
  typeof FactoryHandoffDiscrepancyResolveResultSchema
>;
export type FactoryQualityCheckRecordResult = z.output<
  typeof FactoryQualityCheckRecordResultSchema
>;
export type FactoryHandoffBatchesListResult = z.output<
  typeof FactoryHandoffBatchesListResultSchema
>;
export type FactoryHandoffBatchGetResult = z.output<typeof FactoryHandoffBatchGetResultSchema>;
