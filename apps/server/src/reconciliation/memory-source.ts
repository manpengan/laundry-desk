import { businessDayAt } from "@laundry/domain";

import type { OrderStore } from "../order/types.js";
import type { MemoryPrintJobStore } from "../print/memory-store.js";
import type { PrintJobStatus } from "../print/types.js";
import type { ShiftStore } from "../shift/types.js";
import { comparePaymentBucket, isoFromEpochSeconds, paymentNetCents } from "./common.js";
import type {
  EdgeConflictReadPort,
  ReconciliationReadPort,
  ReconciliationSnapshot,
} from "./types.js";

export type MemoryReconciliationSourceOptions = Readonly<{
  orders: OrderStore;
  shifts: ShiftStore;
  printJobs: Pick<MemoryPrintJobStore, "listAll">;
  timeZone: string;
  rolloverHour?: number;
}>;

type LedgerBucket = ReconciliationSnapshot["ledger"]["buckets"][number];
type PaymentRows = Awaited<ReturnType<NonNullable<OrderStore["listPayments"]>>>;
type SignedPayment = Readonly<{
  row: PaymentRows[number];
  net_cents: number;
}>;

function sum(
  rows: readonly Readonly<Record<"payable_cents" | "paid_cents" | "balance_cents", number>>[],
  field: "payable_cents" | "paid_cents" | "balance_cents",
): number {
  const value = rows.reduce((total, row) => total + row[field], 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} overflow`);
  return value;
}

function signedPayments(rows: PaymentRows, referenceRows: PaymentRows): readonly SignedPayment[] {
  const referencedKinds = new Map(referenceRows.map((row) => [row.payment_id, row.kind]));
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        row,
        net_cents: paymentNetCents(
          row,
          row.ref_payment_id === null ? undefined : referencedKinds.get(row.ref_payment_id),
        ),
      }),
    ),
  );
}

function paymentBuckets(rows: readonly SignedPayment[]): readonly LedgerBucket[] {
  const grouped = new Map<string, LedgerBucket>();
  for (const signed of rows) {
    const { row } = signed;
    const identity = `${row.method}:${row.kind}`;
    const current = grouped.get(identity);
    grouped.set(
      identity,
      Object.freeze({
        method: row.method,
        kind: row.kind,
        row_count: (current?.row_count ?? 0) + 1,
        amount_cents: (current?.amount_cents ?? 0) + row.amount_cents,
        net_cents: (current?.net_cents ?? 0) + signed.net_cents,
      }),
    );
  }
  return Object.freeze([...grouped.values()].sort(comparePaymentBucket));
}

function ledgerSummary(
  rows: readonly SignedPayment[],
  buckets: readonly LedgerBucket[],
  paidCents: number,
): ReconciliationSnapshot["ledger"] {
  const gross = rows.reduce((total, row) => total + Math.max(row.net_cents, 0), 0);
  const refund = rows.reduce((total, row) => total + Math.max(-row.net_cents, 0), 0);
  const net = gross - refund;
  return Object.freeze({
    row_count: rows.length,
    gross_cents: gross,
    refund_cents: refund,
    net_cents: net,
    difference_from_orders_cents: net - paidCents,
    buckets,
  });
}

async function printSummary(
  options: MemoryReconciliationSourceOptions,
  businessDate: string,
): Promise<ReconciliationSnapshot["print"]> {
  const rows = await options.printJobs.listAll();
  const dayRows = rows.filter(
    (row) =>
      businessDayAt(new Date(row.created_at * 1_000), options.timeZone, options.rolloverHour ?? 0)
        .business_date === businessDate,
  );
  const counts = new Map<PrintJobStatus, number>();
  for (const row of dayRows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const order: readonly PrintJobStatus[] = ["queued", "printing", "done", "failed"];
  return Object.freeze({
    total: dayRows.length,
    statuses: Object.freeze(
      order
        .filter((status) => counts.has(status))
        .map((status) => Object.freeze({ status, count: counts.get(status) ?? 0 })),
    ),
  });
}

export function createMemoryReconciliationSource(
  options: MemoryReconciliationSourceOptions,
): ReconciliationReadPort {
  return Object.freeze({
    readDay: async ({ tenant, businessDate }): Promise<ReconciliationSnapshot> => {
      const orders =
        options.orders.listOrders === undefined
          ? Object.freeze([])
          : (await options.orders.listOrders(tenant.orgId, tenant.storeId)).filter(
              (row) =>
                row.business_date === businessDate &&
                (row.status === "open" || row.status === "closed"),
            );
      const allPayments =
        options.orders.listPayments === undefined
          ? Object.freeze([])
          : await options.orders.listPayments(tenant.orgId, tenant.storeId);
      const payments = allPayments.filter((row) => row.business_date === businessDate);
      const paidCents = sum(orders, "paid_cents");
      const signed = signedPayments(payments, allPayments);
      const buckets = paymentBuckets(signed);
      const shift = await options.shifts.getByBusinessDate(
        tenant.orgId,
        tenant.storeId,
        businessDate,
      );
      return Object.freeze({
        business_date: businessDate,
        orders: Object.freeze({
          count: orders.length,
          payable_cents: sum(orders, "payable_cents"),
          paid_cents: paidCents,
          balance_cents: sum(orders, "balance_cents"),
        }),
        ledger: ledgerSummary(signed, buckets, paidCents),
        shift:
          shift === null
            ? null
            : Object.freeze({
                closed_at: isoFromEpochSeconds(shift.closed_at),
                order_count: shift.order_count,
                payable_cents: shift.payable_cents,
                paid_cents: shift.paid_cents,
                payment_cents: shift.payment_cents,
                counted_cash_cents: shift.counted_cash_cents,
                retained_float_cents: shift.retained_float_cents,
                expected_cash_cents: shift.expected_cash_cents,
                cash_difference_cents: shift.cash_difference_cents,
              }),
        print: await printSummary(options, businessDate),
        edge_replay: Object.freeze({
          total: 0,
          conflict_count: 0,
          decisions: Object.freeze([]),
        }),
      });
    },
  });
}

/** Memory mode has no durable Edge replay authority and therefore fails closed. */
export function createMemoryEdgeConflictReadPort(): EdgeConflictReadPort {
  return Object.freeze({
    hasDiscardableConflict: async () => false,
  });
}
