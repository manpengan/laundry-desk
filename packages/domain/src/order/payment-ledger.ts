/** Append-only payment-ledger projection and reversal targeting. */

import type { PaymentRow } from "./payment.js";

export type PaymentLedgerRejectReason =
  | "INVALID_PAYABLE"
  | "INVALID_PAYMENT"
  | "DUPLICATE_PAYMENT_ID"
  | "MIXED_LEDGER_SCOPE"
  | "UNSUPPORTED_PAYMENT_KIND"
  | "INVALID_REFERENCE"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_NOT_REFUNDABLE"
  | "REFERENCE_NOT_REVERSIBLE"
  | "REFERENCE_ALREADY_REVERSED"
  | "REFERENCE_HAS_ACTIVE_REFUND"
  | "REFUND_EXCEEDS_ORIGINAL"
  | "REVERSAL_AMOUNT_MISMATCH"
  | "OVERPAID"
  | "NEGATIVE_PAID";

export type PaymentLedgerResult =
  | Readonly<{ ok: true; paid_cents: number; balance_cents: number }>
  | Readonly<{ ok: false; reason: PaymentLedgerRejectReason }>;

export type ActiveReversalTargetsResult =
  | Readonly<{ ok: true; targets: readonly PaymentRow[] }>
  | Readonly<{ ok: false; reason: PaymentLedgerRejectReason }>;

type PaymentState = {
  readonly row: PaymentRow;
  active: boolean;
  readonly contribution_cents: number;
};

type LedgerAnalysis =
  | Readonly<{
      ok: true;
      paid_cents: number;
      balance_cents: number;
      states: ReadonlyMap<string, PaymentState>;
    }>
  | Readonly<{ ok: false; reason: PaymentLedgerRejectReason }>;

type LedgerStep =
  | Readonly<{ ok: true; paid_cents: number }>
  | Readonly<{ ok: false; reason: PaymentLedgerRejectReason }>;

const hasText = (value: string): boolean => value.trim().length > 0;
const isPositiveSafeCents = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const isPaymentMethod = (value: string): boolean =>
  ["cash", "wechat", "alipay", "other"].includes(value);
const isPaymentKind = (value: string): boolean =>
  ["pay", "repay", "refund", "storage_fee", "reversal"].includes(value);

const failure = (reason: PaymentLedgerRejectReason): LedgerAnalysis =>
  Object.freeze({ ok: false, reason });

function validPaymentRow(row: PaymentRow): boolean {
  return (
    hasText(row.payment_id) &&
    hasText(row.org_id) &&
    hasText(row.store_id) &&
    hasText(row.order_id) &&
    hasText(row.staff_id) &&
    isPaymentMethod(row.method) &&
    isPaymentKind(row.kind) &&
    isPositiveSafeCents(row.amount_cents) &&
    Number.isSafeInteger(row.at) &&
    row.at >= 0
  );
}

function validReferenceShape(row: PaymentRow): boolean {
  if (row.kind === "pay" || row.kind === "repay" || row.kind === "storage_fee") {
    return row.ref_payment_id === null;
  }
  return row.ref_payment_id !== null && hasText(row.ref_payment_id);
}

function sameScope(left: PaymentRow, right: PaymentRow): boolean {
  return (
    left.org_id === right.org_id &&
    left.store_id === right.store_id &&
    left.order_id === right.order_id
  );
}

function nextPaid(current: number, contribution: number): number | null {
  const next = current + contribution;
  return Number.isSafeInteger(next) ? next : null;
}

function validateRow(
  row: PaymentRow,
  states: ReadonlyMap<string, PaymentState>,
): LedgerStep | null {
  if (!validPaymentRow(row)) return Object.freeze({ ok: false, reason: "INVALID_PAYMENT" });
  if (!validReferenceShape(row)) return Object.freeze({ ok: false, reason: "INVALID_REFERENCE" });
  if (states.has(row.payment_id)) {
    return Object.freeze({ ok: false, reason: "DUPLICATE_PAYMENT_ID" });
  }
  const first = [...states.values()][0];
  if (first !== undefined && !sameScope(first.row, row)) {
    return Object.freeze({ ok: false, reason: "MIXED_LEDGER_SCOPE" });
  }
  return null;
}

function appendBasePayment(
  row: PaymentRow,
  states: Map<string, PaymentState>,
  paidCents: number,
): LedgerStep {
  const paid = nextPaid(paidCents, row.amount_cents);
  if (paid === null) return Object.freeze({ ok: false, reason: "OVERPAID" });
  states.set(row.payment_id, { row, active: true, contribution_cents: row.amount_cents });
  return Object.freeze({ ok: true, paid_cents: paid });
}

function appendRefund(
  row: PaymentRow,
  states: Map<string, PaymentState>,
  refundedCents: Map<string, number>,
  paidCents: number,
): LedgerStep {
  const reference = states.get(row.ref_payment_id ?? "");
  if (reference === undefined) return Object.freeze({ ok: false, reason: "REFERENCE_NOT_FOUND" });
  if (!reference.active || (reference.row.kind !== "pay" && reference.row.kind !== "repay")) {
    return Object.freeze({ ok: false, reason: "REFERENCE_NOT_REFUNDABLE" });
  }
  const used = refundedCents.get(reference.row.payment_id) ?? 0;
  const nextUsed = used + row.amount_cents;
  if (!Number.isSafeInteger(nextUsed) || nextUsed > reference.row.amount_cents) {
    return Object.freeze({ ok: false, reason: "REFUND_EXCEEDS_ORIGINAL" });
  }
  const paid = nextPaid(paidCents, -row.amount_cents);
  if (paid === null) return Object.freeze({ ok: false, reason: "NEGATIVE_PAID" });
  refundedCents.set(reference.row.payment_id, nextUsed);
  states.set(row.payment_id, { row, active: true, contribution_cents: -row.amount_cents });
  return Object.freeze({ ok: true, paid_cents: paid });
}

function appendReversal(
  row: PaymentRow,
  states: Map<string, PaymentState>,
  refundedCents: Map<string, number>,
  paidCents: number,
): LedgerStep {
  const reference = states.get(row.ref_payment_id ?? "");
  if (reference === undefined) return Object.freeze({ ok: false, reason: "REFERENCE_NOT_FOUND" });
  if (
    !reference.active ||
    reference.row.kind === "reversal" ||
    reference.row.kind === "storage_fee"
  ) {
    return Object.freeze({ ok: false, reason: "REFERENCE_NOT_REVERSIBLE" });
  }
  if (row.amount_cents !== reference.row.amount_cents) {
    return Object.freeze({ ok: false, reason: "REVERSAL_AMOUNT_MISMATCH" });
  }
  if (
    (reference.row.kind === "pay" || reference.row.kind === "repay") &&
    (refundedCents.get(reference.row.payment_id) ?? 0) !== 0
  ) {
    return Object.freeze({ ok: false, reason: "REFERENCE_HAS_ACTIVE_REFUND" });
  }
  const paid = nextPaid(paidCents, -reference.contribution_cents);
  if (paid === null) return Object.freeze({ ok: false, reason: "NEGATIVE_PAID" });

  reference.active = false;
  if (reference.row.kind === "refund") {
    const originalId = reference.row.ref_payment_id;
    const used = refundedCents.get(originalId ?? "") ?? 0;
    refundedCents.set(originalId ?? "", used - reference.row.amount_cents);
  }
  states.set(row.payment_id, {
    row,
    active: false,
    contribution_cents: -reference.contribution_cents,
  });
  return Object.freeze({ ok: true, paid_cents: paid });
}

function appendLedgerRow(
  row: PaymentRow,
  states: Map<string, PaymentState>,
  refundedCents: Map<string, number>,
  paidCents: number,
): LedgerStep {
  const invalid = validateRow(row, states);
  if (invalid !== null) return invalid;
  if (row.kind === "storage_fee") {
    return Object.freeze({ ok: false, reason: "UNSUPPORTED_PAYMENT_KIND" });
  }
  if (row.kind === "pay" || row.kind === "repay") {
    return appendBasePayment(row, states, paidCents);
  }
  return row.kind === "refund"
    ? appendRefund(row, states, refundedCents, paidCents)
    : appendReversal(row, states, refundedCents, paidCents);
}

function analyzePaymentLedger(
  payableCents: number,
  payments: readonly PaymentRow[],
): LedgerAnalysis {
  if (!Number.isSafeInteger(payableCents) || payableCents < 0) return failure("INVALID_PAYABLE");

  const states = new Map<string, PaymentState>();
  const refundedCents = new Map<string, number>();
  let paidCents = 0;
  for (const row of payments) {
    const step = appendLedgerRow(row, states, refundedCents, paidCents);
    if (!step.ok) return failure(step.reason);
    paidCents = step.paid_cents;
    if (paidCents < 0) return failure("NEGATIVE_PAID");
    if (paidCents > payableCents) return failure("OVERPAID");
  }
  return Object.freeze({
    ok: true,
    paid_cents: paidCents,
    balance_cents: payableCents - paidCents,
    states,
  });
}

/** Public, non-mutating receivables projection. Storage-fee rows fail closed in M2. */
export function derivePaymentLedger(
  payableCents: number,
  payments: readonly PaymentRow[],
): PaymentLedgerResult {
  const analysis = analyzePaymentLedger(payableCents, payments);
  return analysis.ok
    ? Object.freeze({
        ok: true,
        paid_cents: analysis.paid_cents,
        balance_cents: analysis.balance_cents,
      })
    : Object.freeze({ ok: false, reason: analysis.reason });
}

/** Targets are newest-first to make refund reversals precede their source payment. */
export function activeReversalTargets(
  payableCents: number,
  payments: readonly PaymentRow[],
): ActiveReversalTargetsResult {
  const analysis = analyzePaymentLedger(payableCents, payments);
  if (!analysis.ok) return Object.freeze({ ok: false, reason: analysis.reason });
  const active = payments.filter((row) => analysis.states.get(row.payment_id)?.active === true);
  return Object.freeze({ ok: true, targets: Object.freeze([...active].reverse()) });
}
