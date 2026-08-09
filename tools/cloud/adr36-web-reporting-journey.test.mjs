import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  reminderHistoryBlockedResult,
  reportingJourney,
  selectHistoricalEmptyDay,
} from "./adr36-web-reporting-journey.mjs";

const TODAY = "2026-08-09";
const ADMIN_ID = "11111111-1111-4111-8111-111111111101";
const SHIFT_ID = "77777777-7777-4777-8777-777777777701";
const PREVIOUS_SHIFT_ID = "77777777-7777-4777-8777-777777777700";
const SESSION = Object.freeze({ staffId: ADMIN_ID });
const CONTEXT = Object.freeze({
  session: SESSION,
  signatureName: "ADR36 UAT Owner",
  note: "ADR36-reporting-uat",
  markShiftCleanupUncertain: () => {},
});
const BASIS_FIELDS = Object.freeze([
  "real_income_cents",
  "performance_income_cents",
  "order_cashflow_cents",
  "stored_value_cashflow_cents",
  "stored_value_consumption_cents",
  "ledger_row_count",
]);
const ACTIVE_BASIS = Object.freeze({
  real_income_cents: 4_200,
  performance_income_cents: 5_200,
  order_cashflow_cents: 2_600,
  stored_value_cashflow_cents: 1_600,
  stored_value_consumption_cents: 2_600,
  ledger_row_count: 6,
});
const DRIFTED_BASIS = Object.freeze({
  real_income_cents: 4_300,
  performance_income_cents: 5_300,
  order_cashflow_cents: 2_700,
  stored_value_cashflow_cents: 1_600,
  stored_value_consumption_cents: 2_600,
  ledger_row_count: 7,
});
const ZERO_BASIS = Object.freeze(Object.fromEntries(BASIS_FIELDS.map((field) => [field, 0])));

function channels(active = ACTIVE_BASIS) {
  const cashOrder = active.order_cashflow_cents;
  const balanceOrder = active.stored_value_consumption_cents;
  const cashLedgerRows = active.ledger_row_count === 0 ? 0 : active.ledger_row_count - 1;
  return [
    {
      method: "cash",
      order_income_cents: cashOrder,
      stored_value_cashflow_cents: active.stored_value_cashflow_cents,
      real_income_cents: active.real_income_cents,
      performance_income_cents: cashOrder,
      ledger_row_count: cashLedgerRows,
    },
    ...["wechat", "alipay", "other"].map((method) => ({
      method,
      order_income_cents: 0,
      stored_value_cashflow_cents: 0,
      real_income_cents: 0,
      performance_income_cents: 0,
      ledger_row_count: 0,
    })),
    {
      method: "balance",
      order_income_cents: balanceOrder,
      stored_value_cashflow_cents: 0,
      real_income_cents: 0,
      performance_income_cents: balanceOrder,
      ledger_row_count: active.ledger_row_count === 0 ? 0 : 1,
    },
  ];
}

function accountingReport(dateFrom, dateTo, groupBy, basis = ACTIVE_BASIS) {
  const empty = basis.ledger_row_count === 0;
  const key = groupBy === "day" ? dateTo : ADMIN_ID;
  const label = groupBy === "day" ? dateTo : "ADR36 UAT Owner";
  return {
    date_from: dateFrom,
    date_to: dateTo,
    group_by: groupBy,
    staff_id: null,
    generated_at: "2026-08-09T12:00:00.000Z",
    totals: basis,
    channels: channels(basis),
    rows: empty ? [] : [{ key, label, ...basis }],
  };
}

function stats(businessDate, active = false) {
  return {
    business_date: businessDate,
    order_count: active ? 2 : 0,
    garment_count: active ? 2 : 0,
    payable_cents: active ? 5_200 : 0,
    paid_cents: active ? 5_200 : 0,
    balance_cents: 0,
    payment_cents: active ? 2_600 : 0,
    picked_garment_count: active ? 2 : 0,
  };
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function accountingCsv(report) {
  const row = (values) => values.map(csvCell).join(",");
  const basis = (value) => BASIS_FIELDS.map((field) => value[field]);
  const rows = [
    [
      "section",
      "key",
      "label",
      "real_income_cents",
      "performance_income_cents",
      "order_cashflow_cents",
      "stored_value_cashflow_cents",
      "stored_value_consumption_cents",
      "ledger_row_count",
    ],
    ["meta", "date_from", report.date_from, 0, 0, 0, 0, 0, 0],
    ["meta", "date_to", report.date_to, 0, 0, 0, 0, 0, 0],
    ["meta", "group_by", report.group_by, 0, 0, 0, 0, 0, 0],
    ["totals", "all", "合计", ...basis(report.totals)],
    ...report.channels.map((channel) => [
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
    ...report.rows.map((entry) => ["group", entry.key, entry.label, ...basis(entry)]),
  ];
  return `\uFEFF${rows.map(row).join("\r\n")}\r\n`;
}

function exportResult(report, badHash = false) {
  const csv = accountingCsv(report);
  return {
    filename: `accounting-${report.date_from}-${report.date_to}-${report.group_by}.csv`,
    content_sha256: badHash
      ? "0".repeat(64)
      : createHash("sha256").update(Buffer.from(csv, "utf8")).digest("hex"),
    csv,
  };
}

function previousShift() {
  return {
    shift_id: PREVIOUS_SHIFT_ID,
    business_date: "2026-05-01",
    closed_at: 1_778_000_000,
    order_count: 0,
    payable_cents: 0,
    paid_cents: 0,
    payment_cents: 0,
    opening_float_cents: 0,
    counted_cash_cents: 1_200,
    retained_float_cents: 1_200,
    expected_cash_cents: 0,
    cash_difference_cents: 1_200,
    period_started_at: 1_777_900_000,
    period_ended_at: 1_778_000_000,
    signature_name: "Earlier Owner",
    closed_by_staff_id: ADMIN_ID,
    note: null,
  };
}

function closedShift(input) {
  return {
    shift_id: SHIFT_ID,
    business_date: input.business_date,
    closed_at: 1_779_000_000,
    order_count: 0,
    payable_cents: 0,
    paid_cents: 0,
    payment_cents: 0,
    opening_float_cents: 1_200,
    counted_cash_cents: input.counted_cash_cents,
    retained_float_cents: input.retained_float_cents,
    expected_cash_cents: 1_200,
    cash_difference_cents: 0,
    period_started_at: previousShift().closed_at,
    period_ended_at: 1_779_000_000,
    signature_name: input.signature_name,
    closed_by_staff_id: ADMIN_ID,
    note: input.note,
  };
}

function createStubApi(options = {}) {
  const calls = [];
  const reportReads = new Map();
  const shiftCollisions = new Set(options.shiftCollisions ?? []);
  const statsCollisions = new Set(options.statsCollisions ?? []);
  const accountingCollisions = new Set(options.accountingCollisions ?? []);
  let closed = null;

  const reportFor = (args, countRead = true) => {
    const key = `${args.date_from}:${args.date_to}:${args.group_by}`;
    const reads = reportReads.get(key) ?? 0;
    if (countRead) reportReads.set(key, reads + 1);
    if (accountingCollisions.has(args.date_from)) {
      return accountingReport(args.date_from, args.date_to, args.group_by, ACTIVE_BASIS);
    }
    const current = args.date_to === TODAY;
    if (
      options.driftTodayDay === true &&
      args.date_from === TODAY &&
      args.date_to === TODAY &&
      args.group_by === "day" &&
      countRead &&
      reads > 0
    ) {
      return accountingReport(args.date_from, args.date_to, args.group_by, DRIFTED_BASIS);
    }
    return accountingReport(
      args.date_from,
      args.date_to,
      args.group_by,
      current ? ACTIVE_BASIS : ZERO_BASIS,
    );
  };

  const query = async (_session, name, args) => {
    calls.push({ kind: "query", name, args: { ...args } });
    if (name === "stats.day.summary") {
      const date = args.business_date ?? TODAY;
      return stats(date, date === TODAY || statsCollisions.has(date));
    }
    if (name === "accounting.report.get") return reportFor(args);
    if (name === "shift.get") {
      if (args.business_date === TODAY) return null;
      if (closed?.business_date === args.business_date) return closed;
      return shiftCollisions.has(args.business_date)
        ? { ...previousShift(), business_date: args.business_date }
        : null;
    }
    if (name === "shift.history") {
      if (args.date_from === args.date_to && closed?.business_date === args.date_from) {
        return { shifts: [closed] };
      }
      return { shifts: [previousShift()] };
    }
    assert.fail(`unexpected query ${name}`);
  };

  const confirmReplayable = async (_session, name, args) => {
    calls.push({ kind: "command", name, args: { ...args } });
    if (name === "accounting.report.export") {
      const report = reportFor(args, false);
      const result = exportResult(report, options.badHash === true);
      return Object.freeze({ result, replay: async () => result });
    }
    if (name === "shift.close") {
      if (options.throwBeforeShiftCommit === true) throw new Error("lost before shift commit");
      closed = closedShift(args);
      if (options.throwAfterShiftCommit === true) throw new Error("lost after shift commit");
      return Object.freeze({ result: closed, replay: async () => closed });
    }
    assert.fail(`unexpected command ${name}`);
  };

  return Object.freeze({ query, confirmReplayable, calls });
}

test("reporting journey validates stable day/month/staff CSV and closes one historical empty day", async () => {
  const api = createStubApi();
  const uncertainty = [];
  const result = await reportingJourney(api, {
    ...CONTEXT,
    markShiftCleanupUncertain: (value) => uncertainty.push(value),
  });

  assert.equal(result.today, TODAY);
  assert.equal(result.monthFrom, "2026-08-01");
  assert.equal(result.historicalBusinessDate, "2026-06-10");
  assert.equal(result.historicalShiftId, SHIFT_ID);
  assert.equal(result.previousRetainedFloatCents, 1_200);
  assert.match(result.dayExportSha256, /^[0-9a-f]{64}$/u);
  assert.match(result.staffExportSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.reminderHistory, reminderHistoryBlockedResult());
  assert.equal(
    api.calls.some((call) => call.name.startsWith("notification.")),
    false,
  );
  assert.deepEqual(
    api.calls.filter((call) => call.kind === "command").map((call) => call.name),
    ["accounting.report.export", "accounting.report.export", "shift.close"],
  );
  assert.deepEqual(uncertainty, [true, false]);
});

test("a lost shift-close response is recovered only from the exact historical readback", async () => {
  const api = createStubApi({ throwAfterShiftCommit: true });
  const uncertainty = [];
  const result = await reportingJourney(api, {
    ...CONTEXT,
    markShiftCleanupUncertain: (value) => uncertainty.push(value),
  });

  assert.equal(result.historicalShiftId, SHIFT_ID);
  assert.deepEqual(uncertainty, [true, false]);
});

test("an unconfirmed shift-close outcome leaves cleanup uncertainty set", async () => {
  const api = createStubApi({ throwBeforeShiftCommit: true });
  const uncertainty = [];
  await assert.rejects(
    reportingJourney(api, {
      ...CONTEXT,
      markShiftCleanupUncertain: (value) => uncertainty.push(value),
    }),
    /lost before shift commit/u,
  );
  assert.deepEqual(uncertainty, [true]);
});

test("reporting journey rejects a CSV digest that is not the SHA-256 of raw UTF-8 bytes", async () => {
  const api = createStubApi({ badHash: true });
  await assert.rejects(
    reportingJourney(api, CONTEXT),
    (error) => error?.code === "ACCOUNTING_CSV_HASH_INVALID",
  );
});

test("reporting journey rejects query drift across an export", async () => {
  const api = createStubApi({ driftTodayDay: true });
  await assert.rejects(
    reportingJourney(api, CONTEXT),
    (error) => error?.code === "ACCOUNTING_SNAPSHOT_DRIFT",
  );
});

test("historical empty-day selection probes past shift, stats and accounting collisions linearly", async () => {
  const api = createStubApi({
    shiftCollisions: ["2026-06-10"],
    statsCollisions: ["2026-06-11"],
    accountingCollisions: ["2026-06-12"],
  });
  const selected = await selectHistoricalEmptyDay(api, SESSION, TODAY);

  assert.equal(selected.businessDate, "2026-06-13");
  assert.deepEqual(
    api.calls.filter((call) => call.name === "shift.get").map((call) => call.args.business_date),
    ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"],
  );
  assert.deepEqual(
    api.calls
      .filter((call) => call.name === "stats.day.summary")
      .map((call) => call.args.business_date),
    ["2026-06-11", "2026-06-12", "2026-06-13"],
  );
});
