import { z } from "zod";

import { PositiveSafeIntegerSchema } from "../registry/limits.js";
import { CommandNameSchema } from "../registry/primitives.js";
import {
  EdgeExecutionResultSchema,
  EdgeNonceSchema,
  EdgeOriginSchema,
  EdgePrinterKindSchema,
  ExactUtcTimestampSchema,
  CupsJobIdSchema,
  Sha256HexSchema,
} from "./primitives.js";

const addPositiveTimeWindowIssue = (
  issuedAt: string,
  expiresAt: string,
  context: z.core.$RefinementCtx,
  path: readonly PropertyKey[],
): void => {
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    context.addIssue({ code: "custom", message: "Expiry must follow issuance", path: [...path] });
  }
};

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const PositivePostgresIntegerSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const NonNegativePostgresIntegerSchema = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);

/** Server-authoritative reason one immutable print_jobs row entered the signed Edge path. */
export const PrintJobActionSchema = z.enum(["enqueue", "retry", "reprint"]);

/** M1 conservative offline authorization ceiling; future loosening requires a contract change. */
export const OFFLINE_GRANT_MAX_TTL_MS = 43_200_000;

const UniqueCommandNamesSchema = z
  .array(CommandNameSchema)
  .min(1)
  .refine((commands) => new Set(commands).size === commands.length, {
    message: "Grant command names must be unique",
  });

/**
 * Architecture §10 capability authority. Edge derives its maximum local lifetime from
 * `exp - issued_at`, anchors it to request-start monotonic time, and fails closed when RTT or
 * continuity cannot prove the deadline. A wall clock is not an authorization clock.
 */
const CapabilityTicketBaseSchema = z.object({
  job_id: z.uuid(),
  staff_id: z.uuid(),
  device_id: z.uuid(),
  origin: EdgeOriginSchema,
  issued_at: ExactUtcTimestampSchema,
  exp: ExactUtcTimestampSchema,
  nonce: EdgeNonceSchema,
});

export const CapabilityTicketPayloadSchema = z
  .discriminatedUnion("action", [
    CapabilityTicketBaseSchema.extend({
      action: z.literal("print_job"),
      print_action: PrintJobActionSchema,
      source_job_id: z.uuid().nullable(),
      printer_kind: EdgePrinterKindSchema,
      snapshot_sha256: Sha256HexSchema,
      recovered: z.boolean(),
      next_receipt_seq: PositiveSafeIntegerSchema,
    }).strict(),
    CapabilityTicketBaseSchema.extend({
      action: z.literal("cash_drawer_open"),
    }).strict(),
  ])
  .superRefine((payload, context) => {
    addPositiveTimeWindowIssue(payload.issued_at, payload.exp, context, ["exp"]);
    if (payload.action !== "print_job") return;
    if (payload.print_action === "enqueue" && payload.source_job_id !== null) {
      context.addIssue({
        code: "custom",
        message: "An enqueue capability cannot reference a source print job",
        path: ["source_job_id"],
      });
    }
    if (payload.print_action !== "enqueue" && payload.source_job_id === null) {
      context.addIssue({
        code: "custom",
        message: "A retry or reprint capability requires a source print job",
        path: ["source_job_id"],
      });
    }
  });

/** Architecture §10 device-signed outcome used for print-job reconciliation and audit. */
export const ExecutionReceiptPayloadSchema = z
  .object({
    job_id: z.uuid(),
    device_id: z.uuid(),
    ticket_nonce: EdgeNonceSchema,
    snapshot_sha256: Sha256HexSchema,
    result: EdgeExecutionResultSchema,
    cups_job_id: CupsJobIdSchema.nullable(),
    seq: PositiveSafeIntegerSchema,
    at: ExactUtcTimestampSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.result === "succeeded" && payload.cups_job_id === null) {
      context.addIssue({
        code: "custom",
        message: "A succeeded receipt requires a spooler job reference",
        path: ["cups_job_id"],
      });
    }
    if (payload.result === "failed" && payload.cups_job_id !== null) {
      context.addIssue({
        code: "custom",
        message: "A failed pre-submit receipt cannot carry a spooler job reference",
        path: ["cups_job_id"],
      });
    }
  });

/**
 * ADR-04 #6: short-lived, tenant-scoped dynamic authorization for one staff/device pair.
 * Edge derives its maximum local lifetime from `ttl_ms`, anchors it to request-start monotonic
 * time, subtracts measured RTT/safety margin, and fails closed after restart, suspend, clock
 * rollback, or any continuity gap. A wall clock is not an authorization clock.
 */
export const OfflineGrantPayloadSchema = z
  .object({
    grant_id: z.uuid(),
    org_id: z.uuid(),
    store_id: z.uuid(),
    staff_id: z.uuid(),
    device_id: z.uuid(),
    request_nonce: EdgeNonceSchema,
    permission_version: PositiveSafeIntegerSchema,
    allowed_commands: UniqueCommandNamesSchema,
    issued_at: ExactUtcTimestampSchema,
    ttl_ms: PositivePostgresIntegerSchema.max(OFFLINE_GRANT_MAX_TTL_MS),
    not_after: ExactUtcTimestampSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (Date.parse(payload.not_after) !== Date.parse(payload.issued_at) + payload.ttl_ms) {
      context.addIssue({
        code: "custom",
        message: "Signed not_after must equal issued_at plus ttl_ms",
        path: ["not_after"],
      });
    }
  });

/**
 * ADR-04 #7 / A4 §2.1: exact M0-2 signed lease authority. `not_after` is signed and must equal
 * `issued_at + ttl_ms`; runtime authorization still requires M0-2 monotonic-time continuity.
 */
export const PrimaryLeasePayloadSchema = z
  .object({
    lease_id: z.uuid(),
    grant_id: z.uuid(),
    org_id: z.uuid(),
    store_id: z.uuid(),
    device_id: z.uuid(),
    primary_epoch: PositiveSafeIntegerSchema,
    issued_at: ExactUtcTimestampSchema,
    ttl_ms: PositivePostgresIntegerSchema,
    max_clock_skew_ms: NonNegativePostgresIntegerSchema,
    not_after: ExactUtcTimestampSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (Date.parse(payload.not_after) !== Date.parse(payload.issued_at) + payload.ttl_ms) {
      context.addIssue({
        code: "custom",
        message: "Signed not_after must equal issued_at plus ttl_ms",
        path: ["not_after"],
      });
    }
  });

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type CapabilityTicketPayload = DeepReadonly<z.output<typeof CapabilityTicketPayloadSchema>>;
export type PrintJobAction = z.output<typeof PrintJobActionSchema>;
export type ExecutionReceiptPayload = DeepReadonly<z.output<typeof ExecutionReceiptPayloadSchema>>;
export type OfflineGrantPayload = DeepReadonly<z.output<typeof OfflineGrantPayloadSchema>>;
export type PrimaryLeasePayload = DeepReadonly<z.output<typeof PrimaryLeasePayloadSchema>>;
