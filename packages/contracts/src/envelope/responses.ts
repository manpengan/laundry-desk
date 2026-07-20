import { z } from "zod";

import { JsonPointerSchema } from "../registry/primitives.js";
import { ConfirmReferenceSchema } from "./wire-payload.js";

/** Architecture §6.5: externally safe outcomes for each C1 validation-chain stage. */
export const CommandErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "PERMISSION_DENIED",
  "RESOURCE_UNAVAILABLE",
  "POLICY_CONFIRMATION_REQUIRED",
  "POLICY_STEP_UP_REQUIRED",
  "POLICY_APPROVAL_REQUIRED",
  "POLICY_DENIED",
  "INVARIANT_FAILED",
  "TRANSACTION_FAILED",
  "EVENT_DISPATCH_FAILED",
  "IDEMPOTENCY_REPLAY_UNSUPPORTED",
  "IDEMPOTENCY_CONFLICT",
]);

export type CommandErrorCode = z.infer<typeof CommandErrorCodeSchema>;

const PublicErrorMessages = {
  VALIDATION_FAILED: "Request validation failed",
  PERMISSION_DENIED: "Permission denied",
  RESOURCE_UNAVAILABLE: "Resource is unavailable",
  POLICY_CONFIRMATION_REQUIRED: "Confirmation is required",
  POLICY_STEP_UP_REQUIRED: "Step-up verification is required",
  POLICY_APPROVAL_REQUIRED: "Approval is required",
  POLICY_DENIED: "Policy denied this command",
  INVARIANT_FAILED: "Command invariant failed",
  TRANSACTION_FAILED: "Command transaction failed",
  EVENT_DISPATCH_FAILED: "Command event dispatch failed",
  IDEMPOTENCY_REPLAY_UNSUPPORTED: "This command cannot be replayed",
  IDEMPOTENCY_CONFLICT: "Idempotency key conflicts with an existing request",
} as const satisfies Record<CommandErrorCode, string>;

const ErrorDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), path: JsonPointerSchema }).strict(),
  z
    .object({
      kind: z.literal("reason"),
      reason: z.enum(["constraint", "unavailable", "retry_later", "idempotency_conflict"]),
    })
    .strict(),
  z.object({ kind: z.literal("confirmation"), confirm_ref: ConfirmReferenceSchema }).strict(),
  z.object({ kind: z.literal("step_up"), methods: z.array(z.enum(["pin", "qr"])).min(1) }).strict(),
  z.object({ kind: z.literal("approval"), approval_ref: z.uuid() }).strict(),
]);

export type CommandErrorDetail = Readonly<z.output<typeof ErrorDetailSchema>>;

const createErrorSchema = <TCode extends CommandErrorCode, TMessage extends string>(
  code: TCode,
  message: TMessage,
) =>
  z
    .object({
      code: z.literal(code),
      message: z.literal(message),
      detail: ErrorDetailSchema.optional(),
    })
    .strict();

/**
 * Error output is strict and uses code-owned public messages. The only optional detail values are
 * structural field paths, fixed reasons, or opaque references: raw args and arbitrary metadata are
 * deliberately unrepresentable so C1/C3 cannot leak PII or secret input to logs, audit, or tools.
 */
export const CommandErrorSchema = z.discriminatedUnion("code", [
  createErrorSchema("VALIDATION_FAILED", PublicErrorMessages.VALIDATION_FAILED),
  createErrorSchema("PERMISSION_DENIED", PublicErrorMessages.PERMISSION_DENIED),
  createErrorSchema("RESOURCE_UNAVAILABLE", PublicErrorMessages.RESOURCE_UNAVAILABLE),
  createErrorSchema(
    "POLICY_CONFIRMATION_REQUIRED",
    PublicErrorMessages.POLICY_CONFIRMATION_REQUIRED,
  ),
  createErrorSchema("POLICY_STEP_UP_REQUIRED", PublicErrorMessages.POLICY_STEP_UP_REQUIRED),
  createErrorSchema("POLICY_APPROVAL_REQUIRED", PublicErrorMessages.POLICY_APPROVAL_REQUIRED),
  createErrorSchema("POLICY_DENIED", PublicErrorMessages.POLICY_DENIED),
  createErrorSchema("INVARIANT_FAILED", PublicErrorMessages.INVARIANT_FAILED),
  createErrorSchema("TRANSACTION_FAILED", PublicErrorMessages.TRANSACTION_FAILED),
  createErrorSchema("EVENT_DISPATCH_FAILED", PublicErrorMessages.EVENT_DISPATCH_FAILED),
  createErrorSchema(
    "IDEMPOTENCY_REPLAY_UNSUPPORTED",
    PublicErrorMessages.IDEMPOTENCY_REPLAY_UNSUPPORTED,
  ),
  createErrorSchema("IDEMPOTENCY_CONFLICT", PublicErrorMessages.IDEMPOTENCY_CONFLICT),
]);

export type CommandError = Readonly<z.output<typeof CommandErrorSchema>>;

/** Builds a non-leaking command error after C1/C3 applied A1 redaction and audit disposition. */
export const createCommandError = <TCode extends CommandErrorCode>(
  code: TCode,
  detail?: CommandErrorDetail,
): Extract<CommandError, Readonly<{ code: TCode }>> => {
  const error = {
    code,
    message: PublicErrorMessages[code],
    ...(detail === undefined ? {} : { detail }),
  };
  return CommandErrorSchema.parse(error) as Extract<CommandError, Readonly<{ code: TCode }>>;
};

const CommandSuccessDataSchema = z.discriminatedUnion("execution", [
  z.object({ execution: z.literal("preview"), result: z.json() }).strict(),
  z.object({ execution: z.literal("executed"), result: z.json() }).strict(),
]);

const CommandSuccessResponseSchema = z
  .object({ ok: z.literal(true), data: CommandSuccessDataSchema })
  .strict();

const CommandFailureResponseSchema = z
  .object({ ok: z.literal(false), error: CommandErrorSchema })
  .strict();

/**
 * C1 response contract. `execution: "preview"` is the sole success shape for `dry_run`; callers
 * must not infer a commit from a successful preflight response.
 */
export const CommandResponseSchema = z.discriminatedUnion("ok", [
  CommandSuccessResponseSchema,
  CommandFailureResponseSchema,
]);

export type CommandResponse = Readonly<z.output<typeof CommandResponseSchema>>;
