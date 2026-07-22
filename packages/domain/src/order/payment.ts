/**
 * Payment ledger row shape (ADR-03 append-only).
 * amount_cents is always positive; reversals use kind=reversal + ref_payment_id.
 */

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

const isPaymentMethod = (value: string): value is PaymentMethod =>
  (PAYMENT_METHODS as readonly string[]).includes(value);

/** Build a kind=pay ledger row for cash (or skeleton method) collection. */
export function buildPayPayment(input: BuildPayPaymentInput): PaymentRow {
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    throw new TypeError(
      `payment amount_cents must be a positive integer, got: ${input.amount_cents}`,
    );
  }
  const method = input.method ?? "cash";
  if (!isPaymentMethod(method)) {
    throw new TypeError(`unsupported payment method: ${method}`);
  }
  return Object.freeze({
    payment_id: input.payment_id,
    org_id: input.org_id,
    store_id: input.store_id,
    order_id: input.order_id,
    method,
    amount_cents: input.amount_cents,
    kind: "pay" as const,
    ref_payment_id: null,
    staff_id: input.staff_id,
    at: input.at,
    note: input.note ?? null,
  });
}
