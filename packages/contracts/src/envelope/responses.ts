import { z } from "zod";

import { JsonPointerSchema } from "../registry/primitives.js";
import {
  FactoryHandoffConfirmationSummarySchema,
  FulfillmentOperationConfirmationSummarySchema,
} from "./fulfillment-confirmation.js";
import {
  MarketingAudienceFreezeConfirmationSummarySchema,
  MarketingCampaignSetConfirmationSummarySchema,
  type MarketingAudienceFreezeConfirmationSummary,
  type MarketingCampaignSetConfirmationSummary,
} from "./marketing-campaign-confirmation.js";
import {
  MarketingCouponIssueConfirmationSummarySchema,
  MarketingCouponReversalConfirmationSummarySchema,
} from "./marketing-confirmation.js";
import {
  MarketingGroupBuyRedemptionConfirmationSummarySchema,
  MarketingGroupBuyRegistrationConfirmationSummarySchema,
  MarketingReferralRewardConfirmationSummarySchema,
} from "./marketing-extension-confirmation.js";
import { ConfirmReferenceSchema } from "./wire-payload.js";

/** Architecture §6.5: externally safe outcomes for each C1 validation-chain stage. */
export const CommandErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "CUSTOMER_ERASED",
  "SHIFT_CLOSED",
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
  "REPLAY_ARBITRATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "CSRF_REJECTED",
  "RATE_LIMITED",
]);

export type CommandErrorCode = z.infer<typeof CommandErrorCodeSchema>;

const PublicErrorMessages = {
  VALIDATION_FAILED: "Request validation failed",
  CUSTOMER_ERASED: "Customer data was erased and cannot be recreated",
  SHIFT_CLOSED: "Business day is already closed",
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
  REPLAY_ARBITRATION_REQUIRED: "Offline replay requires reconciliation",
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

const ConfirmationCentsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MemberTopupMatchedRuleSchema = z
  .object({
    rule_id: z.uuid(),
    min_topup_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    bonus_cents: ConfirmationCentsSchema,
  })
  .strict();

/**
 * Public, money-only WYSIWYS summary for ADR-22 member top-up confirmation.
 *
 * It deliberately contains no customer/account identity or caller arguments.
 * The server owns every number and binds the same snapshot to the pending card.
 */
export const MemberTopupConfirmationSummarySchema = z
  .object({
    kind: z.literal("member_topup"),
    principal_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    bonus_cents: ConfirmationCentsSchema,
    credited_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    matched_rule: MemberTopupMatchedRuleSchema.nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.credited_cents !== summary.principal_cents + summary.bonus_cents) {
      context.addIssue({
        code: "custom",
        path: ["credited_cents"],
        message: "credited total must equal principal plus bonus",
      });
    }
    if (summary.matched_rule === null) {
      if (summary.bonus_cents !== 0) {
        context.addIssue({
          code: "custom",
          path: ["bonus_cents"],
          message: "an unmatched top-up cannot grant a bonus",
        });
      }
      return;
    }
    if (summary.matched_rule.bonus_cents !== summary.bonus_cents) {
      context.addIssue({
        code: "custom",
        path: ["matched_rule", "bonus_cents"],
        message: "matched rule bonus must equal the frozen bonus",
      });
    }
    if (summary.matched_rule.min_topup_cents > summary.principal_cents) {
      context.addIssue({
        code: "custom",
        path: ["matched_rule", "min_topup_cents"],
        message: "matched rule threshold exceeds the top-up principal",
      });
    }
  });

export const NotificationDeliveryConfirmationSummarySchema = z
  .object({
    kind: z.literal("notification_delivery_batch"),
    order_count: z.number().int().min(1).max(50),
    risk_window_order_count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    ticket_nos: z.array(z.string().min(1).max(64)).min(1).max(50),
    channel: z.literal("sms"),
    assurance: z.enum(["software_only", "external"]),
    provider_code: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
    template_code: z.literal("pickup_reminder_v1"),
    template_version: z.number().int().positive().max(1_000_000),
    estimated_cost_cents: ConfirmationCentsSchema.max(100_000),
    max_cost_cents: ConfirmationCentsSchema.max(100_000),
    min_age_days: z.union([z.literal(30), z.literal(90), z.literal(180)]),
    unpaid_only: z.boolean(),
    garment_statuses: z
      .array(z.enum(["ready", "racked"]))
      .min(1)
      .max(2)
      .refine((statuses) => new Set(statuses).size === statuses.length),
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.estimated_cost_cents > summary.max_cost_cents) {
      context.addIssue({
        code: "custom",
        path: ["max_cost_cents"],
        message: "cost limit must cover the frozen estimate",
      });
    }
    if (summary.ticket_nos.length !== summary.order_count) {
      context.addIssue({
        code: "custom",
        path: ["ticket_nos"],
        message: "ticket count must equal the frozen order count",
      });
    }
    if (summary.risk_window_order_count < summary.order_count) {
      context.addIssue({
        code: "custom",
        path: ["risk_window_order_count"],
        message: "risk window cannot contain fewer orders than this request",
      });
    }
  });

const ConfirmationSummarySchema = z.union([
  MemberTopupConfirmationSummarySchema,
  NotificationDeliveryConfirmationSummarySchema,
  MarketingCampaignSetConfirmationSummarySchema,
  MarketingAudienceFreezeConfirmationSummarySchema,
  FactoryHandoffConfirmationSummarySchema,
  FulfillmentOperationConfirmationSummarySchema,
  MarketingCouponIssueConfirmationSummarySchema,
  MarketingCouponReversalConfirmationSummarySchema,
  MarketingReferralRewardConfirmationSummarySchema,
  MarketingGroupBuyRegistrationConfirmationSummarySchema,
  MarketingGroupBuyRedemptionConfirmationSummarySchema,
]);

const ErrorDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), path: JsonPointerSchema }).strict(),
  z
    .object({
      kind: z.literal("reason"),
      reason: z.enum(["constraint", "unavailable", "retry_later", "idempotency_conflict"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirmation"),
      confirm_ref: ConfirmReferenceSchema,
      summary: ConfirmationSummarySchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("step_up"), methods: z.array(z.enum(["pin", "qr"])).min(1) }).strict(),
  z.object({ kind: z.literal("approval"), approval_ref: z.uuid() }).strict(),
]);

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type CommandErrorDetail = DeepReadonly<z.output<typeof ErrorDetailSchema>>;
export type MemberTopupConfirmationSummary = DeepReadonly<
  z.output<typeof MemberTopupConfirmationSummarySchema>
>;
export type NotificationDeliveryConfirmationSummary = DeepReadonly<
  z.output<typeof NotificationDeliveryConfirmationSummarySchema>
>;
export type ConfirmationSummary = DeepReadonly<z.output<typeof ConfirmationSummarySchema>>;

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
  createErrorSchema("CUSTOMER_ERASED", PublicErrorMessages.CUSTOMER_ERASED),
  createErrorSchema("SHIFT_CLOSED", PublicErrorMessages.SHIFT_CLOSED),
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
  createErrorSchema("REPLAY_ARBITRATION_REQUIRED", PublicErrorMessages.REPLAY_ARBITRATION_REQUIRED),
  createFixedAuthErrorSchema("AUTHENTICATION_FAILED", PublicErrorMessages.AUTHENTICATION_FAILED),
  createFixedAuthErrorSchema("CSRF_REJECTED", PublicErrorMessages.CSRF_REJECTED),
  createFixedAuthErrorSchema("RATE_LIMITED", PublicErrorMessages.RATE_LIMITED),
]);

export type CommandError = DeepReadonly<z.output<typeof CommandErrorSchema>>;

type DetailedCommandErrorCode = Exclude<CommandErrorCode, AuthPublicErrorCode>;

const freezeCommandError = (error: CommandError): CommandError => {
  if (!("detail" in error) || error.detail === undefined) return Object.freeze(error);
  const detail = (() => {
    if (error.detail.kind === "step_up") {
      return { ...error.detail, methods: [...error.detail.methods] };
    }
    if (error.detail.kind === "confirmation" && error.detail.summary !== undefined) {
      if (error.detail.summary.kind === "notification_delivery_batch") {
        return {
          ...error.detail,
          summary: Object.freeze({
            ...error.detail.summary,
            ticket_nos: Object.freeze([...error.detail.summary.ticket_nos]),
            garment_statuses: Object.freeze([...error.detail.summary.garment_statuses]),
          }),
        };
      }
      if (error.detail.summary.kind === "member_topup") {
        const matchedRule =
          error.detail.summary.matched_rule === null
            ? null
            : Object.freeze({ ...error.detail.summary.matched_rule });
        return {
          ...error.detail,
          summary: Object.freeze({ ...error.detail.summary, matched_rule: matchedRule }),
        };
      }
      if (error.detail.summary.kind === "factory_handoff") {
        return {
          ...error.detail,
          summary: Object.freeze({
            ...error.detail.summary,
            ticket_nos: Object.freeze([...error.detail.summary.ticket_nos]),
            barcodes: Object.freeze([...error.detail.summary.barcodes]),
            counts: Object.freeze({ ...error.detail.summary.counts }),
          }),
        };
      }
      if (error.detail.summary.kind === "fulfillment_operation") {
        return {
          ...error.detail,
          summary: Object.freeze({
            ...error.detail.summary,
            garment_ids: Object.freeze([...error.detail.summary.garment_ids]),
            ticket_nos: Object.freeze([...error.detail.summary.ticket_nos]),
            barcodes: Object.freeze([...error.detail.summary.barcodes]),
          }),
        };
      }
      if (
        error.detail.summary.kind === "marketing_coupon_issue" ||
        error.detail.summary.kind === "marketing_coupon_redemption_reversal" ||
        error.detail.summary.kind === "marketing_referral_reward" ||
        error.detail.summary.kind === "marketing_group_buy_registration" ||
        error.detail.summary.kind === "marketing_group_buy_redemption"
      ) {
        return {
          ...error.detail,
          summary: Object.freeze({ ...error.detail.summary }),
        };
      }
      return {
        ...error.detail,
        summary: Object.freeze({ ...error.detail.summary }),
      };
    }
    return { ...error.detail };
  })();
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
