import { createHash } from "node:crypto";

import { asRecord, requireString, requireThat } from "./adr36-web-core.mjs";
import { BASIS_FIELDS, readReport, stableJson } from "./adr36-web-reporting-data.mjs";

const FORMULA_PREFIX = /^\s*[=+\-@]/u;
const CSV_HEADER = Object.freeze([
  "section",
  "key",
  "label",
  "real_income_cents",
  "performance_income_cents",
  "order_cashflow_cents",
  "stored_value_cashflow_cents",
  "stored_value_consumption_cents",
  "ledger_row_count",
]);

function parseQuotedCsvLine(line) {
  const cells = [];
  let cursor = 0;
  while (cursor < line.length) {
    requireThat(line[cursor] === '"', "ACCOUNTING_CSV_INVALID");
    cursor += 1;
    let cell = "";
    let closed = false;
    while (cursor < line.length) {
      if (line[cursor] !== '"') {
        cell += line[cursor];
        cursor += 1;
      } else if (line[cursor + 1] === '"') {
        cell += '"';
        cursor += 2;
      } else {
        cursor += 1;
        closed = true;
        break;
      }
    }
    requireThat(
      closed && (cursor === line.length || line[cursor] === ","),
      "ACCOUNTING_CSV_INVALID",
    );
    cells.push(cell);
    if (cursor < line.length) cursor += 1;
  }
  return Object.freeze(cells);
}

function parseAccountingCsv(csv) {
  requireThat(
    typeof csv === "string" &&
      csv.startsWith("\uFEFF") &&
      csv.endsWith("\r\n") &&
      !/(^|[^\r])\n|\r(?!\n)/u.test(csv),
    "ACCOUNTING_CSV_LINE_ENDING_INVALID",
  );
  const lines = csv.slice(1, -2).split("\r\n");
  requireThat(lines.length >= 10, "ACCOUNTING_CSV_INVALID");
  return Object.freeze(lines.map(parseQuotedCsvLine));
}

function expectedCsvRows(report) {
  const basisCells = (value) => BASIS_FIELDS.map((field) => String(value[field]));
  const textCell = (value) => (FORMULA_PREFIX.test(value) ? `'${value}` : value);
  const metadata = [
    ["meta", "date_from", report.date_from, ...Array(6).fill("0")],
    ["meta", "date_to", report.date_to, ...Array(6).fill("0")],
    ["meta", "group_by", report.group_by, ...Array(6).fill("0")],
  ];
  const totals = [["totals", "all", "合计", ...basisCells(report.totals)]];
  const channels = report.channels.map((channel) => [
    "channel",
    channel.method,
    channel.method,
    String(channel.real_income_cents),
    String(channel.performance_income_cents),
    String(channel.order_income_cents),
    String(channel.stored_value_cashflow_cents),
    String(channel.method === "balance" ? channel.performance_income_cents : 0),
    String(channel.ledger_row_count),
  ]);
  const groups = report.rows.map((row) => [
    "group",
    textCell(row.key),
    textCell(row.label),
    ...basisCells(row),
  ]);
  return Object.freeze([CSV_HEADER, ...metadata, ...totals, ...channels, ...groups]);
}

export function verifyAccountingCsvExport(value, report) {
  const record = asRecord(value, "ACCOUNTING_EXPORT_INVALID");
  const csv = requireString(record.csv, "ACCOUNTING_EXPORT_INVALID");
  const digest = createHash("sha256").update(Buffer.from(csv, "utf8")).digest("hex");
  requireThat(record.content_sha256 === digest, "ACCOUNTING_CSV_HASH_INVALID");
  requireThat(
    record.filename === `accounting-${report.date_from}-${report.date_to}-${report.group_by}.csv`,
    "ACCOUNTING_EXPORT_FILENAME_INVALID",
  );
  const parsed = parseAccountingCsv(csv);
  const expected = expectedCsvRows(report);
  requireThat(parsed.length === expected.length, "ACCOUNTING_CSV_ROWS_INVALID");
  requireThat(
    parsed.every(
      (row, index) =>
        row.length === CSV_HEADER.length &&
        row.every((cell, cellIndex) => cell === expected[index][cellIndex]),
    ),
    "ACCOUNTING_CSV_CONTENT_INVALID",
  );
  return Object.freeze({ sha256: digest, rowCount: parsed.length });
}

export async function stableExport(api, session, expected) {
  const before = await readReport(api, session, expected);
  const request = Object.freeze({
    date_from: expected.dateFrom,
    date_to: expected.dateTo,
    group_by: expected.groupBy,
    format: "csv",
  });
  const execution = asRecord(
    await api.confirmReplayable(session, "accounting.report.export", request),
    "ACCOUNTING_EXPORT_INVALID",
  );
  requireThat(typeof execution.replay === "function", "ACCOUNTING_EXPORT_REPLAY_INVALID");
  const verified = verifyAccountingCsvExport(execution.result, before);
  const replayed = await execution.replay();
  const replayVerified = verifyAccountingCsvExport(replayed, before);
  requireThat(replayVerified.sha256 === verified.sha256, "ACCOUNTING_EXPORT_REPLAY_INVALID");
  const after = await readReport(api, session, expected);
  requireThat(stableJson(after) === stableJson(before), "ACCOUNTING_SNAPSHOT_DRIFT");
  return Object.freeze({ report: before, sha256: verified.sha256 });
}
