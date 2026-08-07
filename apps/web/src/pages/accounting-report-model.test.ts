import assert from "node:assert/strict";
import test from "node:test";

import {
  accountingRangeError,
  monthRange,
  parseAccountingExport,
  parseAccountingReport,
} from "./accounting-report-model.js";

const BASIS = Object.freeze({
  real_income_cents: 13_000,
  performance_income_cents: 8_000,
  order_cashflow_cents: 5_000,
  stored_value_cashflow_cents: 8_000,
  stored_value_consumption_cents: 3_000,
  ledger_row_count: 4,
});

const REPORT = Object.freeze({
  date_from: "2026-08-01",
  date_to: "2026-08-31",
  group_by: "day",
  staff_id: null,
  generated_at: "2026-08-31T16:00:00.000Z",
  totals: BASIS,
  channels: Object.freeze([
    Object.freeze({
      method: "cash",
      order_income_cents: 5_000,
      stored_value_cashflow_cents: 8_000,
      real_income_cents: 13_000,
      performance_income_cents: 5_000,
      ledger_row_count: 3,
    }),
    Object.freeze({
      method: "balance",
      order_income_cents: 3_000,
      stored_value_cashflow_cents: 0,
      real_income_cents: 0,
      performance_income_cents: 3_000,
      ledger_row_count: 1,
    }),
    ...(["wechat", "alipay", "other"] as const).map((method) =>
      Object.freeze({
        method,
        order_income_cents: 0,
        stored_value_cashflow_cents: 0,
        real_income_cents: 0,
        performance_income_cents: 0,
        ledger_row_count: 0,
      }),
    ),
  ]),
  rows: Object.freeze([Object.freeze({ key: "2026-08-07", label: "2026-08-07", ...BASIS })]),
});

test("parseAccountingReport accepts exact integer-fen dual-basis evidence", () => {
  assert.deepEqual(parseAccountingReport(REPORT), REPORT);
});

test("parseAccountingReport rejects duplicate channels, unsafe money, and extra fields", () => {
  assert.equal(
    parseAccountingReport({ ...REPORT, channels: [REPORT.channels[0], REPORT.channels[0]] }),
    null,
  );
  assert.equal(
    parseAccountingReport({
      ...REPORT,
      totals: { ...BASIS, real_income_cents: Number.MAX_SAFE_INTEGER + 1 },
    }),
    null,
  );
  assert.equal(parseAccountingReport({ ...REPORT, surprise: true }), null);
  assert.equal(parseAccountingReport({ ...REPORT, date_from: "2026-02-31" }), null);
});

test("accounting date helpers bound ranges and calculate leap-year month end", () => {
  assert.deepEqual(monthRange("2028-02"), {
    dateFrom: "2028-02-01",
    dateTo: "2028-02-29",
  });
  assert.equal(monthRange("2028-13"), null);
  assert.equal(accountingRangeError("2026-08-07", "2026-08-07"), null);
  assert.match(accountingRangeError("2026-08-08", "2026-08-07") ?? "", /开始日期/u);
  assert.match(accountingRangeError("2025-01-01", "2026-01-02") ?? "", /366/u);
});

test("parseAccountingExport requires a bounded filename and SHA-256 digest", () => {
  const value = {
    filename: "accounting-2026-08-01-2026-08-31-day.csv",
    content_sha256: "a".repeat(64),
    csv: "\uFEFFsection,key\r\n",
  };
  assert.deepEqual(parseAccountingExport(value), value);
  assert.equal(parseAccountingExport({ ...value, filename: "orders.csv" }), null);
  assert.equal(parseAccountingExport({ ...value, content_sha256: "bad" }), null);
});
