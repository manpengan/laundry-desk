import { z } from "zod";

import { defineCommand, type CommandDefinition } from "../registry/definitions.js";

const PositiveCentsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PaymentMethodSchema = z.enum(["cash", "wechat", "alipay", "other"]);

const PaymentInputBaseSchema = z.strictObject({
  order_id: z.uuid(),
  amount_cents: PositiveCentsSchema,
  method: PaymentMethodSchema,
  note: z.string().max(256).optional(),
});

export const PaymentCollectInputSchema = PaymentInputBaseSchema;
export const PaymentRepayInputSchema = PaymentInputBaseSchema;
export const PaymentRefundInputSchema = PaymentInputBaseSchema.extend({
  ref_payment_id: z.uuid(),
  reason: z.string().min(1).max(256),
});

type CollectInput = typeof PaymentCollectInputSchema;
type RepayInput = typeof PaymentRepayInputSchema;
type RefundInput = typeof PaymentRefundInputSchema;

const paymentLimits = Object.freeze({ max_amount_cents: 5_000_000 });
const paymentMeasure = Object.freeze({ amount: { kind: "field" as const, path: "/amount_cents" } });

export const paymentCollectCommand: CommandDefinition<CollectInput> = defineCommand({
  name: "payment.collect",
  version: "0.2.0",
  description: "Append a counter collection payment to an order ledger.",
  description_llm:
    "Collect a positive integer-fen payment. Offline collection requires the store Primary lease.",
  input: PaymentCollectInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write", "payment.collect_allowed", "payment.append_only"],
  idempotent: true,
  sideEffects: ["payment.collected", "audit.payment_event"],
  offline_mode: "primary_lease",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: paymentMeasure,
  hard_limits: paymentLimits,
});

export const paymentRepayCommand: CommandDefinition<RepayInput> = defineCommand({
  name: "payment.repay",
  version: "0.2.0",
  description: "Append a repayment for an order with outstanding debt.",
  description_llm:
    "Record a positive integer-fen debt repayment. The payment ledger is append-only.",
  input: PaymentRepayInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write", "payment.debt_exists", "payment.append_only"],
  idempotent: true,
  sideEffects: ["payment.repaid", "audit.payment_event"],
  offline_mode: "primary_lease",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: paymentMeasure,
  hard_limits: paymentLimits,
});

export const paymentRefundCommand: CommandDefinition<RefundInput> = defineCommand({
  name: "payment.refund",
  version: "0.2.0",
  description: "Append an online-only R4 refund referencing an original payment.",
  description_llm:
    "Refund only online with step-up approval. Reference the original payment and provide a reason; never mutate the original ledger row.",
  input: PaymentRefundInputSchema,
  risk: "R4",
  invariants: ["rbac.payment_refund", "payment.original_exists", "payment.append_only"],
  idempotent: true,
  sideEffects: ["payment.refunded", "audit.payment_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: paymentMeasure,
  hard_limits: paymentLimits,
});

export const PAYMENT_COMMANDS = Object.freeze([
  paymentCollectCommand,
  paymentRepayCommand,
  paymentRefundCommand,
] as const);

export const PAYMENT_COMMAND_NAMES = Object.freeze(
  PAYMENT_COMMANDS.map((command) => command.name),
) as readonly ["payment.collect", "payment.repay", "payment.refund"];
