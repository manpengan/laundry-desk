import type { QueryPort } from "../commands/types.js";

export const OWNER_DASHBOARD_QUERY_NAME = "reporting.owner_dashboard.get";

export type OwnerTrendDays = 7 | 30;

export type OwnerDashboardToday = Readonly<{
  performance_income_cents: number;
  real_income_cents: number;
  picked_up_garment_count: number;
  new_receivable_cents: number;
  new_receivable_order_count: number;
  overdue_garment_count: number;
  overdue_order_count: number;
}>;

export type OwnerDashboardTrendRow = Readonly<{
  business_date: string;
  performance_income_cents: number;
  real_income_cents: number;
}>;

export type OwnerDashboardData = Readonly<{
  business_date: string;
  generated_at: string;
  overdue_min_age_days: number;
  today: OwnerDashboardToday;
  trend: readonly OwnerDashboardTrendRow[];
}>;

export type OwnerDashboardLoadResult =
  Readonly<{ ok: true; data: OwnerDashboardData }> | Readonly<{ ok: false; error: string }>;

const DAY_MS = 86_400_000;
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ROOT_KEYS = Object.freeze([
  "business_date",
  "generated_at",
  "overdue_min_age_days",
  "today",
  "trend",
] as const);
const TODAY_KEYS = Object.freeze([
  "performance_income_cents",
  "real_income_cents",
  "picked_up_garment_count",
  "new_receivable_cents",
  "new_receivable_order_count",
  "overdue_garment_count",
  "overdue_order_count",
] as const);
const TREND_KEYS = Object.freeze([
  "business_date",
  "performance_income_cents",
  "real_income_cents",
] as const);
const EMPTY_INPUT: Readonly<Record<string, never>> = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function businessDayNumber(value: unknown): number | null {
  if (typeof value !== "string" || !BUSINESS_DATE.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    return null;
  }
  return Math.floor(timestamp / DAY_MS);
}

function exactUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !EXACT_UTC_TIMESTAMP.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : null;
}

function parseToday(value: unknown): OwnerDashboardToday | null {
  if (!isRecord(value) || !hasExactKeys(value, TODAY_KEYS)) return null;
  const performance = safeInteger(value.performance_income_cents);
  const real = safeInteger(value.real_income_cents);
  const picked = nonNegativeSafeInteger(value.picked_up_garment_count);
  const receivable = nonNegativeSafeInteger(value.new_receivable_cents);
  const receivableOrders = nonNegativeSafeInteger(value.new_receivable_order_count);
  const overdue = nonNegativeSafeInteger(value.overdue_garment_count);
  const overdueOrders = nonNegativeSafeInteger(value.overdue_order_count);
  if (
    performance === null ||
    real === null ||
    picked === null ||
    receivable === null ||
    receivableOrders === null ||
    overdue === null ||
    overdueOrders === null
  ) {
    return null;
  }
  return Object.freeze({
    performance_income_cents: performance,
    real_income_cents: real,
    picked_up_garment_count: picked,
    new_receivable_cents: receivable,
    new_receivable_order_count: receivableOrders,
    overdue_garment_count: overdue,
    overdue_order_count: overdueOrders,
  });
}

function parseTrendRow(value: unknown): OwnerDashboardTrendRow | null {
  if (!isRecord(value) || !hasExactKeys(value, TREND_KEYS)) return null;
  if (businessDayNumber(value.business_date) === null) return null;
  const performance = safeInteger(value.performance_income_cents);
  const real = safeInteger(value.real_income_cents);
  if (performance === null || real === null) return null;
  return Object.freeze({
    business_date: value.business_date as string,
    performance_income_cents: performance,
    real_income_cents: real,
  });
}

function parseTrend(value: unknown, endDay: number): readonly OwnerDashboardTrendRow[] | null {
  if (!Array.isArray(value) || value.length !== 30) return null;
  const rows: OwnerDashboardTrendRow[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = parseTrendRow(value[index]);
    if (row === null) return null;
    const day = businessDayNumber(row.business_date);
    if (day !== endDay - (29 - index)) return null;
    rows.push(row);
  }
  return Object.freeze(rows);
}

/** Strict browser boundary parser for the ADR-26 owner-dashboard result. */
export function parseOwnerDashboard(value: unknown): OwnerDashboardData | null {
  if (!isRecord(value) || !hasExactKeys(value, ROOT_KEYS)) return null;
  const day = businessDayNumber(value.business_date);
  const generatedAt = exactUtcTimestamp(value.generated_at);
  const overdueDays = nonNegativeSafeInteger(value.overdue_min_age_days);
  const today = parseToday(value.today);
  if (day === null || generatedAt === null || overdueDays !== 30 || today === null) return null;
  const trend = parseTrend(value.trend, day);
  if (trend === null) return null;
  const current = trend.at(-1);
  if (
    current === undefined ||
    current.performance_income_cents !== today.performance_income_cents ||
    current.real_income_cents !== today.real_income_cents
  ) {
    return null;
  }
  return Object.freeze({
    business_date: value.business_date as string,
    generated_at: generatedAt,
    overdue_min_age_days: overdueDays,
    today,
    trend,
  });
}

const INVALID_QUERY_ENVELOPE = Symbol("invalid-owner-query-envelope");

function unwrapQueryResult(value: unknown): unknown | typeof INVALID_QUERY_ENVELOPE {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["execution", "result"]) ||
    value.execution !== "executed"
  ) {
    return INVALID_QUERY_ENVELOPE;
  }
  return value.result;
}

/** Execute the one fixed query with no browser-owned tenant, date, or range fields. */
export async function loadOwnerDashboard(
  queryClient: QueryPort,
): Promise<OwnerDashboardLoadResult> {
  let response: Awaited<ReturnType<QueryPort["execute"]>>;
  try {
    response = await queryClient.execute<unknown>(OWNER_DASHBOARD_QUERY_NAME, EMPTY_INPUT);
  } catch {
    return Object.freeze({ ok: false as const, error: "本地服务暂时不可用" });
  }
  if (!response.ok) {
    return Object.freeze({
      ok: false as const,
      error: response.error.message ?? response.error.code,
    });
  }
  const unwrapped = unwrapQueryResult(response.data);
  const parsed = unwrapped === INVALID_QUERY_ENVELOPE ? null : parseOwnerDashboard(unwrapped);
  if (parsed === null) {
    return Object.freeze({ ok: false as const, error: "经营看板数据格式无效" });
  }
  return Object.freeze({ ok: true as const, data: parsed });
}

/** 7/30 is display-only; both modes slice the same authoritative 30-day snapshot. */
export function selectOwnerTrend(
  dashboard: OwnerDashboardData,
  days: OwnerTrendDays,
): readonly OwnerDashboardTrendRow[] {
  return Object.freeze(dashboard.trend.slice(-days));
}
