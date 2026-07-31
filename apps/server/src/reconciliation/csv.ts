import type { ReconciliationDayResult } from "@laundry/contracts";

const FORMULA_PREFIX = /^[\s]*[=+\-@]/u;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/** RFC 4180 cell escaping plus spreadsheet formula-injection hardening. */
export function escapeReconciliationCsvCell(value: string | number): string {
  const raw = String(value);
  const safe = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function row(...cells: readonly (string | number)[]): string {
  return cells.map(escapeReconciliationCsvCell).join(",");
}

export function buildReconciliationCsv(summary: DeepReadonly<ReconciliationDayResult>): string {
  const rows: string[] = [
    row("section", "key_1", "key_2", "value"),
    row("meta", "business_date", "", summary.business_date),
    row("orders", "count", "", summary.orders.count),
    row("orders", "payable_cents", "", summary.orders.payable_cents),
    row("orders", "paid_cents", "", summary.orders.paid_cents),
    row("orders", "balance_cents", "", summary.orders.balance_cents),
    row("ledger", "row_count", "", summary.ledger.row_count),
    row("ledger", "gross_cents", "", summary.ledger.gross_cents),
    row("ledger", "refund_cents", "", summary.ledger.refund_cents),
    row("ledger", "net_cents", "", summary.ledger.net_cents),
    row("ledger", "difference_from_orders_cents", "", summary.ledger.difference_from_orders_cents),
  ];
  for (const bucket of summary.ledger.buckets) {
    rows.push(row("ledger_bucket", bucket.method, `${bucket.kind}.row_count`, bucket.row_count));
    rows.push(
      row("ledger_bucket", bucket.method, `${bucket.kind}.amount_cents`, bucket.amount_cents),
    );
    rows.push(row("ledger_bucket", bucket.method, `${bucket.kind}.net_cents`, bucket.net_cents));
  }
  if (summary.shift === null) {
    rows.push(row("shift", "closed", "", "false"));
  } else {
    rows.push(
      row("shift", "closed", "", "true"),
      row("shift", "closed_at", "", summary.shift.closed_at),
      row("shift", "order_count", "", summary.shift.order_count),
      row("shift", "payable_cents", "", summary.shift.payable_cents),
      row("shift", "paid_cents", "", summary.shift.paid_cents),
      row("shift", "payment_cents", "", summary.shift.payment_cents),
      row("shift", "counted_cash_cents", "", summary.shift.counted_cash_cents),
      row("shift", "retained_float_cents", "", summary.shift.retained_float_cents),
      row("shift", "expected_cash_cents", "", summary.shift.expected_cash_cents),
      row("shift", "cash_difference_cents", "", summary.shift.cash_difference_cents),
    );
  }
  rows.push(row("print", "total", "", summary.print.total));
  for (const status of summary.print.statuses) {
    rows.push(row("print", status.status, "count", status.count));
  }
  rows.push(
    row("edge_replay", "total", "", summary.edge_replay.total),
    row("edge_replay", "conflict_count", "", summary.edge_replay.conflict_count),
  );
  for (const decision of summary.edge_replay.decisions) {
    rows.push(row("edge_replay", decision.decision, "count", decision.count));
  }
  return `${rows.join("\r\n")}\r\n`;
}
