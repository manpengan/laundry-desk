import type { CommandPort } from "../commands/types.js";
import { isValidUuid, parsePositiveInt, unwrapCommandResult } from "./order-form.js";

export type PaymentLedgerMethod = "cash" | "wechat" | "alipay" | "other" | "balance";
export type PaymentLedgerKind = "pay" | "repay" | "refund" | "reversal";

export type PaymentLedgerRowView = Readonly<{
  payment_id: string;
  kind: PaymentLedgerKind;
  method: PaymentLedgerMethod;
  amount_cents: number;
  signed_cents: number;
  ref_payment_id: string | null;
  at: number;
  note: string | null;
  active: boolean;
  refundable_cents: number;
}>;

export type PaymentLedgerView = Readonly<{
  order_id: string;
  order_status: string;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  payments: readonly PaymentLedgerRowView[];
}>;

export type PaymentRefundBody = Readonly<{
  order_id: string;
  amount_cents: number;
  method: Exclude<PaymentLedgerMethod, "balance">;
  ref_payment_id: string;
  reason: string;
}>;

export type BuildPaymentRefundResult =
  Readonly<{ ok: true; body: PaymentRefundBody }> | Readonly<{ ok: false; message: string }>;

const METHODS = new Set<PaymentLedgerMethod>(["cash", "wechat", "alipay", "other", "balance"]);
const KINDS = new Set<PaymentLedgerKind>(["pay", "repay", "refund", "reversal"]);
const ORDER_STATUSES = new Set(["draft", "open", "closed", "cancelled"]);
const ROOT_KEYS = Object.freeze([
  "order_id",
  "order_status",
  "payable_cents",
  "paid_cents",
  "balance_cents",
  "payments",
]);
const ROW_KEYS = Object.freeze([
  "payment_id",
  "kind",
  "method",
  "amount_cents",
  "signed_cents",
  "ref_payment_id",
  "at",
  "note",
  "active",
  "refundable_cents",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isNonNegativeCents = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parsePaymentRow(value: unknown): PaymentLedgerRowView | null {
  if (!isRecord(value) || !hasExactKeys(value, ROW_KEYS)) return null;
  if (typeof value.payment_id !== "string" || !isValidUuid(value.payment_id)) return null;
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as PaymentLedgerKind)) return null;
  if (typeof value.method !== "string" || !METHODS.has(value.method as PaymentLedgerMethod)) {
    return null;
  }
  if (!isNonNegativeCents(value.amount_cents) || value.amount_cents === 0) return null;
  if (typeof value.signed_cents !== "number" || !Number.isSafeInteger(value.signed_cents)) {
    return null;
  }
  if (Math.abs(value.signed_cents) !== value.amount_cents) return null;
  if ((value.kind === "pay" || value.kind === "repay") && value.signed_cents < 0) return null;
  if (value.kind === "refund" && value.signed_cents > 0) return null;
  if (value.ref_payment_id !== null) {
    if (typeof value.ref_payment_id !== "string" || !isValidUuid(value.ref_payment_id)) return null;
  }
  if (typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at < 0) return null;
  if (value.note !== null && typeof value.note !== "string") return null;
  if (typeof value.note === "string" && value.note.length > 256) return null;
  if (typeof value.active !== "boolean") return null;
  if (!isNonNegativeCents(value.refundable_cents)) return null;
  if (value.refundable_cents > value.amount_cents) return null;
  if (
    value.refundable_cents > 0 &&
    (!value.active ||
      (value.kind !== "pay" && value.kind !== "repay") ||
      value.method === "balance")
  ) {
    return null;
  }
  if (
    ((value.kind === "pay" || value.kind === "repay") && value.ref_payment_id !== null) ||
    ((value.kind === "refund" || value.kind === "reversal") && value.ref_payment_id === null)
  ) {
    return null;
  }
  return Object.freeze({
    payment_id: value.payment_id,
    kind: value.kind as PaymentLedgerKind,
    method: value.method as PaymentLedgerMethod,
    amount_cents: value.amount_cents,
    signed_cents: value.signed_cents,
    ref_payment_id: value.ref_payment_id,
    at: value.at,
    note: value.note,
    active: value.active,
    refundable_cents: value.refundable_cents,
  });
}

export function readPaymentLedger(raw: unknown): PaymentLedgerView | null {
  const value = unwrapCommandResult<unknown>(raw);
  if (!isRecord(value) || !hasExactKeys(value, ROOT_KEYS)) return null;
  if (typeof value.order_id !== "string" || !isValidUuid(value.order_id)) return null;
  if (typeof value.order_status !== "string" || !ORDER_STATUSES.has(value.order_status))
    return null;
  if (
    !isNonNegativeCents(value.payable_cents) ||
    !isNonNegativeCents(value.paid_cents) ||
    !isNonNegativeCents(value.balance_cents) ||
    !Array.isArray(value.payments) ||
    value.payments.length > 200
  ) {
    return null;
  }
  const payments: PaymentLedgerRowView[] = [];
  for (const row of value.payments) {
    const parsed = parsePaymentRow(row);
    if (parsed === null) return null;
    payments.push(parsed);
  }
  const identities = new Set(payments.map((payment) => payment.payment_id));
  const signedTotal = payments.reduce((total, payment) => total + payment.signed_cents, 0);
  const totalsMatch =
    value.order_status === "cancelled"
      ? value.paid_cents === 0 && value.balance_cents === 0
      : value.paid_cents + value.balance_cents === value.payable_cents;
  if (
    identities.size !== payments.length ||
    !Number.isSafeInteger(signedTotal) ||
    signedTotal !== value.paid_cents ||
    !totalsMatch
  ) {
    return null;
  }
  return Object.freeze({
    order_id: value.order_id,
    order_status: value.order_status,
    payable_cents: value.payable_cents,
    paid_cents: value.paid_cents,
    balance_cents: value.balance_cents,
    payments: Object.freeze(payments),
  });
}

export function buildPaymentRefundBody(
  orderId: string,
  payment: PaymentLedgerRowView,
  amountText: string,
  reasonText: string,
): BuildPaymentRefundResult {
  if (
    !isValidUuid(orderId) ||
    !payment.active ||
    (payment.kind !== "pay" && payment.kind !== "repay") ||
    payment.method === "balance" ||
    payment.refundable_cents <= 0
  ) {
    return Object.freeze({ ok: false, message: "这笔流水当前不可退款" });
  }
  const amount = parsePositiveInt(amountText, payment.refundable_cents);
  if (amount === null) {
    return Object.freeze({ ok: false, message: "退款金额必须大于 0，且不能超过服务端可退金额" });
  }
  const reason = reasonText.trim();
  if (reason.length < 1 || reason.length > 256) {
    return Object.freeze({ ok: false, message: "请填写 1–256 字退款原因" });
  }
  return Object.freeze({
    ok: true,
    body: Object.freeze({
      order_id: orderId,
      amount_cents: amount,
      method: payment.method,
      ref_payment_id: payment.payment_id,
      reason,
    }),
  });
}

/** Resume the server-frozen R4 action; no mutable refund fields are replayed. */
export function resumePaymentRefund(commandClient: CommandPort, confirmRef: string) {
  return commandClient.execute("payment.refund", {}, { confirmRef });
}

export function paymentKindLabel(kind: PaymentLedgerKind): string {
  return { pay: "收款", repay: "补缴", refund: "退款", reversal: "冲正" }[kind];
}

export function paymentMethodLabel(method: PaymentLedgerMethod): string {
  return {
    cash: "现金",
    wechat: "微信",
    alipay: "支付宝",
    other: "其他",
    balance: "会员余额",
  }[method];
}
