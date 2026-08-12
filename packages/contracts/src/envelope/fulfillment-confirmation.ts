import { z } from "zod";

import {
  FactoryCodeSchema,
  FactoryHandoffBarcodeSchema,
  FactoryHandoffCheckpointSchema,
  FactoryHandoffDigestSchema,
} from "../commands/factory-handoff-results.js";
import {
  FulfillmentOperationalTargetSchema,
  GarmentIncidentKindSchema,
} from "../commands/fulfillment.js";

const SafeCountSchema = z.number().int().nonnegative().max(100);
const TicketNoSchema = z.string().min(1).max(64);
const sorted = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1]! <= value);
const uniqueAndSorted = (values: readonly string[]): boolean =>
  new Set(values).size === values.length && sorted(values);

export const FactoryHandoffConfirmationOperationSchema = z.enum([
  "batch_create",
  "batch_cancel",
  "checkpoint_record",
  "discrepancy_resolve",
  "quality_check",
]);

const FactoryHandoffConfirmationCountsSchema = z.strictObject({
  manifest_count: SafeCountSchema,
  scan_count: SafeCountSchema,
  matched_count: SafeCountSchema,
  missing_count: SafeCountSchema,
  unexpected_count: SafeCountSchema,
  pass_count: SafeCountSchema.max(50),
  rework_count: SafeCountSchema.max(50),
});

export const FactoryHandoffConfirmationSummarySchema = z
  .strictObject({
    kind: z.literal("factory_handoff"),
    operation: FactoryHandoffConfirmationOperationSchema,
    batch_id: z.uuid().nullable(),
    expected_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    checkpoint: FactoryHandoffCheckpointSchema.nullable(),
    factory_code: FactoryCodeSchema,
    ticket_nos: z.array(TicketNoSchema).min(1).max(100),
    barcodes: z.array(FactoryHandoffBarcodeSchema).min(1).max(100),
    counts: FactoryHandoffConfirmationCountsSchema,
    manifest_digest: FactoryHandoffDigestSchema,
  })
  .superRefine((summary, context) => {
    const { counts } = summary;
    if (!sorted(summary.ticket_nos)) {
      context.addIssue({ code: "custom", path: ["ticket_nos"], message: "Must be sorted" });
    }
    if (!uniqueAndSorted(summary.barcodes)) {
      context.addIssue({
        code: "custom",
        path: ["barcodes"],
        message: "Must be unique and sorted",
      });
    }
    if (summary.ticket_nos.length !== summary.barcodes.length) {
      context.addIssue({ code: "custom", path: ["ticket_nos"], message: "Invalid item count" });
    }

    const create = summary.operation === "batch_create";
    if ((summary.batch_id === null) !== create || (summary.expected_version === null) !== create) {
      context.addIssue({
        code: "custom",
        path: ["batch_id"],
        message: "Only batch creation omits the existing batch identity and version",
      });
    }
    const checkpointOperation =
      summary.operation === "checkpoint_record" || summary.operation === "discrepancy_resolve";
    if (checkpointOperation !== (summary.checkpoint !== null)) {
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Only checkpoint operations identify a custody checkpoint",
      });
    }

    if (summary.operation === "quality_check") {
      if (
        counts.pass_count + counts.rework_count !== summary.barcodes.length ||
        counts.manifest_count < summary.barcodes.length
      ) {
        context.addIssue({ code: "custom", path: ["counts"], message: "Invalid QC counts" });
      }
      if (
        counts.scan_count !== 0 ||
        counts.matched_count !== 0 ||
        counts.missing_count !== 0 ||
        counts.unexpected_count !== 0
      ) {
        context.addIssue({ code: "custom", path: ["counts"], message: "QC has no scan counts" });
      }
      return;
    }

    if (counts.manifest_count !== summary.barcodes.length) {
      context.addIssue({ code: "custom", path: ["counts"], message: "Invalid manifest count" });
    }
    if (counts.pass_count !== 0 || counts.rework_count !== 0) {
      context.addIssue({ code: "custom", path: ["counts"], message: "Non-QC counts must be zero" });
    }
    if (!checkpointOperation) {
      if (
        counts.scan_count !== 0 ||
        counts.matched_count !== 0 ||
        counts.missing_count !== 0 ||
        counts.unexpected_count !== 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["counts"],
          message: "Batch creation and cancellation have no scan counts",
        });
      }
      return;
    }
    if (
      counts.matched_count + counts.missing_count !== counts.manifest_count ||
      counts.matched_count + counts.unexpected_count !== counts.scan_count
    ) {
      context.addIssue({ code: "custom", path: ["counts"], message: "Invalid scan set counts" });
    }
    if (
      summary.operation === "discrepancy_resolve" &&
      counts.missing_count + counts.unexpected_count === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["counts"],
        message: "A discrepancy resolution must cite a discrepant attempt",
      });
    }
  });

export const FulfillmentOperationConfirmationOperationSchema = z.enum([
  "bulk_transition",
  "rework",
  "incident_record",
  "mark_lost",
]);

export const FulfillmentOperationConfirmationSummarySchema = z
  .strictObject({
    kind: z.literal("fulfillment_operation"),
    operation: FulfillmentOperationConfirmationOperationSchema,
    garment_ids: z.array(z.uuid()).min(1).max(50),
    ticket_nos: z.array(TicketNoSchema).min(1).max(50),
    barcodes: z.array(FactoryHandoffBarcodeSchema).min(1).max(50),
    target_status: FulfillmentOperationalTargetSchema.nullable(),
    incident_kind: GarmentIncidentKindSchema.nullable(),
    compensation_cents: z.number().int().nonnegative().max(5_000_000).nullable(),
    reason: z.string().trim().min(1).max(256).nullable(),
    note: z.string().trim().max(256).nullable(),
    manifest_digest: FactoryHandoffDigestSchema,
  })
  .superRefine((summary, context) => {
    const sameLength =
      summary.garment_ids.length === summary.ticket_nos.length &&
      summary.garment_ids.length === summary.barcodes.length;
    if (!sameLength) {
      context.addIssue({ code: "custom", path: ["garment_ids"], message: "Invalid item count" });
    }
    if (!uniqueAndSorted(summary.garment_ids)) {
      context.addIssue({
        code: "custom",
        path: ["garment_ids"],
        message: "Must be unique and sorted",
      });
    }
    if (!sorted(summary.ticket_nos)) {
      context.addIssue({ code: "custom", path: ["ticket_nos"], message: "Must be sorted" });
    }
    if (!uniqueAndSorted(summary.barcodes)) {
      context.addIssue({
        code: "custom",
        path: ["barcodes"],
        message: "Must be unique and sorted",
      });
    }

    const expectedShape = {
      bulk_transition: {
        target: true,
        incident: false,
        compensation: false,
        reason: false,
        note: undefined,
      },
      rework: { target: false, incident: false, compensation: false, reason: true, note: false },
      incident_record: {
        target: false,
        incident: true,
        compensation: undefined,
        reason: false,
        note: true,
      },
      mark_lost: {
        target: false,
        incident: false,
        compensation: true,
        reason: true,
        note: false,
      },
    } as const;
    const shape = expectedShape[summary.operation];
    const actual = {
      target: summary.target_status !== null,
      incident: summary.incident_kind !== null,
      compensation: summary.compensation_cents !== null,
      reason: summary.reason !== null,
      note: summary.note !== null,
    };
    for (const key of ["target", "incident", "compensation", "reason", "note"] as const) {
      if (shape[key] !== undefined && actual[key] !== shape[key]) {
        context.addIssue({ code: "custom", path: [key], message: "Invalid operation summary" });
      }
    }
    const expectsOne = summary.operation === "incident_record" || summary.operation === "mark_lost";
    if (expectsOne && summary.garment_ids.length !== 1) {
      context.addIssue({ code: "custom", path: ["garment_ids"], message: "Expected one garment" });
    }
    if (summary.operation === "bulk_transition" && summary.garment_ids.length < 2) {
      context.addIssue({ code: "custom", path: ["garment_ids"], message: "Expected a batch" });
    }
    if (summary.operation === "incident_record" && summary.note?.length === 0) {
      context.addIssue({ code: "custom", path: ["note"], message: "Incident note is required" });
    }
  });

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type FactoryHandoffConfirmationSummary = DeepReadonly<
  z.output<typeof FactoryHandoffConfirmationSummarySchema>
>;
export type FulfillmentOperationConfirmationSummary = DeepReadonly<
  z.output<typeof FulfillmentOperationConfirmationSummarySchema>
>;
