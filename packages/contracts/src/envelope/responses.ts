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
  "AUTHENTICATION_FAILED",
  "CSRF_REJECTED",
  "RATE_LIMITED",
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
  AUTHENTICATION_FAILED: "Authentication failed",
  CSRF_REJECTED: "Request origin verification failed",
  RATE_LIMITED: "Too many requests",
} as const satisfies Record<CommandErrorCode, string>;

export const AUTH_PUBLIC_ERROR_DESCRIPTORS = Object.freeze({
  AUTHENTICATION_FAILED: Object.freeze({
    code: "AUTHENTICATION_FAILED" as const,
    message: PublicErrorMessages.AUTHENTICATION_FAILED,
    http_status: 401 as const,
  }),
  CSRF_REJECTED: Object.freeze({
    code: "CSRF_REJECTED" as const,
    message: PublicErrorMessages.CSRF_REJECTED,
    http_status: 403 as const,
  }),
  RATE_LIMITED: Object.freeze({
    code: "RATE_LIMITED" as const,
    message: PublicErrorMessages.RATE_LIMITED,
    http_status: 429 as const,
  }),
});

export type AuthPublicErrorDescriptor =
  (typeof AUTH_PUBLIC_ERROR_DESCRIPTORS)[keyof typeof AUTH_PUBLIC_ERROR_DESCRIPTORS];
export type AuthPublicErrorCode = keyof typeof AUTH_PUBLIC_ERROR_DESCRIPTORS;

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

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type CommandErrorDetail = DeepReadonly<z.output<typeof ErrorDetailSchema>>;

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

const createFixedAuthErrorSchema = <TCode extends AuthPublicErrorCode, TMessage extends string>(
  code: TCode,
  message: TMessage,
) => z.strictObject({ code: z.literal(code), message: z.literal(message) });

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
  createFixedAuthErrorSchema("AUTHENTICATION_FAILED", PublicErrorMessages.AUTHENTICATION_FAILED),
  createFixedAuthErrorSchema("CSRF_REJECTED", PublicErrorMessages.CSRF_REJECTED),
  createFixedAuthErrorSchema("RATE_LIMITED", PublicErrorMessages.RATE_LIMITED),
]);

export type CommandError = DeepReadonly<z.output<typeof CommandErrorSchema>>;

type DetailedCommandErrorCode = Exclude<CommandErrorCode, AuthPublicErrorCode>;

const freezeCommandError = (error: CommandError): CommandError => {
  if (!("detail" in error) || error.detail === undefined) return Object.freeze(error);
  const detail =
    error.detail.kind === "step_up"
      ? { ...error.detail, methods: [...error.detail.methods] }
      : { ...error.detail };
  if (detail.kind === "step_up") Object.freeze(detail.methods);
  return Object.freeze({ ...error, detail: Object.freeze(detail) });
};

/** Builds one fixed auth error or a redacted A2 command error. Auth errors never accept detail. */
export function createCommandError<TCode extends CommandErrorCode>(
  code: TCode,
): Extract<CommandError, Readonly<{ code: TCode }>>;
export function createCommandError<TCode extends DetailedCommandErrorCode>(
  code: TCode,
  detail: CommandErrorDetail,
): Extract<CommandError, Readonly<{ code: TCode }>>;
export function createCommandError(
  code: CommandErrorCode,
  detail?: CommandErrorDetail,
): CommandError {
  if (code in AUTH_PUBLIC_ERROR_DESCRIPTORS && detail !== undefined) {
    throw new TypeError("Fixed auth errors must not include detail");
  }
  const error = {
    code,
    message: PublicErrorMessages[code],
    ...(detail === undefined ? {} : { detail }),
  };
  return freezeCommandError(CommandErrorSchema.parse(error));
}

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

export type CommandResponse = DeepReadonly<z.output<typeof CommandResponseSchema>>;
