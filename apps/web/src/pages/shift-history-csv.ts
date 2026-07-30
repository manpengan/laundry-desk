import type { ShiftClosingView } from "./shift-closing-view.js";

export const SHIFT_HISTORY_CSV_HEADERS = Object.freeze([
  "business_date",
  "signature_name",
  "order_count",
  "payable_cents",
  "paid_cents",
  "payment_cents",
  "opening_float_cents",
  "expected_cash_cents",
  "counted_cash_cents",
  "retained_float_cents",
  "cash_difference_cents",
  "closed_at",
  "note",
] as const);

function csvCell(value: string | number): string {
  const raw = String(value);
  const protectedValue = /^[\t\r ]*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

export function formatShiftHistoryCsv(rows: readonly ShiftClosingView[]): string {
  const body = rows.map((row) =>
    [
      row.business_date,
      row.signature_name ?? "",
      row.order_count,
      row.payable_cents,
      row.paid_cents,
      row.payment_cents,
      row.opening_float_cents ?? 0,
      row.expected_cash_cents ?? 0,
      row.counted_cash_cents,
      row.retained_float_cents,
      row.cash_difference_cents,
      row.closed_at,
      row.note ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${SHIFT_HISTORY_CSV_HEADERS.join(",")}\n${body.join("\n")}${body.length > 0 ? "\n" : ""}`;
}

export function downloadShiftHistoryCsv(
  rows: readonly ShiftClosingView[],
  dateFrom: string,
  dateTo: string,
): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined"
  ) {
    return;
  }
  const blob = new Blob([formatShiftHistoryCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `shift-history-${dateFrom}-${dateTo}.csv`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
