import {
  PrintSnapshotSchema,
  canonicalizePrintSnapshot,
  type PrintSnapshot,
} from "@laundry/contracts";
import { createHash } from "node:crypto";

import type { LedgerPaymentRow, OrderRecord } from "../order/types.js";

const PAYMENT_METHOD_ORDER = Object.freeze([
  "cash",
  "wechat",
  "alipay",
  "other",
  "balance",
] as const);

function paymentNet(payment: LedgerPaymentRow, referenced: LedgerPaymentRow | undefined): number {
  if (payment.kind === "refund") return -payment.amount_cents;
  if (payment.kind !== "reversal") return payment.amount_cents;
  return referenced?.kind === "refund" ? payment.amount_cents : -payment.amount_cents;
}

function effectivePaymentMethods(payments: readonly LedgerPaymentRow[]) {
  const byId = new Map(payments.map((payment) => [payment.payment_id, payment] as const));
  const netByMethod = new Map<(typeof PAYMENT_METHOD_ORDER)[number], number>();
  for (const payment of payments) {
    const referenced =
      payment.ref_payment_id === null ? undefined : byId.get(payment.ref_payment_id);
    if (payment.kind === "reversal" && referenced === undefined) {
      throw new Error("print payment reversal is missing its referenced ledger row");
    }
    const method =
      payment.kind === "reversal" ? (referenced?.method ?? payment.method) : payment.method;
    netByMethod.set(method, (netByMethod.get(method) ?? 0) + paymentNet(payment, referenced));
  }
  return Object.freeze(PAYMENT_METHOD_ORDER.filter((method) => (netByMethod.get(method) ?? 0) > 0));
}

export type PrintSnapshotOrderSource = Readonly<{
  order: OrderRecord;
  storeName: string;
  storePhone: string | null;
  payments: readonly LedgerPaymentRow[];
}>;

export function snapshotFromOrder(source: PrintSnapshotOrderSource): PrintSnapshot {
  const { order } = source;
  if (order.ticket_no === null || order.status === "draft" || order.status === "cancelled") {
    throw new Error("print snapshot requires a received, non-cancelled order");
  }
  return PrintSnapshotSchema.parse({
    version: 1,
    store_name: source.storeName,
    store_phone: source.storePhone,
    order_id: order.order_id,
    ticket_no: order.ticket_no,
    received_at: new Date(order.created_at * 1_000).toISOString(),
    customer_name: order.customer_name,
    customer_phone: order.customer_phone,
    note: order.note,
    lines: order.lines,
    totals: {
      original_cents: order.original_cents,
      discount_cents: order.discount_cents,
      addon_cents: order.addon_cents,
      urgent_cents: order.urgent_cents,
      freight_cents: order.freight_cents,
      payable_cents: order.payable_cents,
      paid_cents: order.paid_cents,
      balance_cents: order.balance_cents,
    },
    payment_methods: effectivePaymentMethods(source.payments),
  });
}

export function hashPrintSnapshot(snapshotInput: unknown): string {
  return createHash("sha256").update(canonicalizePrintSnapshot(snapshotInput)).digest("hex");
}
