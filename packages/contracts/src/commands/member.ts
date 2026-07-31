import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const PositiveCentsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Tenders accepted for a top-up. `balance` is deliberately absent: stored value
 * cannot fund itself. */
export const MemberTopupMethodSchema = z.enum(["cash", "wechat", "alipay", "other"]);

export const MemberAccountOpenInputSchema = z.strictObject({
  customer_id: z.uuid(),
  note: z.string().max(256).optional(),
});

export const MemberTopupInputSchema = z.strictObject({
  account_id: z.uuid(),
  amount_cents: PositiveCentsSchema,
  method: MemberTopupMethodSchema,
  note: z.string().max(256).optional(),
});

export const MemberBalancePayInputSchema = z.strictObject({
  account_id: z.uuid(),
  order_id: z.uuid(),
  amount_cents: PositiveCentsSchema,
  note: z.string().max(256).optional(),
});

export const MemberAccountGetInputSchema = z.strictObject({
  customer_id: z.uuid(),
});

const amountMeasure = Object.freeze({
  amount: { kind: "field" as const, path: "/amount_cents" },
});
// Same ceiling as payment: one counter movement never legitimately exceeds it.
const memberLimits = Object.freeze({ max_amount_cents: 5_000_000 });

export const memberAccountOpenCommand: CommandDefinition<typeof MemberAccountOpenInputSchema> =
  defineCommand({
    name: "member.account.open",
    version: "1.0.0",
    description: "Open the stored-value account for a customer.",
    description_llm:
      "Open a member account for an existing customer. One account per customer, so repeating the call returns the existing account instead of creating a second one.",
    input: MemberAccountOpenInputSchema,
    risk: "R2",
    invariants: ["rbac.customer_write", "member.customer_exists", "member.account_unique"],
    idempotent: true,
    sideEffects: ["member.account_opened", "audit.member_event"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
  });

export const memberTopupCommand: CommandDefinition<typeof MemberTopupInputSchema> = defineCommand({
  name: "member.topup",
  version: "1.0.0",
  description: "Append a stored-value top-up to the member ledger.",
  description_llm:
    "Record money the customer prepaid, in integer fen. The ledger is append-only and the balance is its sum, so a mistake is corrected with a reversal rather than an edit.",
  input: MemberTopupInputSchema,
  // Real money enters the account and the ledger cannot be edited afterwards.
  risk: "R3",
  invariants: ["rbac.customer_write", "member.account_active", "member.ledger_append_only"],
  idempotent: true,
  sideEffects: ["member.topped_up", "audit.member_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: amountMeasure,
  hard_limits: memberLimits,
});

export const memberBalancePayCommand: CommandDefinition<typeof MemberBalancePayInputSchema> =
  defineCommand({
    name: "member.balance.pay",
    version: "1.0.0",
    description: "Settle part of an order from the member stored-value balance.",
    description_llm:
      "Spend stored value on an order. The server locks the account, re-reads the balance under that lock and refuses to overdraw; the same transaction writes both the ledger debit and the order payment.",
    input: MemberBalancePayInputSchema,
    risk: "R2",
    invariants: [
      "rbac.order_write",
      "member.account_active",
      "member.balance_sufficient",
      "payment.append_only",
    ],
    idempotent: true,
    sideEffects: ["member.balance_spent", "payment.collected", "audit.member_event"],
    // No authoritative org-wide balance offline: two devices would both spend
    // the same money and neither could be made whole (ADR-17 §8).
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    size_measures: amountMeasure,
    hard_limits: memberLimits,
  });

export const memberAccountGetQuery: QueryDefinition<typeof MemberAccountGetInputSchema> =
  defineQuery({
    name: "member.account.get",
    version: "1.0.0",
    description: "Read a customer's stored-value balance and recent ledger rows.",
    description_llm:
      "Return the member balance split into principal and bonus, plus the most recent ledger movements. The balance is summed from the ledger, never read from a stored column.",
    input: MemberAccountGetInputSchema,
    risk: "R1",
    invariants: [],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: 50,
  });

export const MEMBER_COMMANDS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  memberAccountOpenCommand,
  memberTopupCommand,
  memberBalancePayCommand,
]);

export const MEMBER_QUERIES: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  memberAccountGetQuery,
]);

export const MEMBER_DEFINITIONS = Object.freeze([...MEMBER_COMMANDS, ...MEMBER_QUERIES]);
export const MEMBER_COMMAND_NAMES = Object.freeze([
  "member.account.open",
  "member.topup",
  "member.balance.pay",
] as const);
export const MEMBER_QUERY_NAMES = Object.freeze(["member.account.get"] as const);
