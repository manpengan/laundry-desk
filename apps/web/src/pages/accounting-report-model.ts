export const ACCOUNTING_METHODS = Object.freeze([
  "cash",
  "wechat",
  "alipay",
  "other",
  "balance",
] as const);

export type AccountingMethod = (typeof ACCOUNTING_METHODS)[number];
export type AccountingGroupBy = "day" | "staff";

export type AccountingBasisView = Readonly<{
  real_income_cents: number;
  performance_income_cents: number;
  order_cashflow_cents: number;
  stored_value_cashflow_cents: number;
  stored_value_consumption_cents: number;
  ledger_row_count: number;
}>;

export type AccountingReportView = Readonly<{
  date_from: string;
  date_to: string;
  group_by: AccountingGroupBy;
  staff_id: string | null;
  generated_at: string;
  totals: AccountingBasisView;
  channels: readonly Readonly<{
    method: AccountingMethod;
    order_income_cents: number;
    stored_value_cashflow_cents: number;
    real_income_cents: number;
    performance_income_cents: number;
    ledger_row_count: number;
  }>[];
  rows: readonly Readonly<
    AccountingBasisView & {
      key: string;
      label: string;
    }
  >[];
}>;

export type AccountingExportView = Readonly<{
  filename: string;
  content_sha256: string;
  csv: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isBusinessDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

const BASIS_KEYS = Object.freeze([
  "real_income_cents",
  "performance_income_cents",
  "order_cashflow_cents",
  "stored_value_cashflow_cents",
  "stored_value_consumption_cents",
  "ledger_row_count",
] as const);

function parseBasis(value: unknown): AccountingBasisView | null {
  if (!isRecord(value) || !hasExactKeys(value, BASIS_KEYS)) return null;
  if (
    !isSafeInteger(value.real_income_cents) ||
    !isSafeInteger(value.performance_income_cents) ||
    !isSafeInteger(value.order_cashflow_cents) ||
    !isSafeInteger(value.stored_value_cashflow_cents) ||
    !isSafeInteger(value.stored_value_consumption_cents) ||
    !isNonNegativeInteger(value.ledger_row_count)
  ) {
    return null;
  }
  return Object.freeze({
    real_income_cents: value.real_income_cents,
    performance_income_cents: value.performance_income_cents,
    order_cashflow_cents: value.order_cashflow_cents,
    stored_value_cashflow_cents: value.stored_value_cashflow_cents,
    stored_value_consumption_cents: value.stored_value_consumption_cents,
    ledger_row_count: value.ledger_row_count,
  });
}

function parseChannel(value: unknown): AccountingReportView["channels"][number] | null {
  const keys = [
    "method",
    "order_income_cents",
    "stored_value_cashflow_cents",
    "real_income_cents",
    "performance_income_cents",
    "ledger_row_count",
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    typeof value.method !== "string" ||
    !ACCOUNTING_METHODS.includes(value.method as AccountingMethod) ||
    !isSafeInteger(value.order_income_cents) ||
    !isSafeInteger(value.stored_value_cashflow_cents) ||
    !isSafeInteger(value.real_income_cents) ||
    !isSafeInteger(value.performance_income_cents) ||
    !isNonNegativeInteger(value.ledger_row_count)
  ) {
    return null;
  }
  return Object.freeze({
    method: value.method as AccountingMethod,
    order_income_cents: value.order_income_cents,
    stored_value_cashflow_cents: value.stored_value_cashflow_cents,
    real_income_cents: value.real_income_cents,
    performance_income_cents: value.performance_income_cents,
    ledger_row_count: value.ledger_row_count,
  });
}

function parseRow(value: unknown): AccountingReportView["rows"][number] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["key", "label", ...BASIS_KEYS])) return null;
  const { key, label, ...basisInput } = value;
  const basis = parseBasis(basisInput);
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 64 ||
    typeof label !== "string" ||
    label.length === 0 ||
    label.length > 128 ||
    basis === null
  ) {
    return null;
  }
  return Object.freeze({ key, label, ...basis });
}

export function parseAccountingReport(value: unknown): AccountingReportView | null {
  const keys = [
    "date_from",
    "date_to",
    "group_by",
    "staff_id",
    "generated_at",
    "totals",
    "channels",
    "rows",
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    !isBusinessDate(value.date_from) ||
    !isBusinessDate(value.date_to) ||
    (value.group_by !== "day" && value.group_by !== "staff") ||
    (value.staff_id !== null && !isUuid(value.staff_id)) ||
    !isTimestamp(value.generated_at) ||
    !Array.isArray(value.channels) ||
    value.channels.length !== ACCOUNTING_METHODS.length ||
    !Array.isArray(value.rows) ||
    value.rows.length > 366 ||
    value.date_from > value.date_to ||
    Math.floor(
      (Date.parse(`${value.date_to}T00:00:00.000Z`) -
        Date.parse(`${value.date_from}T00:00:00.000Z`)) /
        86_400_000,
    ) +
      1 >
      366
  ) {
    return null;
  }
  const totals = parseBasis(value.totals);
  const channels = value.channels.map(parseChannel);
  const rows = value.rows.map(parseRow);
  if (
    totals === null ||
    channels.some((row) => row === null) ||
    rows.some((row) => row === null) ||
    new Set(channels.map((row) => row?.method)).size !== channels.length ||
    new Set(rows.map((row) => row?.key)).size !== rows.length
  ) {
    return null;
  }
  return Object.freeze({
    date_from: value.date_from,
    date_to: value.date_to,
    group_by: value.group_by,
    staff_id: value.staff_id,
    generated_at: value.generated_at,
    totals,
    channels: Object.freeze(channels as AccountingReportView["channels"]),
    rows: Object.freeze(rows as AccountingReportView["rows"]),
  });
}

export function parseAccountingExport(value: unknown): AccountingExportView | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["filename", "content_sha256", "csv"]) ||
    typeof value.filename !== "string" ||
    !/^accounting-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-(?:day|staff)\.csv$/u.test(value.filename) ||
    typeof value.content_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.content_sha256) ||
    typeof value.csv !== "string" ||
    value.csv.length === 0 ||
    new TextEncoder().encode(value.csv).byteLength > 1_048_576
  ) {
    return null;
  }
  return Object.freeze({
    filename: value.filename,
    content_sha256: value.content_sha256,
    csv: value.csv,
  });
}

export function accountingRangeError(dateFrom: string, dateTo: string): string | null {
  if (!isBusinessDate(dateFrom) || !isBusinessDate(dateTo)) {
    return "请选择完整日期范围";
  }
  const startedAt = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const endedAt = Date.parse(`${dateTo}T00:00:00.000Z`);
  if (dateFrom > dateTo) return "开始日期不能晚于结束日期";
  if (Math.floor((endedAt - startedAt) / 86_400_000) + 1 > 366) return "日期范围不能超过 366 天";
  return null;
}

export function monthRange(month: string): Readonly<{ dateFrom: string; dateTo: string }> | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(month);
  if (match === null) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Object.freeze({
    dateFrom: `${match[1]}-${match[2]}-01`,
    dateTo: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`,
  });
}
