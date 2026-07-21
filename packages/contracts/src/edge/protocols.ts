import { z } from "zod";

import { PositiveSafeIntegerSchema } from "../registry/limits.js";
import { CommandNameSchema } from "../registry/primitives.js";
import {
  EdgeCapabilityActionSchema,
  EdgeExecutionResultSchema,
  EdgeNonceSchema,
  EdgeOriginSchema,
  ExactUtcTimestampSchema,
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
export const CapabilityTicketPayloadSchema = z
  .object({
    action: EdgeCapabilityActionSchema,
    job_id: z.uuid(),
    staff_id: z.uuid(),
    device_id: z.uuid(),
    origin: EdgeOriginSchema,
    issued_at: ExactUtcTimestampSchema,
    exp: ExactUtcTimestampSchema,
    nonce: EdgeNonceSchema,
  })
  .strict()
  .superRefine((payload, context) =>
    addPositiveTimeWindowIssue(payload.issued_at, payload.exp, context, ["exp"]),
  );

/** Architecture §10 device-signed outcome used for print-job reconciliation and audit. */
export const ExecutionReceiptPayloadSchema = z
  .object({
    ticket_nonce: EdgeNonceSchema,
    result: EdgeExecutionResultSchema,
    seq: PositiveSafeIntegerSchema,
    at: ExactUtcTimestampSchema,
  })
  .strict();

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
export type ExecutionReceiptPayload = DeepReadonly<z.output<typeof ExecutionReceiptPayloadSchema>>;
export type OfflineGrantPayload = DeepReadonly<z.output<typeof OfflineGrantPayloadSchema>>;
export type PrimaryLeasePayload = DeepReadonly<z.output<typeof PrimaryLeasePayloadSchema>>;
