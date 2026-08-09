import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";
import {
  moveBusinessDate,
  readReport,
  readStats,
  reportIsZero,
  requireBusinessDate,
  stableJson,
  statsAreZero,
} from "./adr36-web-reporting-data.mjs";

const HISTORY_FLOOR = "2000-01-01";
const HISTORY_WINDOW = Object.freeze({ oldestDaysAgo: 60, newestDaysAgo: 31 });
const SHIFT_NONNEGATIVE_FIELDS = Object.freeze([
  "order_count",
  "payable_cents",
  "paid_cents",
  "payment_cents",
  "opening_float_cents",
  "counted_cash_cents",
  "retained_float_cents",
  "expected_cash_cents",
]);

function normalizeShift(value, expectedDate) {
  const record = asRecord(value, "SHIFT_RESULT_INVALID");
  const businessDate = requireBusinessDate(record.business_date, "SHIFT_RESULT_INVALID");
  if (expectedDate !== undefined) {
    requireThat(businessDate === expectedDate, "SHIFT_RESULT_INVALID");
  }
  const amounts = Object.fromEntries(
    SHIFT_NONNEGATIVE_FIELDS.map((field) => {
      const amount = requireInteger(record[field], "SHIFT_RESULT_INVALID");
      requireThat(amount >= 0, "SHIFT_RESULT_INVALID");
      return [field, amount];
    }),
  );
  return Object.freeze({
    shift_id: requireUuid(record.shift_id, "SHIFT_RESULT_INVALID"),
    business_date: businessDate,
    closed_at: requireInteger(record.closed_at, "SHIFT_RESULT_INVALID"),
    ...amounts,
    cash_difference_cents: requireInteger(record.cash_difference_cents, "SHIFT_RESULT_INVALID"),
    period_started_at: requireInteger(record.period_started_at, "SHIFT_RESULT_INVALID"),
    period_ended_at: requireInteger(record.period_ended_at, "SHIFT_RESULT_INVALID"),
    signature_name: requireString(record.signature_name, "SHIFT_RESULT_INVALID"),
    closed_by_staff_id: requireUuid(record.closed_by_staff_id, "SHIFT_RESULT_INVALID"),
    note: record.note === null ? null : requireString(record.note, "SHIFT_RESULT_INVALID"),
  });
}

export async function selectHistoricalEmptyDay(api, session, today) {
  requireBusinessDate(today, "STATS_DATE_INVALID");
  for (
    let daysAgo = HISTORY_WINDOW.oldestDaysAgo;
    daysAgo >= HISTORY_WINDOW.newestDaysAgo;
    daysAgo -= 1
  ) {
    const businessDate = moveBusinessDate(today, -daysAgo);
    const shift = await api.query(session, "shift.get", { business_date: businessDate });
    if (shift !== null) {
      normalizeShift(shift, businessDate);
      continue;
    }
    const stats = await readStats(api, session, businessDate);
    if (!statsAreZero(stats)) continue;
    const accounting = await readReport(api, session, {
      dateFrom: businessDate,
      dateTo: businessDate,
      groupBy: "day",
    });
    if (!reportIsZero(accounting)) continue;
    return Object.freeze({ businessDate, stats, accounting });
  }
  requireThat(false, "HISTORICAL_UAT_WINDOW_EXHAUSTED");
}

async function previousShift(api, session, businessDate) {
  const result = asRecord(
    await api.query(session, "shift.history", {
      date_from: HISTORY_FLOOR,
      date_to: moveBusinessDate(businessDate, -1),
      limit: 1,
    }),
    "SHIFT_HISTORY_INVALID",
  );
  requireThat(Array.isArray(result.shifts) && result.shifts.length <= 1, "SHIFT_HISTORY_INVALID");
  if (result.shifts.length === 0) return null;
  const row = normalizeShift(result.shifts[0], undefined);
  requireThat(row.business_date < businessDate, "SHIFT_HISTORY_INVALID");
  return row;
}

function assertEmptyShiftSnapshot(row, expected) {
  requireThat(
    row.business_date === expected.businessDate &&
      row.order_count === 0 &&
      row.payable_cents === 0 &&
      row.paid_cents === 0 &&
      row.payment_cents === 0 &&
      row.opening_float_cents === expected.previousFloat &&
      row.counted_cash_cents === expected.previousFloat &&
      row.retained_float_cents === expected.previousFloat &&
      row.expected_cash_cents === expected.previousFloat &&
      row.cash_difference_cents === 0 &&
      row.signature_name === expected.signatureName &&
      row.closed_by_staff_id === expected.staffId &&
      row.note === expected.note &&
      row.closed_at === row.period_ended_at &&
      row.period_started_at <= row.period_ended_at &&
      (expected.previous === null || row.period_started_at === expected.previous.closed_at),
    "SHIFT_CLOSE_SNAPSHOT_INVALID",
  );
}

async function revalidateEmptyDay(api, context, selected) {
  const stillOpen = await api.query(context.session, "shift.get", {
    business_date: selected.businessDate,
  });
  const stats = await readStats(api, context.session, selected.businessDate);
  const accounting = await readReport(api, context.session, {
    dateFrom: selected.businessDate,
    dateTo: selected.businessDate,
    groupBy: "day",
  });
  requireThat(
    stillOpen === null &&
      stableJson(stats) === stableJson(selected.stats) &&
      stableJson(accounting) === stableJson(selected.accounting),
    "HISTORICAL_EMPTY_DAY_DRIFT",
  );
}

async function executeRecoverableClose(api, context, input, expected) {
  context.markShiftCleanupUncertain(true);
  let closed;
  let replay = null;
  try {
    const execution = asRecord(
      await api.confirmReplayable(context.session, "shift.close", input),
      "SHIFT_CLOSE_INVALID",
    );
    requireThat(typeof execution.replay === "function", "SHIFT_CLOSE_REPLAY_INVALID");
    closed = normalizeShift(execution.result, input.business_date);
    assertEmptyShiftSnapshot(closed, expected);
    replay = execution.replay;
    context.markShiftCleanupUncertain(false);
  } catch (error) {
    let recovered;
    try {
      recovered = await api.query(context.session, "shift.get", {
        business_date: input.business_date,
      });
    } catch {
      throw error;
    }
    if (recovered === null) throw error;
    closed = normalizeShift(recovered, input.business_date);
    assertEmptyShiftSnapshot(closed, expected);
    context.markShiftCleanupUncertain(false);
  }
  if (replay !== null) {
    const replayed = normalizeShift(await replay(), input.business_date);
    requireThat(stableJson(replayed) === stableJson(closed), "SHIFT_CLOSE_REPLAY_INVALID");
  }
  return closed;
}

async function assertShiftReadback(api, context, businessDate, closed) {
  const got = normalizeShift(
    await api.query(context.session, "shift.get", { business_date: businessDate }),
    businessDate,
  );
  requireThat(stableJson(got) === stableJson(closed), "SHIFT_GET_READBACK_INVALID");
  const history = asRecord(
    await api.query(context.session, "shift.history", {
      date_from: businessDate,
      date_to: businessDate,
      limit: 10,
    }),
    "SHIFT_HISTORY_INVALID",
  );
  requireThat(
    Array.isArray(history.shifts) && history.shifts.length === 1,
    "SHIFT_HISTORY_INVALID",
  );
  const listed = normalizeShift(history.shifts[0], businessDate);
  requireThat(stableJson(listed) === stableJson(closed), "SHIFT_HISTORY_READBACK_INVALID");
}

export async function closeHistoricalEmptyDay(api, context, selected) {
  const previous = await previousShift(api, context.session, selected.businessDate);
  const previousFloat = previous?.retained_float_cents ?? 0;
  await revalidateEmptyDay(api, context, selected);
  const input = Object.freeze({
    business_date: selected.businessDate,
    counted_cash_cents: previousFloat,
    retained_float_cents: previousFloat,
    signature_name: context.signatureName,
    note: context.note,
  });
  const expected = Object.freeze({
    businessDate: selected.businessDate,
    previous,
    previousFloat,
    signatureName: context.signatureName,
    staffId: context.staffId,
    note: context.note,
  });
  const closed = await executeRecoverableClose(api, context, input, expected);
  await assertShiftReadback(api, context, selected.businessDate, closed);
  return Object.freeze({ closed, previousFloat });
}
