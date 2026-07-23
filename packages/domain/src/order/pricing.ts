/**
 * Order pricing pure helpers. All monetary values are non-negative safe-integer cents.
 */

export type PricedLine = Readonly<{
  unit_price_cents: number;
  qty: number;
}>;

export type FivePartPricingInput = Readonly<{
  original_cents: number;
  discount_cents: number;
  addon_cents: number;
  urgent_cents: number;
  freight_cents: number;
}>;

/** The four adjustments applied after the line-derived original amount. */
export type OrderPricingAdjustments = Readonly<{
  discount_cents?: number;
  addon_cents?: number;
  urgent_cents?: number;
  freight_cents?: number;
}>;

export type OrderTotals = Readonly<{
  original_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  addon_cents: number;
  urgent_cents: number;
  freight_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  garment_count: number;
}>;

export type PricingRejectReason =
  | "EMPTY_LINES"
  | "INVALID_QTY"
  | "INVALID_UNIT_PRICE"
  | "PAID_EXCEEDS_PAYABLE"
  | "NEGATIVE_PAID"
  | "DISCOUNT_EXCEEDS_ORIGINAL"
  | "UNSAFE_CENTS";

export type PricingResult =
  | Readonly<{ ok: true; totals: OrderTotals }>
  | Readonly<{ ok: false; reason: PricingRejectReason }>;

export type FivePartPricingResult =
  | Readonly<{ ok: true; payable_cents: number }>
  | Readonly<{ ok: false; reason: "DISCOUNT_EXCEEDS_ORIGINAL" | "UNSAFE_CENTS" }>;

const isNonNegativeSafeCents = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const defaultAdjustments = (): Required<OrderPricingAdjustments> =>
  Object.freeze({
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
  });

function addSafe(left: number, right: number): number | null {
  const total = left + right;
  return Number.isSafeInteger(total) ? total : null;
}

/** M2 payable = original − discount + addon + urgent + freight. */
export function computeFivePartPricing(input: FivePartPricingInput): FivePartPricingResult {
  const values = [
    input.original_cents,
    input.discount_cents,
    input.addon_cents,
    input.urgent_cents,
    input.freight_cents,
  ];
  if (!values.every(isNonNegativeSafeCents)) {
    return Object.freeze({ ok: false, reason: "UNSAFE_CENTS" });
  }
  if (input.discount_cents > input.original_cents) {
    return Object.freeze({ ok: false, reason: "DISCOUNT_EXCEEDS_ORIGINAL" });
  }

  const afterDiscount = input.original_cents - input.discount_cents;
  const withAddon = addSafe(afterDiscount, input.addon_cents);
  const withUrgent = withAddon === null ? null : addSafe(withAddon, input.urgent_cents);
  const payable = withUrgent === null ? null : addSafe(withUrgent, input.freight_cents);
  return payable === null
    ? Object.freeze({ ok: false, reason: "UNSAFE_CENTS" })
    : Object.freeze({ ok: true, payable_cents: payable });
}

/** Line total = unit price × quantity. Throws only for a direct invalid helper call. */
export function lineTotalCents(unitPriceCents: number, qty: number): number {
  if (!isNonNegativeSafeCents(unitPriceCents)) {
    throw new TypeError(
      `unit_price_cents must be non-negative safe integer, got: ${unitPriceCents}`,
    );
  }
  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw new TypeError(`qty must be a positive safe integer, got: ${qty}`);
  }
  const total = unitPriceCents * qty;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError("line total exceeds Number.MAX_SAFE_INTEGER cents");
  }
  return total;
}

function normalizeAdjustments(
  adjustments: OrderPricingAdjustments | undefined,
): Required<OrderPricingAdjustments> | null {
  const normalized = Object.freeze({ ...defaultAdjustments(), ...adjustments });
  return Object.values(normalized).every(isNonNegativeSafeCents) ? normalized : null;
}

function sumLines(
  lines: readonly PricedLine[],
): Readonly<{ subtotal: number; garments: number }> | null {
  let subtotal = 0;
  let garments = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.qty) || line.qty < 1) return null;
    if (!isNonNegativeSafeCents(line.unit_price_cents)) return null;
    const lineTotal = line.unit_price_cents * line.qty;
    const nextSubtotal = addSafe(subtotal, lineTotal);
    const nextGarments = addSafe(garments, line.qty);
    if (!Number.isSafeInteger(lineTotal) || nextSubtotal === null || nextGarments === null)
      return null;
    subtotal = nextSubtotal;
    garments = nextGarments;
  }
  return Object.freeze({ subtotal, garments });
}

function pricingFailure(reason: PricingRejectReason): PricingResult {
  return Object.freeze({ ok: false, reason });
}

/**
 * Compute the line-derived original amount and the complete M2 five-part price.
 * The optional adjustments let later command slices use the same calculation without
 * duplicating it; an omitted adjustment is exactly zero.
 */
export function computeOrderTotals(
  lines: readonly PricedLine[],
  paidCents: number,
  adjustments?: OrderPricingAdjustments,
): PricingResult {
  if (lines.length === 0) return pricingFailure("EMPTY_LINES");
  if (!Number.isSafeInteger(paidCents)) return pricingFailure("UNSAFE_CENTS");
  if (paidCents < 0) return pricingFailure("NEGATIVE_PAID");

  const sums = sumLines(lines);
  if (sums === null) {
    const hasBadQty = lines.some((line) => !Number.isSafeInteger(line.qty) || line.qty < 1);
    const hasBadUnitPrice = lines.some(
      (line) => !Number.isInteger(line.unit_price_cents) || line.unit_price_cents < 0,
    );
    return pricingFailure(
      hasBadQty ? "INVALID_QTY" : hasBadUnitPrice ? "INVALID_UNIT_PRICE" : "UNSAFE_CENTS",
    );
  }
  const normalized = normalizeAdjustments(adjustments);
  if (normalized === null) return pricingFailure("UNSAFE_CENTS");

  const fivePart = computeFivePartPricing({ original_cents: sums.subtotal, ...normalized });
  if (!fivePart.ok) return pricingFailure(fivePart.reason);
  if (paidCents > fivePart.payable_cents) return pricingFailure("PAID_EXCEEDS_PAYABLE");

  return Object.freeze({
    ok: true,
    totals: Object.freeze({
      original_cents: sums.subtotal,
      subtotal_cents: sums.subtotal,
      ...normalized,
      payable_cents: fivePart.payable_cents,
      paid_cents: paidCents,
      balance_cents: fivePart.payable_cents - paidCents,
      garment_count: sums.garments,
    }),
  });
}
