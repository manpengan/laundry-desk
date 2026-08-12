import { buildReversalPayment, planCancel } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { LedgerPaymentRow, OrderRecord } from "./types.js";

export type MemoryOrderCancellation = Readonly<{
  order: OrderRecord;
  reversals: readonly LedgerPaymentRow[];
}>;

export function planMemoryOrderCancellation(input: {
  order: OrderRecord;
  payments: readonly LedgerPaymentRow[];
  reason: string;
  staffId: string;
  at: number;
  businessDate: string;
}): MemoryOrderCancellation | null {
  if (input.order.status !== "open") return null;
  const plan = planCancel({
    status: input.order.status,
    reason: input.reason,
    payable_cents: input.order.payable_cents,
    payments: input.payments,
  });
  if (!plan.ok) return null;
  const reversals: LedgerPaymentRow[] = [];
  for (const target of plan.reversal_targets) {
    const source = input.payments.find((payment) => payment.payment_id === target.payment_id);
    if (source === undefined) return null;
    reversals.push(
      Object.freeze({
        ...buildReversalPayment({
          payment_id: randomUUID(),
          org_id: input.order.org_id,
          store_id: input.order.store_id,
          order_id: input.order.order_id,
          amount_cents: target.amount_cents,
          staff_id: input.staffId,
          at: input.at,
          method: source.method,
          ref_payment_id: source.payment_id,
          reason: plan.reason,
        }),
        business_date: input.businessDate,
      }),
    );
  }
  return Object.freeze({
    order: Object.freeze({
      ...input.order,
      status: "cancelled" as const,
      paid_cents: 0,
      balance_cents: 0,
      updated_at: input.at,
    }),
    reversals: Object.freeze(reversals),
  });
}
