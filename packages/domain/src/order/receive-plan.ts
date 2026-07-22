/**
 * Pure receive (开单) plan: expand qty into garment slots + totals.
 * No IO; callers allocate UUIDs / ticket numbers.
 */

import { computeOrderTotals, type OrderTotals, type PricingRejectReason } from "./pricing.js";

export type ReceiveLineDraft = Readonly<{
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  qty: number;
  color?: string;
  brand?: string;
}>;

export type PlannedGarmentSlot = Readonly<{
  line_index: number;
  seq: number;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  color: string | null;
  brand: string | null;
  status: "received";
}>;

export type ReceivePlanSuccess = Readonly<{
  ok: true;
  slots: readonly PlannedGarmentSlot[];
  totals: OrderTotals;
}>;

export type ReceivePlanFailure = Readonly<{
  ok: false;
  reason: PricingRejectReason | "TOO_MANY_GARMENTS" | "INVALID_CODE";
}>;

export type ReceivePlanResult = ReceivePlanSuccess | ReceivePlanFailure;

const CODE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u;
/** Hard cap for a single receive (M2 skeleton; hard_limits also on command). */
export const MAX_RECEIVE_GARMENTS = 200;

/**
 * Expand receive lines into one slot per physical garment (qty=3 → 3 slots).
 */
export function planReceive(
  lines: readonly ReceiveLineDraft[],
  paidCents: number,
): ReceivePlanResult {
  for (const line of lines) {
    if (!CODE_RE.test(line.service_code) || !CODE_RE.test(line.category_code)) {
      return Object.freeze({ ok: false as const, reason: "INVALID_CODE" as const });
    }
  }

  const priced = lines.map((line) =>
    Object.freeze({
      unit_price_cents: line.unit_price_cents,
      qty: line.qty,
    }),
  );
  const totalsResult = computeOrderTotals(priced, paidCents);
  if (!totalsResult.ok) {
    return Object.freeze({ ok: false as const, reason: totalsResult.reason });
  }
  if (totalsResult.totals.garment_count > MAX_RECEIVE_GARMENTS) {
    return Object.freeze({ ok: false as const, reason: "TOO_MANY_GARMENTS" as const });
  }

  const slots: PlannedGarmentSlot[] = [];
  lines.forEach((line, lineIndex) => {
    for (let seq = 1; seq <= line.qty; seq += 1) {
      slots.push(
        Object.freeze({
          line_index: lineIndex,
          seq,
          service_code: line.service_code,
          category_code: line.category_code,
          unit_price_cents: line.unit_price_cents,
          color: line.color ?? null,
          brand: line.brand ?? null,
          status: "received" as const,
        }),
      );
    }
  });

  return Object.freeze({
    ok: true as const,
    slots: Object.freeze(slots),
    totals: totalsResult.totals,
  });
}
