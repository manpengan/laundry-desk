import type {
  OwnerDrilldownData,
  OwnerPickupDrilldown,
  OwnerPortfolioData,
  OwnerPortfolioMetrics,
  OwnerPortfolioStore,
  OwnerReceivableDrilldown,
  OwnerStagnantDrilldown,
} from "./owner-operations-model.js";

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const METRIC_KEYS = Object.freeze([
  "performance_income_cents",
  "real_income_cents",
  "picked_up_garment_count",
  "new_receivable_cents",
  "new_receivable_order_count",
  "overdue_garment_count",
  "overdue_order_count",
] as const);

type DrilldownCommon = Readonly<{
  business_date: string;
  generated_at: string;
  total_row_count: number;
  truncated: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function integer(value: unknown, allowNegative = false): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && (allowNegative || value >= 0)
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function businessDate(value: unknown): string | null {
  if (typeof value !== "string" || !BUSINESS_DATE.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function ticket(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 ? value : null;
}

function parseCommon(value: Record<string, unknown>): DrilldownCommon | null {
  const date = businessDate(value.business_date);
  const generatedAt = timestamp(value.generated_at);
  const total = integer(value.total_row_count);
  if (
    date === null ||
    generatedAt === null ||
    total === null ||
    typeof value.truncated !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    business_date: date,
    generated_at: generatedAt,
    total_row_count: total,
    truncated: value.truncated,
  });
}

function parseRows<TRow>(
  value: unknown,
  parse: (row: Record<string, unknown>) => TRow | null,
): readonly TRow[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const rows: TRow[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const row = parse(candidate);
    if (row === null) return null;
    rows.push(row);
  }
  return Object.freeze(rows);
}

function validBound(common: DrilldownCommon, rows: readonly unknown[]): boolean {
  return (
    common.total_row_count >= rows.length &&
    common.truncated === common.total_row_count > rows.length &&
    (!common.truncated || rows.length === 50)
  );
}

function uniqueTickets(rows: readonly Readonly<{ ticket_no: string }>[]): boolean {
  return new Set(rows.map((row) => row.ticket_no)).size === rows.length;
}

function parsePickup(value: Record<string, unknown>): OwnerPickupDrilldown | null {
  if (
    !exactKeys(value, [
      "business_date",
      "generated_at",
      "kind",
      "rows",
      "total_row_count",
      "totals",
      "truncated",
    ])
  )
    return null;
  const common = parseCommon(value);
  if (common === null || value.kind !== "today_pickups" || !isRecord(value.totals)) return null;
  const total = integer(value.totals.picked_up_garment_count);
  const orders = integer(value.totals.picked_up_order_count);
  if (
    !exactKeys(value.totals, ["picked_up_garment_count", "picked_up_order_count"]) ||
    total === null ||
    orders === null ||
    orders !== common.total_row_count
  )
    return null;
  const rows = parseRows(value.rows, (row) => {
    if (!exactKeys(row, ["garment_count", "picked_at", "ticket_no"])) return null;
    const ticketNo = ticket(row.ticket_no);
    const pickedAt = timestamp(row.picked_at);
    const count = integer(row.garment_count);
    return ticketNo === null || pickedAt === null || count === null || count === 0
      ? null
      : Object.freeze({ ticket_no: ticketNo, picked_at: pickedAt, garment_count: count });
  });
  if (rows === null || !validBound(common, rows) || !uniqueTickets(rows)) return null;
  const returned = rows.reduce((sum, row) => sum + row.garment_count, 0);
  if (returned > total || (!common.truncated && returned !== total)) return null;
  return Object.freeze({
    ...common,
    kind: value.kind,
    totals: Object.freeze({ picked_up_garment_count: total, picked_up_order_count: orders }),
    rows,
  });
}

function parseReceivables(value: Record<string, unknown>): OwnerReceivableDrilldown | null {
  if (
    !exactKeys(value, [
      "business_date",
      "generated_at",
      "kind",
      "rows",
      "total_row_count",
      "totals",
      "truncated",
    ])
  )
    return null;
  const common = parseCommon(value);
  if (common === null || value.kind !== "new_receivables" || !isRecord(value.totals)) return null;
  const cents = integer(value.totals.new_receivable_cents);
  const orders = integer(value.totals.new_receivable_order_count);
  if (
    !exactKeys(value.totals, ["new_receivable_cents", "new_receivable_order_count"]) ||
    cents === null ||
    orders === null ||
    orders !== common.total_row_count
  )
    return null;
  const rows = parseRows(value.rows, (row) => {
    if (!exactKeys(row, ["balance_cents", "received_at", "ticket_no"])) return null;
    const ticketNo = ticket(row.ticket_no);
    const receivedAt = timestamp(row.received_at);
    const balance = integer(row.balance_cents);
    return ticketNo === null || receivedAt === null || balance === null || balance === 0
      ? null
      : Object.freeze({ ticket_no: ticketNo, received_at: receivedAt, balance_cents: balance });
  });
  if (rows === null || !validBound(common, rows) || !uniqueTickets(rows)) return null;
  const returned = rows.reduce((sum, row) => sum + row.balance_cents, 0);
  if (returned > cents || (!common.truncated && returned !== cents)) return null;
  return Object.freeze({
    ...common,
    kind: value.kind,
    totals: Object.freeze({ new_receivable_cents: cents, new_receivable_order_count: orders }),
    rows,
  });
}

function parseStagnant(value: Record<string, unknown>): OwnerStagnantDrilldown | null {
  if (
    !exactKeys(value, [
      "business_date",
      "generated_at",
      "kind",
      "overdue_min_age_days",
      "rows",
      "total_row_count",
      "totals",
      "truncated",
    ])
  )
    return null;
  const common = parseCommon(value);
  if (
    common === null ||
    value.kind !== "stagnant_garments" ||
    value.overdue_min_age_days !== 30 ||
    !isRecord(value.totals)
  )
    return null;
  const garments = integer(value.totals.overdue_garment_count);
  const orders = integer(value.totals.overdue_order_count);
  if (
    !exactKeys(value.totals, ["overdue_garment_count", "overdue_order_count"]) ||
    garments === null ||
    orders === null ||
    orders !== common.total_row_count
  )
    return null;
  const rows = parseRows(value.rows, (row) => {
    if (!exactKeys(row, ["age_days", "balance_cents", "garment_count", "received_at", "ticket_no"]))
      return null;
    const ticketNo = ticket(row.ticket_no);
    const receivedAt = timestamp(row.received_at);
    const age = integer(row.age_days);
    const count = integer(row.garment_count);
    const balance = integer(row.balance_cents);
    return ticketNo === null ||
      receivedAt === null ||
      age === null ||
      age < 30 ||
      count === null ||
      count === 0 ||
      balance === null
      ? null
      : Object.freeze({
          ticket_no: ticketNo,
          received_at: receivedAt,
          age_days: age,
          garment_count: count,
          balance_cents: balance,
        });
  });
  if (rows === null || !validBound(common, rows) || !uniqueTickets(rows)) return null;
  const returned = rows.reduce((sum, row) => sum + row.garment_count, 0);
  if (returned > garments || (!common.truncated && returned !== garments)) return null;
  return Object.freeze({
    ...common,
    kind: value.kind,
    overdue_min_age_days: 30,
    totals: Object.freeze({ overdue_garment_count: garments, overdue_order_count: orders }),
    rows,
  });
}

export function parseOwnerDrilldown(value: unknown): OwnerDrilldownData | null {
  if (!isRecord(value)) return null;
  if (value.kind === "today_pickups") return parsePickup(value);
  if (value.kind === "new_receivables") return parseReceivables(value);
  if (value.kind === "stagnant_garments") return parseStagnant(value);
  return null;
}

function parseMetrics(value: unknown): OwnerPortfolioMetrics | null {
  if (!isRecord(value) || !exactKeys(value, METRIC_KEYS)) return null;
  const parsed = METRIC_KEYS.map((key) => integer(value[key], key.endsWith("income_cents")));
  if (parsed.some((item) => item === null)) return null;
  return Object.freeze(
    Object.fromEntries(METRIC_KEYS.map((key, index) => [key, parsed[index]])),
  ) as OwnerPortfolioMetrics;
}

function sumMetrics(rows: readonly OwnerPortfolioMetrics[]): OwnerPortfolioMetrics | null {
  const total = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])) as Record<
    keyof OwnerPortfolioMetrics,
    number
  >;
  for (const row of rows) {
    for (const key of METRIC_KEYS) {
      const next = total[key] + row[key];
      if (!Number.isSafeInteger(next)) return null;
      total[key] = next;
    }
  }
  return Object.freeze(total);
}

function parseStore(value: unknown): OwnerPortfolioStore | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["business_date", ...METRIC_KEYS, "store_code", "store_name", "timezone"])
  )
    return null;
  const metrics = parseMetrics(Object.fromEntries(METRIC_KEYS.map((key) => [key, value[key]])));
  const date = businessDate(value.business_date);
  if (
    metrics === null ||
    date === null ||
    typeof value.store_code !== "string" ||
    value.store_code.length < 1 ||
    value.store_code.length > 64 ||
    typeof value.store_name !== "string" ||
    value.store_name.length < 1 ||
    value.store_name.length > 128 ||
    typeof value.timezone !== "string" ||
    value.timezone.length < 1 ||
    value.timezone.length > 64
  )
    return null;
  return Object.freeze({
    ...metrics,
    store_code: value.store_code,
    store_name: value.store_name,
    timezone: value.timezone,
    business_date: date,
  });
}

export function parseOwnerPortfolio(value: unknown): OwnerPortfolioData | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["generated_at", "returned_store_count", "stores", "totals", "truncated"])
  )
    return null;
  const generatedAt = timestamp(value.generated_at);
  const count = integer(value.returned_store_count);
  const totals = parseMetrics(value.totals);
  if (
    generatedAt === null ||
    count === null ||
    typeof value.truncated !== "boolean" ||
    totals === null ||
    !Array.isArray(value.stores) ||
    value.stores.length > 50 ||
    count !== value.stores.length ||
    (value.truncated && value.stores.length !== 50)
  )
    return null;
  const stores: OwnerPortfolioStore[] = [];
  for (const candidate of value.stores) {
    const parsed = parseStore(candidate);
    if (parsed === null) return null;
    stores.push(parsed);
  }
  const codes = stores.map((store) => store.store_code);
  const calculated = sumMetrics(stores);
  if (
    new Set(codes).size !== codes.length ||
    codes.some((code, index) => index > 0 && code < codes[index - 1]!) ||
    calculated === null ||
    METRIC_KEYS.some((key) => calculated[key] !== totals[key])
  )
    return null;
  return Object.freeze({
    generated_at: generatedAt,
    returned_store_count: count,
    truncated: value.truncated,
    totals,
    stores: Object.freeze(stores),
  });
}
