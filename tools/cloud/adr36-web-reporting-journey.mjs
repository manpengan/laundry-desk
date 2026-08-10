import { asRecord, requireString, requireThat, requireUuid } from "./adr36-web-core.mjs";
import { stableExport } from "./adr36-web-reporting-csv.mjs";
import {
  readReport,
  readStats,
  reportIsZero,
  sameBasis,
  stableJson,
  statsAreZero,
  zeroBasis,
} from "./adr36-web-reporting-data.mjs";
import { closeHistoricalEmptyDay, selectHistoricalEmptyDay } from "./adr36-web-reporting-shift.mjs";

export { verifyAccountingCsvExport } from "./adr36-web-reporting-csv.mjs";
export { reminderHistoryJourney } from "./adr36-web-reminder-history.mjs";
export { selectHistoricalEmptyDay } from "./adr36-web-reporting-shift.mjs";

/**
 * API expected by this journey. The production acceptance client supplies both methods.
 *
 * @typedef {Readonly<{
 *   query: (session: unknown, name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>,
 *   confirmReplayable: (session: unknown, name: string, args: Readonly<Record<string, unknown>>) => Promise<Readonly<{result: unknown, replay: () => Promise<unknown>}>>,
 * }>} ReportingJourneyApi
 */

function reportingContext(value) {
  const context = asRecord(value, "REPORTING_CONTEXT_INVALID");
  const session = asRecord(context.session, "REPORTING_CONTEXT_INVALID");
  const staffId = requireUuid(session.staffId, "REPORTING_CONTEXT_INVALID");
  const signatureName = requireString(context.signatureName, "REPORTING_CONTEXT_INVALID");
  const note = requireString(context.note, "REPORTING_CONTEXT_INVALID");
  requireThat(typeof context.markShiftCleanupUncertain === "function", "REPORTING_CONTEXT_INVALID");
  return Object.freeze({
    session: context.session,
    staffId,
    signatureName,
    note,
    markShiftCleanupUncertain: context.markShiftCleanupUncertain,
  });
}

async function currentReporting(api, context) {
  const statsBefore = await readStats(api, context.session);
  const today = statsBefore.business_date;
  requireThat(
    (await api.query(context.session, "shift.get", { business_date: today })) === null,
    "TODAY_SHIFT_ALREADY_CLOSED",
  );
  const todayDay = await stableExport(api, context.session, {
    dateFrom: today,
    dateTo: today,
    groupBy: "day",
  });
  const monthExpected = Object.freeze({
    dateFrom: `${today.slice(0, 7)}-01`,
    dateTo: today,
    groupBy: "day",
  });
  const monthBefore = await readReport(api, context.session, monthExpected);
  const todayStaff = await stableExport(api, context.session, {
    dateFrom: today,
    dateTo: today,
    groupBy: "staff",
  });
  const monthAfter = await readReport(api, context.session, monthExpected);
  requireThat(stableJson(monthAfter) === stableJson(monthBefore), "ACCOUNTING_SNAPSHOT_DRIFT");
  requireThat(
    sameBasis(todayDay.report.totals, todayStaff.report.totals),
    "ACCOUNTING_DAY_STAFF_MISMATCH",
  );
  if (todayStaff.report.totals.ledger_row_count > 0) {
    requireThat(
      todayStaff.report.rows.some((row) => row.key === context.staffId),
      "ACCOUNTING_ACTOR_ROW_MISSING",
    );
  }
  const monthToday = monthBefore.rows.find((row) => row.key === today);
  requireThat(
    sameBasis(monthToday ?? zeroBasis(), todayDay.report.totals),
    "ACCOUNTING_MONTH_DAY_MISMATCH",
  );
  const statsAfter = await readStats(api, context.session);
  requireThat(stableJson(statsAfter) === stableJson(statsBefore), "STATS_SNAPSHOT_DRIFT");
  return Object.freeze({ today, monthFrom: monthExpected.dateFrom, todayDay, todayStaff });
}

async function assertHistoricalDayStayedEmpty(api, context, businessDate) {
  const stats = await readStats(api, context.session, businessDate);
  const accounting = await readReport(api, context.session, {
    dateFrom: businessDate,
    dateTo: businessDate,
    groupBy: "day",
  });
  requireThat(statsAreZero(stats) && reportIsZero(accounting), "HISTORICAL_EMPTY_DAY_CHANGED");
}

export function reminderHistoryBlockedResult() {
  return Object.freeze({
    journey: "reminder_history",
    status: "BLOCKED",
    code: "AUDITED_TIME_FIXTURE_REQUIRED",
  });
}

/**
 * Validate reporting and close exactly one empty date in the fixed historical UAT window.
 * This function never queries reminder candidates and never uses a database connection.
 *
 * @param {ReportingJourneyApi} api
 * @param {Readonly<{session: Readonly<{staffId: string}>, signatureName: string, note: string, markShiftCleanupUncertain: (value: boolean) => void}>} context
 */
export async function reportingJourney(api, context) {
  requireThat(typeof api?.query === "function", "REPORTING_API_INVALID");
  requireThat(typeof api?.confirmReplayable === "function", "REPORTING_API_INVALID");
  const safeContext = reportingContext(context);
  const current = await currentReporting(api, safeContext);
  const selected = await selectHistoricalEmptyDay(api, safeContext.session, current.today);
  const closed = await closeHistoricalEmptyDay(api, safeContext, selected);
  await assertHistoricalDayStayedEmpty(api, safeContext, selected.businessDate);
  requireThat(
    (await api.query(safeContext.session, "shift.get", { business_date: current.today })) === null,
    "TODAY_SHIFT_CLOSED",
  );
  return Object.freeze({
    today: current.today,
    monthFrom: current.monthFrom,
    dayExportSha256: current.todayDay.sha256,
    staffExportSha256: current.todayStaff.sha256,
    historicalBusinessDate: selected.businessDate,
    historicalShiftId: closed.closed.shift_id,
    previousRetainedFloatCents: closed.previousFloat,
    reminderHistory: reminderHistoryBlockedResult(),
  });
}
