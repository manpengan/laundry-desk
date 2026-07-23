/**
 * Append-only order payment ledger planners (ADR-03).
 * Amounts are always positive; refunds and reversals derive their sign from kind.
 */

import { derivePaymentLedger as deriveLedger } from "./payment-ledger.js";
import type { PaymentLedgerRejectReason, PaymentLedgerResult } from "./payment-ledger.js";

export {
  activeReversalTargets,
  derivePaymentLedger,
  type ActiveReversalTargetsResult,
  type PaymentLedgerRejectReason,
  type PaymentLedgerResult,
} from "./payment-ledger.js";

export const PAYMENT_KINDS = Object.freeze([
  "pay",
  "repay",
  "refund",
  "storage_fee",
  "reversal",
] as const);

export const PAYMENT_METHODS = Object.freeze(["cash", "wechat", "alipay", "other"] as const);

export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type PaymentRow = Readonly<{
  payment_id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  method: PaymentMethod;
  amount_cents: number;
  kind: PaymentKind;
  ref_payment_id: string | null;
  staff_id: string;
  at: number;
  note: string | null;
}>;

export type BuildPayPaymentInput = Readonly<{
  payment_id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  amount_cents: number;
  staff_id: string;
  at: number;
  method?: PaymentMethod;
  note?: string | null;
}>;

export type BuildRefundPaymentInput = BuildPayPaymentInput &
  Readonly<{ ref_payment_id: string; reason: string }>;
export type BuildReversalPaymentInput = BuildPayPaymentInput &
  Readonly<{ ref_payment_id: string; reason: string }>;

export type PaymentPlanRejectReason =
  | PaymentLedgerRejectReason
  | "INVALID_REASON"
  | "NO_OUTSTANDING_BALANCE"
  | "AMOUNT_EXCEEDS_BALANCE";

export type PaymentPlanResult =
  | Readonly<{ ok: true; payment: PaymentRow; paid_cents: number; balance_cents: number }>
  | Readonly<{ ok: false; reason: PaymentPlanRejectReason }>;

export type PaymentPlanBaseInput = BuildPayPaymentInput &
  Readonly<{
    payable_cents: number;
    existing_payments: readonly PaymentRow[];
  }>;

export type RefundPaymentPlanInput = PaymentPlanBaseInput &
  Readonly<{ ref_payment_id: string; reason: string }>;
export type ReversalPaymentPlanInput = PaymentPlanBaseInput &
  Readonly<{ ref_payment_id: string; reason: string }>;

const isPaymentMethod = (value: string): value is PaymentMethod =>
  (PAYMENT_METHODS as readonly string[]).includes(value);

const isPositiveSafeCents = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const hasText = (value: string): boolean => value.trim().length > 0;

function planFailure(reason: PaymentPlanRejectReason): PaymentPlanResult {
  return Object.freeze({ ok: false, reason });
}

function assertBuildInput(input: BuildPayPaymentInput): void {
  if (!isPositiveSafeCents(input.amount_cents)) {
    throw new TypeError(
      `payment amount_cents must be a positive safe integer, got: ${input.amount_cents}`,
    );
  }
  if (!Number.isSafeInteger(input.at) || input.at < 0) {
    throw new TypeError(`payment at must be a non-negative safe integer, got: ${input.at}`);
  }
  if (
    ![input.payment_id, input.org_id, input.store_id, input.order_id, input.staff_id].every(hasText)
  ) {
    throw new TypeError("payment identifiers must be non-empty strings");
  }
  if (!isPaymentMethod(input.method ?? "cash")) {
    throw new TypeError(`unsupported payment method: ${input.method}`);
  }
}

function buildPayment(
  input: BuildPayPaymentInput,
  kind: "pay" | "repay" | "refund" | "reversal",
  refPaymentId: string | null,
  note: string | null,
): PaymentRow {
  assertBuildInput(input);
  if (
    (kind === "refund" || kind === "reversal") &&
    (refPaymentId === null || !hasText(refPaymentId))
  ) {
    throw new TypeError(`${kind} requires ref_payment_id`);
  }
  return Object.freeze({
    payment_id: input.payment_id,
    org_id: input.org_id,
    store_id: input.store_id,
    order_id: input.order_id,
    method: input.method ?? "cash",
    amount_cents: input.amount_cents,
    kind,
    ref_payment_id: refPaymentId,
    staff_id: input.staff_id,
    at: input.at,
    note,
  });
}

/** Build a kind=pay collection row; kept for the existing receive/pickup stores. */
export function buildPayPayment(input: BuildPayPaymentInput): PaymentRow {
  return buildPayment(input, "pay", null, input.note ?? null);
}

export function buildRepayPayment(input: BuildPayPaymentInput): PaymentRow {
  return buildPayment(input, "repay", null, input.note ?? null);
}

function reasonOrThrow(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > 256)
    throw new TypeError("payment reason is required");
  return trimmed;
}

export function buildRefundPayment(input: BuildRefundPaymentInput): PaymentRow {
  return buildPayment(input, "refund", input.ref_payment_id, reasonOrThrow(input.reason));
}

export function buildReversalPayment(input: BuildReversalPaymentInput): PaymentRow {
  return buildPayment(input, "reversal", input.ref_payment_id, reasonOrThrow(input.reason));
}

function planWithCandidate(
  payableCents: number,
  existingPayments: readonly PaymentRow[],
  candidate: PaymentRow,
): PaymentPlanResult {
  const ledger = deriveLedger(payableCents, [...existingPayments, candidate]);
  return ledger.ok
    ? Object.freeze({
        ok: true,
        payment: candidate,
        paid_cents: ledger.paid_cents,
        balance_cents: ledger.balance_cents,
      })
    : planFailure(ledger.reason);
}

function currentLedger(input: PaymentPlanBaseInput): PaymentLedgerResult {
  return deriveLedger(input.payable_cents, input.existing_payments);
}

function candidateOrFailure(
  build: () => PaymentRow,
): PaymentRow | Readonly<{ ok: false; reason: "INVALID_PAYMENT" | "INVALID_REASON" }> {
  try {
    return build();
  } catch (error: unknown) {
    return Object.freeze({
      ok: false,
      reason:
        error instanceof TypeError && error.message === "payment reason is required"
          ? "INVALID_REASON"
          : "INVALID_PAYMENT",
    });
  }
}

function isCandidateFailure(
  value: PaymentRow | Readonly<{ ok: false; reason: "INVALID_PAYMENT" | "INVALID_REASON" }>,
): value is Readonly<{ ok: false; reason: "INVALID_PAYMENT" | "INVALID_REASON" }> {
  return "ok" in value;
}

function planCollection(input: PaymentPlanBaseInput, kind: "pay" | "repay"): PaymentPlanResult {
  const current = currentLedger(input);
  if (!current.ok) return planFailure(current.reason);
  if (current.balance_cents === 0) return planFailure("NO_OUTSTANDING_BALANCE");
  if (input.amount_cents > current.balance_cents) return planFailure("AMOUNT_EXCEEDS_BALANCE");
  const candidate = candidateOrFailure(() =>
    kind === "pay" ? buildPayPayment(input) : buildRepayPayment(input),
  );
  return isCandidateFailure(candidate)
    ? planFailure(candidate.reason)
    : planWithCandidate(input.payable_cents, input.existing_payments, candidate);
}

/** Plan a normal collection; it cannot overpay an order. */
export function planCollectPayment(input: PaymentPlanBaseInput): PaymentPlanResult {
  return planCollection(input, "pay");
}

/** Plan a debt repayment; it has the same hard balance cap as collection. */
export function planRepayPayment(input: PaymentPlanBaseInput): PaymentPlanResult {
  return planCollection(input, "repay");
}

export function planRefundPayment(input: RefundPaymentPlanInput): PaymentPlanResult {
  const current = currentLedger(input);
  if (!current.ok) return planFailure(current.reason);
  const candidate = candidateOrFailure(() => buildRefundPayment(input));
  return isCandidateFailure(candidate)
    ? planFailure(candidate.reason)
    : planWithCandidate(input.payable_cents, input.existing_payments, candidate);
}

export function planReversalPayment(input: ReversalPaymentPlanInput): PaymentPlanResult {
  const current = currentLedger(input);
  if (!current.ok) return planFailure(current.reason);
  const candidate = candidateOrFailure(() => buildReversalPayment(input));
  return isCandidateFailure(candidate)
    ? planFailure(candidate.reason)
    : planWithCandidate(input.payable_cents, input.existing_payments, candidate);
}
