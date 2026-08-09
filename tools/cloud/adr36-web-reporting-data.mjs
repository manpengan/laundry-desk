import { asRecord, requireInteger, requireString, requireThat } from "./adr36-web-core.mjs";

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const STATS_FIELDS = Object.freeze([
  "order_count",
  "garment_count",
  "payable_cents",
  "paid_cents",
  "balance_cents",
  "payment_cents",
  "picked_garment_count",
]);
export const BASIS_FIELDS = Object.freeze([
  "real_income_cents",
  "performance_income_cents",
  "order_cashflow_cents",
  "stored_value_cashflow_cents",
  "stored_value_consumption_cents",
  "ledger_row_count",
]);
const CHANNEL_FIELDS = Object.freeze([
  "order_income_cents",
  "stored_value_cashflow_cents",
  "real_income_cents",
  "performance_income_cents",
  "ledger_row_count",
]);
const ACCOUNTING_METHODS = Object.freeze(["cash", "wechat", "alipay", "other", "balance"]);

export function requireBusinessDate(value, code = "BUSINESS_DATE_INVALID") {
  requireThat(typeof value === "string" && BUSINESS_DATE.test(value), code);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  requireThat(
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value,
    code,
  );
  return value;
}

export function moveBusinessDate(value, days) {
  const date = new Date(`${requireBusinessDate(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeAdd(left, right, code) {
  const value = left + right;
  requireThat(Number.isSafeInteger(value), code);
  return value;
}

function normalizeStats(value, expectedDate) {
  const record = asRecord(value, "STATS_RESULT_INVALID");
  requireThat(
    requireBusinessDate(record.business_date, "STATS_DATE_INVALID") === expectedDate,
    "STATS_DATE_INVALID",
  );
  const fields = Object.fromEntries(
    STATS_FIELDS.map((field) => {
      const amount = requireInteger(record[field], "STATS_RESULT_INVALID");
      requireThat(amount >= 0, "STATS_RESULT_INVALID");
      return [field, amount];
    }),
  );
  return Object.freeze({ business_date: expectedDate, ...fields });
}

function normalizeBasis(value, code = "ACCOUNTING_RESULT_INVALID") {
  const record = asRecord(value, code);
  const result = Object.freeze(
    Object.fromEntries(
      BASIS_FIELDS.map((field) => {
        const amount = requireInteger(record[field], code);
        if (field === "ledger_row_count") requireThat(amount >= 0, code);
        return [field, amount];
      }),
    ),
  );
  requireThat(
    safeAdd(result.order_cashflow_cents, result.stored_value_cashflow_cents, code) ===
      result.real_income_cents &&
      safeAdd(result.order_cashflow_cents, result.stored_value_consumption_cents, code) ===
        result.performance_income_cents,
    "ACCOUNTING_DUAL_BASIS_INVALID",
  );
  if (result.ledger_row_count === 0) {
    requireThat(
      BASIS_FIELDS.every((field) => result[field] === 0),
      "ACCOUNTING_DUAL_BASIS_INVALID",
    );
  }
  return result;
}

function addBasis(left, right) {
  return Object.freeze(
    Object.fromEntries(
      BASIS_FIELDS.map((field) => [
        field,
        safeAdd(left[field], right[field], "ACCOUNTING_AGGREGATE_INVALID"),
      ]),
    ),
  );
}

export function zeroBasis() {
  return Object.freeze(Object.fromEntries(BASIS_FIELDS.map((field) => [field, 0])));
}

export function sameBasis(left, right) {
  return BASIS_FIELDS.every((field) => left[field] === right[field]);
}

function normalizeChannel(value) {
  const record = asRecord(value, "ACCOUNTING_CHANNEL_INVALID");
  const method = requireString(record.method, "ACCOUNTING_CHANNEL_INVALID");
  requireThat(ACCOUNTING_METHODS.includes(method), "ACCOUNTING_CHANNEL_INVALID");
  const fields = Object.fromEntries(
    CHANNEL_FIELDS.map((field) => {
      const amount = requireInteger(record[field], "ACCOUNTING_CHANNEL_INVALID");
      if (field === "ledger_row_count") requireThat(amount >= 0, "ACCOUNTING_CHANNEL_INVALID");
      return [field, amount];
    }),
  );
  const result = Object.freeze({ method, ...fields });
  const expectedReal = safeAdd(
    method === "balance" ? 0 : result.order_income_cents,
    result.stored_value_cashflow_cents,
    "ACCOUNTING_CHANNEL_INVALID",
  );
  requireThat(
    result.real_income_cents === expectedReal &&
      result.performance_income_cents === result.order_income_cents &&
      (method !== "balance" || result.stored_value_cashflow_cents === 0),
    "ACCOUNTING_CHANNEL_INVALID",
  );
  if (result.ledger_row_count === 0) {
    requireThat(
      CHANNEL_FIELDS.every((field) => result[field] === 0),
      "ACCOUNTING_CHANNEL_INVALID",
    );
  }
  return result;
}

function normalizeRows(value) {
  requireThat(Array.isArray(value), "ACCOUNTING_ROWS_INVALID");
  const rows = value.map((entry) => {
    const record = asRecord(entry, "ACCOUNTING_ROWS_INVALID");
    return Object.freeze({
      key: requireString(record.key, "ACCOUNTING_ROWS_INVALID"),
      label: requireString(record.label, "ACCOUNTING_ROWS_INVALID"),
      ...normalizeBasis(record, "ACCOUNTING_ROWS_INVALID"),
    });
  });
  requireThat(new Set(rows.map((row) => row.key)).size === rows.length, "ACCOUNTING_ROWS_INVALID");
  return Object.freeze(rows);
}

function addChannel(total, channel) {
  return Object.freeze({
    real_income_cents: safeAdd(
      total.real_income_cents,
      channel.real_income_cents,
      "ACCOUNTING_CHANNEL_TOTAL_INVALID",
    ),
    performance_income_cents: safeAdd(
      total.performance_income_cents,
      channel.performance_income_cents,
      "ACCOUNTING_CHANNEL_TOTAL_INVALID",
    ),
    order_cashflow_cents: safeAdd(
      total.order_cashflow_cents,
      channel.method === "balance" ? 0 : channel.order_income_cents,
      "ACCOUNTING_CHANNEL_TOTAL_INVALID",
    ),
    stored_value_cashflow_cents: safeAdd(
      total.stored_value_cashflow_cents,
      channel.stored_value_cashflow_cents,
      "ACCOUNTING_CHANNEL_TOTAL_INVALID",
    ),
    stored_value_consumption_cents: safeAdd(
      total.stored_value_consumption_cents,
      channel.method === "balance" ? channel.performance_income_cents : 0,
      "ACCOUNTING_CHANNEL_TOTAL_INVALID",
    ),
    ledger_row_count: safeAdd(
      total.ledger_row_count,
      channel.ledger_row_count,
      "ACCOUNTING_CHANNEL_TOTAL_INVALID",
    ),
  });
}

function assertReportAggregation(report) {
  const rowTotals = report.rows.reduce(addBasis, zeroBasis());
  requireThat(sameBasis(rowTotals, report.totals), "ACCOUNTING_ROWS_TOTAL_INVALID");
  const channelTotals = report.channels.reduce(addChannel, zeroBasis());
  requireThat(sameBasis(channelTotals, report.totals), "ACCOUNTING_CHANNEL_TOTAL_INVALID");
}

function normalizeReport(value, expected) {
  const record = asRecord(value, "ACCOUNTING_RESULT_INVALID");
  requireThat(
    record.date_from === expected.dateFrom &&
      record.date_to === expected.dateTo &&
      record.group_by === expected.groupBy &&
      record.staff_id === null,
    "ACCOUNTING_SCOPE_INVALID",
  );
  requireThat(
    typeof record.generated_at === "string" && Number.isFinite(Date.parse(record.generated_at)),
    "ACCOUNTING_GENERATED_AT_INVALID",
  );
  requireThat(Array.isArray(record.channels), "ACCOUNTING_CHANNEL_INVALID");
  const channels = Object.freeze(record.channels.map(normalizeChannel));
  requireThat(
    channels.length === ACCOUNTING_METHODS.length &&
      new Set(channels.map((channel) => channel.method)).size === ACCOUNTING_METHODS.length &&
      ACCOUNTING_METHODS.every((method) => channels.some((channel) => channel.method === method)),
    "ACCOUNTING_CHANNEL_INVALID",
  );
  const report = Object.freeze({
    date_from: expected.dateFrom,
    date_to: expected.dateTo,
    group_by: expected.groupBy,
    staff_id: null,
    totals: normalizeBasis(record.totals),
    channels,
    rows: normalizeRows(record.rows),
  });
  assertReportAggregation(report);
  return report;
}

export async function readStats(api, session, businessDate) {
  const args =
    businessDate === undefined ? Object.freeze({}) : Object.freeze({ business_date: businessDate });
  const value = await api.query(session, "stats.day.summary", args);
  const record = asRecord(value, "STATS_RESULT_INVALID");
  const expectedDate =
    businessDate ?? requireBusinessDate(record.business_date, "STATS_DATE_INVALID");
  return normalizeStats(record, expectedDate);
}

export async function readReport(api, session, expected) {
  const args = Object.freeze({
    date_from: expected.dateFrom,
    date_to: expected.dateTo,
    group_by: expected.groupBy,
  });
  return normalizeReport(await api.query(session, "accounting.report.get", args), expected);
}

export function stableJson(value) {
  return JSON.stringify(value);
}

export function statsAreZero(stats) {
  return STATS_FIELDS.every((field) => stats[field] === 0);
}

export function reportIsZero(report) {
  return sameBasis(report.totals, zeroBasis()) && report.rows.length === 0;
}
