const DAY_MILLISECONDS = 86_400_000;

export type OwnerCardMetrics = Readonly<{
  performanceIncomeCents: number;
  realIncomeCents: number;
  pickedUpGarmentCount: number;
  newReceivableCents: number;
  newReceivableOrderCount: number;
  overdueGarmentCount: number;
  overdueOrderCount: number;
}>;

export type BoundedOwnerRows<TRow> = Readonly<{
  rows: readonly TRow[];
  totalRowCount: number;
  truncated: boolean;
}>;

export const EMPTY_OWNER_CARD_METRICS: OwnerCardMetrics = Object.freeze({
  performanceIncomeCents: 0,
  realIncomeCents: 0,
  pickedUpGarmentCount: 0,
  newReceivableCents: 0,
  newReceivableOrderCount: 0,
  overdueGarmentCount: 0,
  overdueOrderCount: 0,
});

function requireSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer`);
  return value;
}

function requireNonNegativeSafeInteger(value: number, field: string): number {
  const parsed = requireSafeInteger(value, field);
  if (parsed < 0) throw new RangeError(`${field} must be non-negative`);
  return parsed;
}

function safeAdd(left: number, right: number, field: string): number {
  return requireSafeInteger(left + right, field);
}

function addMetrics(left: OwnerCardMetrics, right: OwnerCardMetrics): OwnerCardMetrics {
  return Object.freeze({
    performanceIncomeCents: safeAdd(
      left.performanceIncomeCents,
      requireSafeInteger(right.performanceIncomeCents, "performanceIncomeCents"),
      "performanceIncomeCents",
    ),
    realIncomeCents: safeAdd(
      left.realIncomeCents,
      requireSafeInteger(right.realIncomeCents, "realIncomeCents"),
      "realIncomeCents",
    ),
    pickedUpGarmentCount: safeAdd(
      left.pickedUpGarmentCount,
      requireNonNegativeSafeInteger(right.pickedUpGarmentCount, "pickedUpGarmentCount"),
      "pickedUpGarmentCount",
    ),
    newReceivableCents: safeAdd(
      left.newReceivableCents,
      requireNonNegativeSafeInteger(right.newReceivableCents, "newReceivableCents"),
      "newReceivableCents",
    ),
    newReceivableOrderCount: safeAdd(
      left.newReceivableOrderCount,
      requireNonNegativeSafeInteger(right.newReceivableOrderCount, "newReceivableOrderCount"),
      "newReceivableOrderCount",
    ),
    overdueGarmentCount: safeAdd(
      left.overdueGarmentCount,
      requireNonNegativeSafeInteger(right.overdueGarmentCount, "overdueGarmentCount"),
      "overdueGarmentCount",
    ),
    overdueOrderCount: safeAdd(
      left.overdueOrderCount,
      requireNonNegativeSafeInteger(right.overdueOrderCount, "overdueOrderCount"),
      "overdueOrderCount",
    ),
  });
}

export function aggregateOwnerCardMetrics(rows: readonly OwnerCardMetrics[]): OwnerCardMetrics {
  return rows.reduce<OwnerCardMetrics>(addMetrics, EMPTY_OWNER_CARD_METRICS);
}

export function boundOwnerRows<TRow>(
  rows: readonly TRow[],
  limit: number,
  totalRowCount: number = rows.length,
): BoundedOwnerRows<TRow> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("owner row limit must be a positive safe integer");
  }
  const total = requireNonNegativeSafeInteger(totalRowCount, "totalRowCount");
  const bounded = Object.freeze(rows.slice(0, limit));
  if (total < bounded.length) throw new RangeError("totalRowCount cannot be smaller than rows");
  return Object.freeze({ rows: bounded, totalRowCount: total, truncated: total > bounded.length });
}

export function completedAgeDays(now: Date, occurredAt: Date): number {
  const nowTime = now.getTime();
  const occurredTime = occurredAt.getTime();
  if (!Number.isFinite(nowTime) || !Number.isFinite(occurredTime)) {
    throw new TypeError("owner reporting timestamps must be valid dates");
  }
  if (occurredTime > nowTime) throw new RangeError("owner reporting timestamp cannot be in future");
  return Math.floor((nowTime - occurredTime) / DAY_MILLISECONDS);
}
