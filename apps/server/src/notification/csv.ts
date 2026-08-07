import type { NotificationManualListCreateResult } from "@laundry/contracts";

const FORMULA_PREFIX = /^\s*[=+\-@]/u;

/** RFC 4180 quoting plus spreadsheet formula-injection hardening. */
export function escapeNotificationCsvCell(value: string | number): string {
  const raw = String(value);
  const safe = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function line(...cells: readonly (string | number)[]): string {
  return cells.map(escapeNotificationCsvCell).join(",");
}

type ManualRow = NotificationManualListCreateResult["rows"][number];

export function buildNotificationCsv(rows: readonly ManualRow[]): string {
  const lines = [
    line(
      "customer_name",
      "customer_phone",
      "ticket_nos",
      "garment_count",
      "balance_cents",
      "message",
    ),
    ...rows.map((row) =>
      line(
        row.customer_name ?? "",
        row.customer_phone,
        row.ticket_nos.join(" "),
        row.garment_count,
        row.balance_cents,
        row.message,
      ),
    ),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
