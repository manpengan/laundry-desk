import { z } from "zod";

import { SemVerSchema } from "../registry/primitives.js";
import {
  Base64UrlSignatureSchema,
  CupsJobIdSchema,
  EdgePrinterKindSchema,
  ExactUtcTimestampSchema,
} from "./primitives.js";
import { PrintSnapshotSchema } from "./print-snapshot.js";
import { CapabilityTicketPayloadSchema, ExecutionReceiptPayloadSchema } from "./protocols.js";

const UniquePrinterKindsSchema = z
  .array(EdgePrinterKindSchema)
  .min(1)
  .max(3)
  .refine((kinds) => new Set(kinds).size === kinds.length, {
    message: "Supported printer kinds must be unique",
  });

export const SignedPrintCapabilityTicketSchema = z.strictObject({
  protocol_version: SemVerSchema,
  payload: CapabilityTicketPayloadSchema,
  sig: Base64UrlSignatureSchema,
});

export const SignedPrintExecutionReceiptSchema = z.strictObject({
  protocol_version: SemVerSchema,
  payload: ExecutionReceiptPayloadSchema,
  sig: Base64UrlSignatureSchema,
});

export const PrintDispatchClaimRequestSchema = z.strictObject({
  supported_printer_kinds: UniquePrinterKindsSchema,
});

export const PrintDispatchDataSchema = z.strictObject({
  capability_ticket: SignedPrintCapabilityTicketSchema,
  snapshot: PrintSnapshotSchema,
});

export const PrintDispatchClaimResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: PrintDispatchDataSchema.nullable(),
});

export const PrintExecutionReceiptRequestSchema = z.strictObject({
  receipt: SignedPrintExecutionReceiptSchema,
});

export const PrintReceiptSettlementSchema = z.strictObject({
  job_id: z.uuid(),
  status: z.enum(["done", "failed", "uncertain"]),
  result: z.enum(["succeeded", "failed", "uncertain"]),
  cups_job_id: CupsJobIdSchema.nullable(),
  settled_at: ExactUtcTimestampSchema,
  duplicate: z.boolean(),
});

export const PrintReceiptResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: PrintReceiptSettlementSchema,
});

export type PrintDispatchClaimRequest = Readonly<z.output<typeof PrintDispatchClaimRequestSchema>>;
export type PrintDispatchData = Readonly<z.output<typeof PrintDispatchDataSchema>>;
export type PrintExecutionReceiptRequest = Readonly<
  z.output<typeof PrintExecutionReceiptRequestSchema>
>;
export type PrintReceiptSettlement = Readonly<z.output<typeof PrintReceiptSettlementSchema>>;
