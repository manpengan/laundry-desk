import type {
  ReconciliationPaymentKindSchema,
  ReconciliationPaymentMethodSchema,
} from "@laundry/contracts";
import type { z } from "zod";

type PaymentKind = z.output<typeof ReconciliationPaymentKindSchema>;
type PaymentMethod = z.output<typeof ReconciliationPaymentMethodSchema>;

export const PAYMENT_METHOD_ORDER: readonly PaymentMethod[] = Object.freeze([
  "cash",
  "wechat",
  "alipay",
  "other",
]);
export const PAYMENT_KIND_ORDER: readonly PaymentKind[] = Object.freeze([
  "pay",
  "repay",
  "refund",
  "storage_fee",
  "reversal",
]);

export function comparePaymentBucket(
  left: Readonly<{ method: PaymentMethod; kind: PaymentKind }>,
  right: Readonly<{ method: PaymentMethod; kind: PaymentKind }>,
): number {
  const methodOrder =
    PAYMENT_METHOD_ORDER.indexOf(left.method) - PAYMENT_METHOD_ORDER.indexOf(right.method);
  return methodOrder === 0
    ? PAYMENT_KIND_ORDER.indexOf(left.kind) - PAYMENT_KIND_ORDER.indexOf(right.kind)
    : methodOrder;
}

export function paymentNetCents(
  row: Readonly<{ kind: PaymentKind; amount_cents: number; ref_payment_id: string | null }>,
  referencedKind: PaymentKind | undefined,
): number {
  if (row.kind === "refund") return -row.amount_cents;
  if (row.kind !== "reversal") return row.amount_cents;
  return referencedKind === "refund" ? row.amount_cents : -row.amount_cents;
}

export function requireSafeInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${field} must be a safe integer`);
  }
  return parsed;
}

export function isoFromEpochSeconds(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new RangeError("epoch must be a non-negative safe integer");
  }
  return new Date(epoch * 1_000).toISOString();
}
