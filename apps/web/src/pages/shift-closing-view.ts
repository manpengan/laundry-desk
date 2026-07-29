/** Strict UI projection for shift.close and shift.get results. */

export type ShiftClosingView = Readonly<{
  shift_id: string;
  business_date: string;
  closed_at: number;
  order_count: number;
  payable_cents: number;
  paid_cents: number;
  payment_cents: number;
  counted_cash_cents: number;
  retained_float_cents: number;
  cash_difference_cents: number;
  signature_name?: string;
  note?: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapShiftResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parseShiftClosing(value: unknown): ShiftClosingView | null {
  if (value === null || !isRecord(value) || typeof value.shift_id !== "string") return null;
  if (typeof value.business_date !== "string") return null;
  const closed_at = asInt(value.closed_at);
  const order_count = asInt(value.order_count);
  const payable_cents = asInt(value.payable_cents);
  const paid_cents = asInt(value.paid_cents);
  const payment_cents = asInt(value.payment_cents);
  const counted_cash_cents = asInt(value.counted_cash_cents);
  const retained_float_cents = asInt(value.retained_float_cents);
  const cash_difference_cents = asInt(value.cash_difference_cents);
  if (
    closed_at === null ||
    order_count === null ||
    payable_cents === null ||
    paid_cents === null ||
    payment_cents === null ||
    counted_cash_cents === null ||
    retained_float_cents === null ||
    cash_difference_cents === null
  ) {
    return null;
  }
  return Object.freeze({
    shift_id: value.shift_id,
    business_date: value.business_date,
    closed_at,
    order_count,
    payable_cents,
    paid_cents,
    payment_cents,
    counted_cash_cents,
    retained_float_cents,
    cash_difference_cents,
    ...(typeof value.signature_name === "string" ? { signature_name: value.signature_name } : {}),
    ...(value.note === null || typeof value.note === "string" ? { note: value.note } : {}),
  });
}
