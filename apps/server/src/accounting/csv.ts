import type { AccountingReportResult } from "@laundry/contracts";

const FORMULA_PREFIX = /^\s*[=+\-@]/u;

export function escapeAccountingCsvCell(value: string | number): string {
  const text = String(value);
  const hardened = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return `"${hardened.replaceAll('"', '""')}"`;
}

function csvRow(values: readonly (string | number)[]): string {
  return values.map(escapeAccountingCsvCell).join(",");
}

export function buildAccountingCsv(report: AccountingReportResult): string {
  const rows: string[] = [
    csvRow([
      "section",
      "key",
      "label",
      "real_income_cents",
      "performance_income_cents",
      "order_cashflow_cents",
      "stored_value_cashflow_cents",
      "stored_value_consumption_cents",
      "ledger_row_count",
    ]),
    csvRow(["meta", "date_from", report.date_from, 0, 0, 0, 0, 0, 0]),
    csvRow(["meta", "date_to", report.date_to, 0, 0, 0, 0, 0, 0]),
    csvRow(["meta", "group_by", report.group_by, 0, 0, 0, 0, 0, 0]),
    csvRow([
      "totals",
      "all",
      "合计",
      report.totals.real_income_cents,
      report.totals.performance_income_cents,
      report.totals.order_cashflow_cents,
      report.totals.stored_value_cashflow_cents,
      report.totals.stored_value_consumption_cents,
      report.totals.ledger_row_count,
    ]),
  ];
  for (const channel of report.channels) {
    rows.push(
      csvRow([
        "channel",
        channel.method,
        channel.method,
        channel.real_income_cents,
        channel.performance_income_cents,
        channel.order_income_cents,
        channel.stored_value_cashflow_cents,
        channel.method === "balance" ? channel.performance_income_cents : 0,
        channel.ledger_row_count,
      ]),
    );
  }
  for (const row of report.rows) {
    rows.push(
      csvRow([
        "group",
        row.key,
        row.label,
        row.real_income_cents,
        row.performance_income_cents,
        row.order_cashflow_cents,
        row.stored_value_cashflow_cents,
        row.stored_value_consumption_cents,
        row.ledger_row_count,
      ]),
    );
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}
