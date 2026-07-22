/**
 * Pure day-summary (日结) aggregation — integer fen only, no IO.
 * Caller filters rows to the target business day (or pass all + filter helpers).
 */

import { addCents, validateCents } from "../money.js";

export type DaySummaryOrderInput = Readonly<{
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
}>;

export type DaySummaryGarmentInput = Readonly<{
  status: string;
}>;

export type DaySummaryPaymentInput = Readonly<{
  amount_cents: number;
  kind: string;
}>;

export type DaySummary = Readonly<{
  business_date: string;
  order_count: number;
  garment_count: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  payment_cents: number;
  picked_garment_count: number;
}>;

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** UTC calendar day key YYYY-MM-DD from unix epoch seconds. */
export function utcDateKeyFromEpoch(epochSeconds: number): string {
  if (!Number.isSafeInteger(epochSeconds)) {
    throw new TypeError(`epochSeconds must be a safe integer, got: ${epochSeconds}`);
  }
  const d = new Date(epochSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local calendar day key YYYY-MM-DD (counter UI default date). */
export function localDateKeyFromDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function assertBusinessDate(value: string): void {
  if (!BUSINESS_DATE_RE.test(value)) {
    throw new TypeError(`business_date must be YYYY-MM-DD, got: ${value}`);
  }
}

/**
 * Aggregate pre-scoped day rows into a single summary.
 * `orders` / `garments` should already be the day's set.
 * `payments` may include non-pay kinds; only kind === "pay" is summed.
 */
export function aggregateDaySummary(input: {
  readonly business_date: string;
  readonly orders: readonly DaySummaryOrderInput[];
  readonly garments: readonly DaySummaryGarmentInput[];
  readonly payments?: readonly DaySummaryPaymentInput[];
}): DaySummary {
  assertBusinessDate(input.business_date);

  let payable = 0;
  let paid = 0;
  let balance = 0;
  for (const order of input.orders) {
    validateCents(order.payable_cents);
    validateCents(order.paid_cents);
    validateCents(order.balance_cents);
    payable = addCents(payable, order.payable_cents);
    paid = addCents(paid, order.paid_cents);
    balance = addCents(balance, order.balance_cents);
  }

  let paymentCents = 0;
  for (const payment of input.payments ?? []) {
    if (payment.kind !== "pay") continue;
    validateCents(payment.amount_cents);
    paymentCents = addCents(paymentCents, payment.amount_cents);
  }

  let picked = 0;
  for (const garment of input.garments) {
    if (garment.status === "picked_up") {
      picked += 1;
    }
  }

  return Object.freeze({
    business_date: input.business_date,
    order_count: input.orders.length,
    garment_count: input.garments.length,
    payable_cents: payable,
    paid_cents: paid,
    balance_cents: balance,
    payment_cents: paymentCents,
    picked_garment_count: picked,
  });
}

/** Empty zero summary for a business date (no orders). */
export function emptyDaySummary(businessDate: string): DaySummary {
  return aggregateDaySummary({
    business_date: businessDate,
    orders: Object.freeze([]),
    garments: Object.freeze([]),
    payments: Object.freeze([]),
  });
}
