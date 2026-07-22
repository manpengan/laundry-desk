/**
 * Order pricing pure helpers — integer cents only (M2 skeleton).
 */

import { addCents, validateCents } from "../money.js";

export type PricedLine = Readonly<{
  unit_price_cents: number;
  qty: number;
}>;

export type OrderTotals = Readonly<{
  /** Sum of unit_price_cents * qty across lines. */
  subtotal_cents: number;
  /** Payable after discounts (skeleton: equals subtotal). */
  payable_cents: number;
  paid_cents: number;
  /** payable - paid (may be zero when fully paid). */
  balance_cents: number;
  garment_count: number;
}>;

export type PricingRejectReason =
  "EMPTY_LINES" | "INVALID_QTY" | "INVALID_UNIT_PRICE" | "PAID_EXCEEDS_PAYABLE" | "NEGATIVE_PAID";

export type PricingResult =
  | Readonly<{ ok: true; totals: OrderTotals }>
  | Readonly<{ ok: false; reason: PricingRejectReason }>;

/** Line total = unit_price_cents * qty (both non-negative integers; qty ≥ 1). */
export function lineTotalCents(unitPriceCents: number, qty: number): number {
  validateCents(unitPriceCents);
  if (!Number.isInteger(qty) || qty < 1) {
    throw new TypeError(`qty must be a positive integer, got: ${qty}`);
  }
  if (unitPriceCents < 0) {
    throw new TypeError(`unit_price_cents must be non-negative, got: ${unitPriceCents}`);
  }
  return unitPriceCents * qty;
}

/**
 * Compute order totals for receive. Discounts/addons land in later M2 slices.
 * `paid_cents` must be ≤ payable and ≥ 0.
 */
export function computeOrderTotals(lines: readonly PricedLine[], paidCents: number): PricingResult {
  if (lines.length === 0) {
    return Object.freeze({ ok: false as const, reason: "EMPTY_LINES" as const });
  }
  if (!Number.isInteger(paidCents)) {
    return Object.freeze({ ok: false as const, reason: "NEGATIVE_PAID" as const });
  }
  if (paidCents < 0) {
    return Object.freeze({ ok: false as const, reason: "NEGATIVE_PAID" as const });
  }

  let subtotal = 0;
  let garmentCount = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      return Object.freeze({ ok: false as const, reason: "INVALID_QTY" as const });
    }
    if (!Number.isInteger(line.unit_price_cents) || line.unit_price_cents < 0) {
      return Object.freeze({ ok: false as const, reason: "INVALID_UNIT_PRICE" as const });
    }
    subtotal = addCents(subtotal, lineTotalCents(line.unit_price_cents, line.qty));
    garmentCount += line.qty;
  }

  const payable = subtotal;
  if (paidCents > payable) {
    return Object.freeze({ ok: false as const, reason: "PAID_EXCEEDS_PAYABLE" as const });
  }

  return Object.freeze({
    ok: true as const,
    totals: Object.freeze({
      subtotal_cents: subtotal,
      payable_cents: payable,
      paid_cents: paidCents,
      balance_cents: payable - paidCents,
      garment_count: garmentCount,
    }),
  });
}
