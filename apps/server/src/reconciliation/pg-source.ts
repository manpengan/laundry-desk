import { businessDayStart } from "@laundry/domain";

import type {
  ReconciliationPrintStatusSchema,
  ReconciliationReplayDecisionSchema,
} from "@laundry/contracts";
import type { z } from "zod";

import type { SqlClient } from "../db/types.js";
import {
  PAYMENT_KIND_ORDER,
  PAYMENT_METHOD_ORDER,
  comparePaymentBucket,
  requireSafeInteger,
} from "./common.js";
import type {
  EdgeConflictReadPort,
  ReconciliationReadInput,
  ReconciliationReadPort,
  ReconciliationSnapshot,
} from "./types.js";

type PrintStatus = z.output<typeof ReconciliationPrintStatusSchema>;
type ReplayDecision = z.output<typeof ReconciliationReplayDecisionSchema>;
type LedgerBucket = ReconciliationSnapshot["ledger"]["buckets"][number];

type OrderAggregateRow = Readonly<{
  order_count: number | string;
  payable_cents: number | string;
  paid_cents: number | string;
  balance_cents: number | string;
}>;
type PaymentBucketRow = Readonly<{
  method: string;
  kind: string;
  row_count: number | string;
  amount_cents: number | string;
  net_cents: number | string;
  gross_cents: number | string;
  refund_cents: number | string;
}>;
type ShiftRow = Readonly<{
  closed_at: Date | string;
  order_count: number | string;
  payable_cents: number | string;
  paid_cents: number | string;
  payment_cents: number | string;
  counted_cash_cents: number | string;
  retained_float_cents: number | string;
  expected_cash_cents: number | string;
  cash_difference_cents: number | string;
}>;
type CountRow = Readonly<{ value: string; count: number | string }>;

function nextCalendarDate(businessDate: string): string {
  const date = new Date(`${businessDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function dayBounds(
  businessDate: string,
  timeZone: string,
  rolloverHour: number,
): readonly [Date, Date] {
  return Object.freeze([
    businessDayStart(businessDate, timeZone, rolloverHour),
    businessDayStart(nextCalendarDate(businessDate), timeZone, rolloverHour),
  ]);
}

async function readOrders(
  input: ReconciliationReadInput,
): Promise<ReconciliationSnapshot["orders"]> {
  const result = await input.client.query<OrderAggregateRow>(
    `SELECT COUNT(*)::integer AS order_count,
            COALESCE(SUM(payable_cents), 0)::bigint AS payable_cents,
            COALESCE(SUM(paid_cents), 0)::bigint AS paid_cents,
            COALESCE(SUM(balance_cents), 0)::bigint AS balance_cents
       FROM orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
        AND status IN ('open', 'closed')`,
    [input.tenant.orgId, input.tenant.storeId, input.businessDate],
  );
  const row = result.rows[0];
  return Object.freeze({
    count: requireSafeInteger(row?.order_count ?? 0, "order_count"),
    payable_cents: requireSafeInteger(row?.payable_cents ?? 0, "payable_cents"),
    paid_cents: requireSafeInteger(row?.paid_cents ?? 0, "paid_cents"),
    balance_cents: requireSafeInteger(row?.balance_cents ?? 0, "balance_cents"),
  });
}

function isPaymentMethod(value: string): value is LedgerBucket["method"] {
  return (PAYMENT_METHOD_ORDER as readonly string[]).includes(value);
}

function isPaymentKind(value: string): value is LedgerBucket["kind"] {
  return (PAYMENT_KIND_ORDER as readonly string[]).includes(value);
}

async function readLedger(
  input: ReconciliationReadInput,
  paidCents: number,
): Promise<ReconciliationSnapshot["ledger"]> {
  const result = await input.client.query<PaymentBucketRow>(
    `WITH signed AS (
       SELECT p.method, p.kind, p.amount_cents,
              CASE
                WHEN p.kind = 'refund' THEN -p.amount_cents
                WHEN p.kind = 'reversal' AND referenced.kind = 'refund' THEN p.amount_cents
                WHEN p.kind = 'reversal' THEN -p.amount_cents
                ELSE p.amount_cents
              END AS net_cents
         FROM payments p
         LEFT JOIN payments referenced
           ON referenced.org_id = p.org_id
          AND referenced.store_id = p.store_id
          AND referenced.id = p.ref_payment_id
        WHERE p.org_id = $1::uuid AND p.store_id = $2::uuid
          AND p.business_date = $3
     )
     SELECT method, kind, COUNT(*)::integer AS row_count,
            SUM(amount_cents)::bigint AS amount_cents,
            SUM(net_cents)::bigint AS net_cents,
            SUM(GREATEST(net_cents, 0))::bigint AS gross_cents,
            SUM(GREATEST(-net_cents, 0))::bigint AS refund_cents
       FROM signed
      GROUP BY method, kind`,
    [input.tenant.orgId, input.tenant.storeId, input.businessDate],
  );
  let rowCount = 0;
  let gross = 0;
  let refund = 0;
  const buckets: LedgerBucket[] = [];
  for (const row of result.rows) {
    if (!isPaymentMethod(row.method) || !isPaymentKind(row.kind)) {
      throw new Error("PostgreSQL returned an unsupported payment bucket");
    }
    const bucket = Object.freeze({
      method: row.method,
      kind: row.kind,
      row_count: requireSafeInteger(row.row_count, "payment row_count"),
      amount_cents: requireSafeInteger(row.amount_cents, "payment amount_cents"),
      net_cents: requireSafeInteger(row.net_cents, "payment net_cents"),
    });
    buckets.push(bucket);
    rowCount += bucket.row_count;
    gross += requireSafeInteger(row.gross_cents, "payment gross_cents");
    refund += requireSafeInteger(row.refund_cents, "payment refund_cents");
  }
  const net = gross - refund;
  return Object.freeze({
    row_count: rowCount,
    gross_cents: gross,
    refund_cents: refund,
    net_cents: net,
    difference_from_orders_cents: net - paidCents,
    buckets: Object.freeze(buckets.sort(comparePaymentBucket)),
  });
}

function utcTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError("invalid PostgreSQL timestamp");
  return date.toISOString();
}

async function readShift(input: ReconciliationReadInput): Promise<ReconciliationSnapshot["shift"]> {
  const result = await input.client.query<ShiftRow>(
    `SELECT closed_at, order_count, payable_cents, paid_cents, payment_cents,
            counted_cash_cents, retained_float_cents, expected_cash_cents,
            cash_difference_cents
       FROM shift_closings
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
      LIMIT 1`,
    [input.tenant.orgId, input.tenant.storeId, input.businessDate],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    closed_at: utcTimestamp(row.closed_at),
    order_count: requireSafeInteger(row.order_count, "shift order_count"),
    payable_cents: requireSafeInteger(row.payable_cents, "shift payable_cents"),
    paid_cents: requireSafeInteger(row.paid_cents, "shift paid_cents"),
    payment_cents: requireSafeInteger(row.payment_cents, "shift payment_cents"),
    counted_cash_cents: requireSafeInteger(row.counted_cash_cents, "shift counted_cash_cents"),
    retained_float_cents: requireSafeInteger(
      row.retained_float_cents,
      "shift retained_float_cents",
    ),
    expected_cash_cents: requireSafeInteger(row.expected_cash_cents, "shift expected_cash_cents"),
    cash_difference_cents: requireSafeInteger(
      row.cash_difference_cents,
      "shift cash_difference_cents",
    ),
  });
}

async function groupedCounts(
  client: SqlClient,
  table: "print_jobs" | "edge_replay_records",
  column: "status" | "decision",
  orgId: string,
  storeId: string,
  startedAt: Date,
  endedAt: Date,
): Promise<readonly CountRow[]> {
  const timestamp = table === "print_jobs" ? "created_at" : "recorded_at";
  const result = await client.query<CountRow>(
    `SELECT ${column} AS value, COUNT(*)::integer AS count
       FROM ${table}
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND ${timestamp} >= $3 AND ${timestamp} < $4
      GROUP BY ${column}`,
    [orgId, storeId, startedAt, endedAt],
  );
  return result.rows;
}

const PRINT_STATUSES: readonly PrintStatus[] = ["queued", "printing", "done", "failed"];
const REPLAY_DECISIONS: readonly ReplayDecision[] = [
  "applied",
  "duplicate",
  "arbitration",
  "collision",
  "rejected",
];

function safeCounts<const TValue extends string, const TKey extends "status" | "decision">(
  rows: readonly CountRow[],
  values: readonly TValue[],
  key: TKey,
): readonly Readonly<Record<TKey, TValue> & { count: number }>[] {
  return Object.freeze(
    values.flatMap((value) => {
      const row = rows.find((candidate) => candidate.value === value);
      return row === undefined
        ? []
        : [
            Object.freeze({
              [key]: value,
              count: requireSafeInteger(row.count, `${key} count`),
            }) as Readonly<Record<TKey, TValue> & { count: number }>,
          ];
    }),
  );
}

export function createPgReconciliationSource(
  timeZone: string,
  rolloverHour = 0,
): ReconciliationReadPort {
  return Object.freeze({
    readDay: async (input): Promise<ReconciliationSnapshot> => {
      const orders = await readOrders(input);
      const ledger = await readLedger(input, orders.paid_cents);
      const [startedAt, endedAt] = dayBounds(input.businessDate, timeZone, rolloverHour);
      const printRows = await groupedCounts(
        input.client,
        "print_jobs",
        "status",
        input.tenant.orgId,
        input.tenant.storeId,
        startedAt,
        endedAt,
      );
      const replayRows = await groupedCounts(
        input.client,
        "edge_replay_records",
        "decision",
        input.tenant.orgId,
        input.tenant.storeId,
        startedAt,
        endedAt,
      );
      const statuses = safeCounts(printRows, PRINT_STATUSES, "status");
      const decisions = safeCounts(replayRows, REPLAY_DECISIONS, "decision");
      return Object.freeze({
        business_date: input.businessDate,
        orders,
        ledger,
        shift: await readShift(input),
        print: Object.freeze({
          total: statuses.reduce((total, row) => total + row.count, 0),
          statuses,
        }),
        edge_replay: Object.freeze({
          total: decisions.reduce((total, row) => total + row.count, 0),
          conflict_count: decisions
            .filter((row) => ["arbitration", "collision", "rejected"].includes(row.decision))
            .reduce((total, row) => total + row.count, 0),
          decisions,
        }),
      });
    },
  });
}

export function createPgEdgeConflictReadPort(): EdgeConflictReadPort {
  return Object.freeze({
    hasDiscardableConflict: async (client, tenant, queueId): Promise<boolean> => {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM edge_replay_records
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND reported_queue_id = $3::uuid
              AND decision IN ('arbitration', 'collision', 'rejected')
         ) AS exists`,
        [tenant.orgId, tenant.storeId, queueId],
      );
      return result.rows[0]?.exists === true;
    },
  });
}
