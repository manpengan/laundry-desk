export const PAYMENT_METHODS = Object.freeze(["cash", "wechat", "alipay", "other"] as const);
export const PAYMENT_KINDS = Object.freeze([
  "pay",
  "repay",
  "refund",
  "storage_fee",
  "reversal",
] as const);
export const PRINT_STATUSES = Object.freeze(["queued", "printing", "done", "failed"] as const);
export const REPLAY_DECISIONS = Object.freeze([
  "applied",
  "duplicate",
  "arbitration",
  "collision",
  "rejected",
] as const);

type PaymentMethod = (typeof PAYMENT_METHODS)[number];
type PaymentKind = (typeof PAYMENT_KINDS)[number];
type PrintStatus = (typeof PRINT_STATUSES)[number];
type ReplayDecision = (typeof REPLAY_DECISIONS)[number];

export type ReconciliationView = Readonly<{
  business_date: string;
  generated_at: string;
  orders: Readonly<{
    count: number;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
  }>;
  ledger: Readonly<{
    row_count: number;
    gross_cents: number;
    refund_cents: number;
    net_cents: number;
    difference_from_orders_cents: number;
    buckets: readonly Readonly<{
      method: PaymentMethod;
      kind: PaymentKind;
      row_count: number;
      amount_cents: number;
      net_cents: number;
    }>[];
  }>;
  shift: Readonly<{
    closed_at: string;
    order_count: number;
    payable_cents: number;
    paid_cents: number;
    payment_cents: number;
    counted_cash_cents: number;
    retained_float_cents: number;
    expected_cash_cents: number;
    cash_difference_cents: number;
  }> | null;
  print: Readonly<{
    total: number;
    statuses: readonly Readonly<{ status: PrintStatus; count: number }>[];
  }>;
  edge_replay: Readonly<{
    total: number;
    conflict_count: number;
    decisions: readonly Readonly<{ decision: ReplayDecision; count: number }>[];
  }>;
}>;

export type ReconciliationExportView = Readonly<{
  filename: string;
  content_sha256: string;
  csv: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return isSafeInt(value) && value >= 0;
}

function isEnumValue<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function parseOrders(value: unknown): ReconciliationView["orders"] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["count", "payable_cents", "paid_cents", "balance_cents"]) ||
    !isNonNegativeInt(value.count) ||
    !isNonNegativeInt(value.payable_cents) ||
    !isNonNegativeInt(value.paid_cents) ||
    !isNonNegativeInt(value.balance_cents)
  ) {
    return null;
  }
  return Object.freeze({
    count: value.count,
    payable_cents: value.payable_cents,
    paid_cents: value.paid_cents,
    balance_cents: value.balance_cents,
  });
}

function parseLedger(value: unknown): ReconciliationView["ledger"] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "row_count",
      "gross_cents",
      "refund_cents",
      "net_cents",
      "difference_from_orders_cents",
      "buckets",
    ]) ||
    !isNonNegativeInt(value.row_count) ||
    !isNonNegativeInt(value.gross_cents) ||
    !isNonNegativeInt(value.refund_cents) ||
    !isSafeInt(value.net_cents) ||
    !isSafeInt(value.difference_from_orders_cents) ||
    !Array.isArray(value.buckets) ||
    value.buckets.length > 20
  ) {
    return null;
  }
  const buckets: ReconciliationView["ledger"]["buckets"][number][] = [];
  const identities = new Set<string>();
  for (const bucket of value.buckets) {
    if (
      !isRecord(bucket) ||
      !hasExactKeys(bucket, ["method", "kind", "row_count", "amount_cents", "net_cents"]) ||
      !isEnumValue(PAYMENT_METHODS, bucket.method) ||
      !isEnumValue(PAYMENT_KINDS, bucket.kind) ||
      !isNonNegativeInt(bucket.row_count) ||
      !isNonNegativeInt(bucket.amount_cents) ||
      !isSafeInt(bucket.net_cents)
    ) {
      return null;
    }
    const identity = `${bucket.method}:${bucket.kind}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    buckets.push(
      Object.freeze({
        method: bucket.method,
        kind: bucket.kind,
        row_count: bucket.row_count,
        amount_cents: bucket.amount_cents,
        net_cents: bucket.net_cents,
      }),
    );
  }
  return Object.freeze({
    row_count: value.row_count,
    gross_cents: value.gross_cents,
    refund_cents: value.refund_cents,
    net_cents: value.net_cents,
    difference_from_orders_cents: value.difference_from_orders_cents,
    buckets: Object.freeze(buckets),
  });
}

function parseShift(value: unknown): ReconciliationView["shift"] | null | undefined {
  if (value === null) return null;
  const keys = [
    "closed_at",
    "order_count",
    "payable_cents",
    "paid_cents",
    "payment_cents",
    "counted_cash_cents",
    "retained_float_cents",
    "expected_cash_cents",
    "cash_difference_cents",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys) || !isUtcTimestamp(value.closed_at)) {
    return undefined;
  }
  const orderCount = value.order_count;
  const payableCents = value.payable_cents;
  const paidCents = value.paid_cents;
  const paymentCents = value.payment_cents;
  const countedCashCents = value.counted_cash_cents;
  const retainedFloatCents = value.retained_float_cents;
  const expectedCashCents = value.expected_cash_cents;
  const cashDifferenceCents = value.cash_difference_cents;
  if (
    !isNonNegativeInt(orderCount) ||
    !isNonNegativeInt(payableCents) ||
    !isNonNegativeInt(paidCents) ||
    !isNonNegativeInt(paymentCents) ||
    !isNonNegativeInt(countedCashCents) ||
    !isNonNegativeInt(retainedFloatCents) ||
    !isNonNegativeInt(expectedCashCents) ||
    !isSafeInt(cashDifferenceCents)
  ) {
    return undefined;
  }
  return Object.freeze({
    closed_at: value.closed_at,
    order_count: orderCount,
    payable_cents: payableCents,
    paid_cents: paidCents,
    payment_cents: paymentCents,
    counted_cash_cents: countedCashCents,
    retained_float_cents: retainedFloatCents,
    expected_cash_cents: expectedCashCents,
    cash_difference_cents: cashDifferenceCents,
  });
}

function parseCounts<const T extends readonly string[]>(
  value: unknown,
  values: T,
  key: "status" | "decision",
  maximum: number,
): readonly Readonly<Record<typeof key, T[number]> & { count: number }>[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const parsed: Readonly<Record<typeof key, T[number]> & { count: number }>[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (
      !isRecord(row) ||
      !hasExactKeys(row, [key, "count"]) ||
      !isEnumValue(values, row[key]) ||
      !isNonNegativeInt(row.count) ||
      seen.has(row[key])
    ) {
      return null;
    }
    seen.add(row[key]);
    parsed.push(
      Object.freeze({ [key]: row[key], count: row.count }) as Record<typeof key, T[number]> & {
        count: number;
      },
    );
  }
  return Object.freeze(parsed);
}

export function parseReconciliationView(value: unknown): ReconciliationView | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "business_date",
      "generated_at",
      "orders",
      "ledger",
      "shift",
      "print",
      "edge_replay",
    ]) ||
    !isBusinessDate(value.business_date) ||
    !isUtcTimestamp(value.generated_at)
  ) {
    return null;
  }
  const orders = parseOrders(value.orders);
  const ledger = parseLedger(value.ledger);
  const shift = parseShift(value.shift);
  if (
    orders === null ||
    ledger === null ||
    shift === undefined ||
    !isRecord(value.print) ||
    !hasExactKeys(value.print, ["total", "statuses"]) ||
    !isNonNegativeInt(value.print.total) ||
    !isRecord(value.edge_replay) ||
    !hasExactKeys(value.edge_replay, ["total", "conflict_count", "decisions"]) ||
    !isNonNegativeInt(value.edge_replay.total) ||
    !isNonNegativeInt(value.edge_replay.conflict_count)
  ) {
    return null;
  }
  const statuses = parseCounts(value.print.statuses, PRINT_STATUSES, "status", 4);
  const decisions = parseCounts(value.edge_replay.decisions, REPLAY_DECISIONS, "decision", 5);
  if (statuses === null || decisions === null) return null;
  return Object.freeze({
    business_date: value.business_date,
    generated_at: value.generated_at,
    orders,
    ledger,
    shift,
    print: Object.freeze({ total: value.print.total, statuses }),
    edge_replay: Object.freeze({
      total: value.edge_replay.total,
      conflict_count: value.edge_replay.conflict_count,
      decisions,
    }),
  });
}

export function parseReconciliationExport(value: unknown): ReconciliationExportView | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["filename", "content_sha256", "csv"]) ||
    typeof value.filename !== "string" ||
    !/^reconciliation-\d{4}-\d{2}-\d{2}\.csv$/u.test(value.filename) ||
    typeof value.content_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.content_sha256) ||
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
