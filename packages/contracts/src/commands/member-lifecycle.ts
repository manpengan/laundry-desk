import { z } from "zod";

import { defineCommand, type CommandDefinition } from "../registry/definitions.js";
import { MemberTopupMethodSchema } from "./member.js";

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SignedSafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const ClosePrincipalCentsSchema = z.number().int().nonnegative().max(5_000_000);
const LifecycleReasonSchema = z.string().trim().min(1).max(256);

/** ADR-25 account states. `closed` is terminal in the active delivery line. */
export const MemberAccountStatusSchema = z.enum(["active", "frozen", "closed"]);

/** Financial rows returned by `member.account.get`, including ADR-25 forfeiture. */
export const MemberLedgerKindSchema = z.enum([
  "topup",
  "pay",
  "reversal",
  "refund",
  "bonus_forfeit",
]);

const MemberLifecycleInputShape = {
  account_id: z.uuid(),
  expected_customer_id: z.uuid(),
  expected_status_version: PositiveSafeIntegerSchema,
  reason: LifecycleReasonSchema,
};

export const MemberAccountFreezeInputSchema = z.strictObject(MemberLifecycleInputShape);

export const MemberAccountUnfreezeInputSchema = z.strictObject(MemberLifecycleInputShape);

export const MemberAccountCloseInputSchema = z
  .strictObject({
    ...MemberLifecycleInputShape,
    expected_status: z.enum(["active", "frozen"]),
    expected_principal_cents: ClosePrincipalCentsSchema,
    expected_bonus_cents: NonNegativeSafeIntegerSchema,
    refund_tender: MemberTopupMethodSchema.nullable(),
  })
  .superRefine((input, context) => {
    if (input.expected_principal_cents > 0 && input.refund_tender === null) {
      context.addIssue({
        code: "custom",
        message: "A positive principal requires a refund tender",
        path: ["refund_tender"],
      });
    }
    if (input.expected_principal_cents === 0 && input.refund_tender !== null) {
      context.addIssue({
        code: "custom",
        message: "A zero principal must not carry a refund tender",
        path: ["refund_tender"],
      });
    }
  });

/**
 * Exact account result shape added to the existing `member.account.get` query.
 *
 * This is exported separately because the registry currently owns query input
 * metadata only. Server and clients still share one strict Zod authority for
 * the lifecycle fields instead of accepting arbitrary status strings.
 */
export const MemberAccountGetAccountSchema = z
  .strictObject({
    account_id: z.uuid(),
    customer_id: z.uuid(),
    status: MemberAccountStatusSchema,
    status_version: PositiveSafeIntegerSchema,
    status_changed_at: PositiveSafeIntegerSchema.nullable(),
    status_reason: LifecycleReasonSchema.nullable(),
    principal_cents: NonNegativeSafeIntegerSchema,
    bonus_cents: NonNegativeSafeIntegerSchema,
    balance_cents: NonNegativeSafeIntegerSchema,
  })
  .superRefine((account, context) => {
    if ((account.status_changed_at === null) !== (account.status_reason === null)) {
      context.addIssue({
        code: "custom",
        message: "Member status change time and reason must be present together",
        path: ["status_reason"],
      });
    }
    const total = account.principal_cents + account.bonus_cents;
    if (!Number.isSafeInteger(total) || total !== account.balance_cents) {
      context.addIssue({
        code: "custom",
        message: "Member balance must equal principal plus bonus",
        path: ["balance_cents"],
      });
    }
    if (account.status === "closed" && account.balance_cents !== 0) {
      context.addIssue({
        code: "custom",
        message: "A closed member account must have zero balance",
        path: ["balance_cents"],
      });
    }
  });

export const MemberAccountGetLedgerRowSchema = z
  .strictObject({
    ledger_id: z.uuid(),
    kind: MemberLedgerKindSchema,
    principal_delta_cents: SignedSafeIntegerSchema,
    bonus_delta_cents: SignedSafeIntegerSchema,
    order_id: z.uuid().nullable(),
    store_id: z.uuid(),
    tender: MemberTopupMethodSchema.nullable(),
    bonus_rule_id: z.uuid().nullable(),
    at: PositiveSafeIntegerSchema,
    business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    note: z.string().max(256).nullable(),
  })
  .superRefine((row, context) => {
    if (
      row.kind === "bonus_forfeit" &&
      (row.principal_delta_cents !== 0 ||
        row.bonus_delta_cents >= 0 ||
        row.order_id !== null ||
        row.tender !== null ||
        row.bonus_rule_id !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A bonus forfeiture may only remove non-order bonus value",
        path: ["kind"],
      });
    }
  });

export const MemberAccountGetResultSchema = z
  .strictObject({
    account: MemberAccountGetAccountSchema.nullable(),
    recent: z.array(MemberAccountGetLedgerRowSchema).max(50),
  })
  .superRefine((result, context) => {
    if (result.account === null && result.recent.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A missing account cannot carry member ledger rows",
        path: ["recent"],
      });
    }
    if (new Set(result.recent.map((row) => row.ledger_id)).size !== result.recent.length) {
      context.addIssue({
        code: "custom",
        message: "Recent member ledger rows must have unique identifiers",
        path: ["recent"],
      });
    }
  });

const reasonRedaction = Object.freeze([{ path: "/reason", strategy: "mask" as const }]);
const closeAmountMeasure = Object.freeze({
  amount: { kind: "field" as const, path: "/expected_principal_cents" },
});
const closeLimits = Object.freeze({ max_amount_cents: 5_000_000 });

export const memberAccountFreezeCommand: CommandDefinition<typeof MemberAccountFreezeInputSchema> =
  defineCommand({
    name: "member.account.freeze",
    version: "1.0.0",
    description: "Freeze an active member account after a loss report.",
    description_llm:
      "Freeze the exact active member account and status version named by the operator. Freezing moves no money but blocks top-ups, stored-value spending and ordinary refunds until an authorized unfreeze or atomic closure.",
    input: MemberAccountFreezeInputSchema,
    risk: "R3",
    invariants: [
      "rbac.member_freeze",
      "member.account_identity_matches",
      "member.account_active",
      "member.account_status_version",
    ],
    idempotent: true,
    sideEffects: ["member.account_frozen", "audit.member_event"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: reasonRedaction,
    result_redaction: [],
  });

export const memberAccountUnfreezeCommand: CommandDefinition<
  typeof MemberAccountUnfreezeInputSchema
> = defineCommand({
  name: "member.account.unfreeze",
  version: "1.0.0",
  description: "Restore one frozen member account to active use.",
  description_llm:
    "Unfreeze the exact frozen member account and status version named by an authorized administrator. It moves no money and cannot reopen a closed account.",
  input: MemberAccountUnfreezeInputSchema,
  risk: "R3",
  invariants: [
    "rbac.member_lifecycle_manage",
    "member.account_identity_matches",
    "member.account_frozen",
    "member.account_status_version",
  ],
  idempotent: true,
  sideEffects: ["member.account_unfrozen", "audit.member_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: reasonRedaction,
  result_redaction: [],
});

export const memberAccountCloseCommand: CommandDefinition<typeof MemberAccountCloseInputSchema> =
  defineCommand({
    name: "member.account.close",
    version: "1.0.0",
    description: "Atomically settle and permanently close one member account.",
    description_llm:
      "Close one active or frozen account after another administrator approves the exact status version, remaining principal, remaining bonus and refund tender. The transaction refunds all principal, appends a bonus_forfeit row for all remaining bonus, closes the account and leaves its projected balance at zero.",
    input: MemberAccountCloseInputSchema,
    risk: "R4",
    invariants: [
      "rbac.member_lifecycle_manage",
      "rbac.member_refund",
      "member.account_identity_matches",
      "member.account_closable",
      "member.account_status_version",
      "member.close_snapshot_matches",
      "member.ledger_append_only",
    ],
    idempotent: true,
    sideEffects: [
      "member.account_closed",
      "member.principal_refunded",
      "member.bonus_forfeited",
      "audit.member_event",
    ],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: reasonRedaction,
    result_redaction: [],
    size_measures: closeAmountMeasure,
    hard_limits: closeLimits,
  });

export const MEMBER_LIFECYCLE_COMMANDS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  memberAccountFreezeCommand,
  memberAccountUnfreezeCommand,
  memberAccountCloseCommand,
]);

export const MEMBER_LIFECYCLE_COMMAND_NAMES = Object.freeze([
  "member.account.freeze",
  "member.account.unfreeze",
  "member.account.close",
] as const);
