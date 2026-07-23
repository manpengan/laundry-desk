import type { CounterOrderStatus } from "./lifecycle.js";
import { activeReversalTargets, type PaymentKind, type PaymentRow } from "./payment.js";

export type CancelReversalTarget = Readonly<{
  payment_id: string;
  amount_cents: number;
  kind: PaymentKind;
}>;

export type CancelPlan =
  | Readonly<{
      ok: true;
      status: "cancelled";
      reason: string;
      reversal_targets: readonly CancelReversalTarget[];
    }>
  | Readonly<{
      ok: false;
      reason: "INVALID_REASON" | "ORDER_NOT_OPEN" | "INVALID_PAYMENT_LEDGER";
    }>;

export type CancelPlanInput = Readonly<{
  status: CounterOrderStatus;
  reason: string;
  payable_cents: number;
  payments: readonly PaymentRow[];
}>;

function normalizeReason(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null;
}

/**
 * Cancellation never deletes a ledger row. Reversal targets are deliberately
 * newest-first, so reversing a refund releases its original collection before
 * that collection is reversed. The caller allocates ids and writes all rows in
 * the same transaction as the cancellation and audit entry.
 */
export function planCancel(input: CancelPlanInput): CancelPlan {
  if (input.status !== "open") return Object.freeze({ ok: false, reason: "ORDER_NOT_OPEN" });
  const reason = normalizeReason(input.reason);
  if (reason === null) return Object.freeze({ ok: false, reason: "INVALID_REASON" });

  const targets = activeReversalTargets(input.payable_cents, input.payments);
  if (!targets.ok) return Object.freeze({ ok: false, reason: "INVALID_PAYMENT_LEDGER" });
  return Object.freeze({
    ok: true,
    status: "cancelled",
    reason,
    reversal_targets: Object.freeze(
      targets.targets.map((payment) =>
        Object.freeze({
          payment_id: payment.payment_id,
          amount_cents: payment.amount_cents,
          kind: payment.kind,
        }),
      ),
    ),
  });
}
