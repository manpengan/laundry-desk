import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";

export const PRICE_INCREMENT_CENTS = 700;
export const REFUND_CENTS = 400;

const STATS_FIELDS = Object.freeze([
  "order_count",
  "garment_count",
  "payable_cents",
  "paid_cents",
  "balance_cents",
  "payment_cents",
  "picked_garment_count",
]);
const BASIS_FIELDS = Object.freeze([
  "real_income_cents",
  "performance_income_cents",
  "order_cashflow_cents",
  "stored_value_cashflow_cents",
  "stored_value_consumption_cents",
  "ledger_row_count",
]);

export function requirePositiveInteger(value, code) {
  const parsed = requireInteger(value, code);
  requireThat(parsed > 0, code);
  return parsed;
}

export function requireArray(value, code) {
  requireThat(Array.isArray(value), code);
  return value;
}

function vector(value, fields, code) {
  const record = asRecord(value, code);
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, requireInteger(record[field], code)])),
  );
}

function subtract(after, before, fields) {
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, after[field] - before[field]])),
  );
}

function assertVector(actual, expected, fields, code) {
  for (const field of fields) requireThat(actual[field] === expected[field], code);
}

export function zeroStats() {
  return Object.freeze(Object.fromEntries(STATS_FIELDS.map((field) => [field, 0])));
}

export function zeroBasis() {
  return Object.freeze(Object.fromEntries(BASIS_FIELDS.map((field) => [field, 0])));
}

export function paymentBasis(amountCents, ledgerRows = 1) {
  return Object.freeze({
    real_income_cents: amountCents,
    performance_income_cents: amountCents,
    order_cashflow_cents: amountCents,
    stored_value_cashflow_cents: 0,
    stored_value_consumption_cents: 0,
    ledger_row_count: ledgerRows,
  });
}

export function statsDelta(overrides = {}) {
  return Object.freeze({ ...zeroStats(), ...overrides });
}

function mapGarment(value) {
  const garment = asRecord(value, "ORDER_READBACK_INVALID");
  return Object.freeze({
    garment_id: requireUuid(garment.garment_id, "ORDER_READBACK_INVALID"),
    barcode: requireString(garment.barcode, "ORDER_READBACK_INVALID"),
    status: requireString(garment.status, "ORDER_READBACK_INVALID"),
    unit_price_cents: requireInteger(garment.unit_price_cents, "ORDER_READBACK_INVALID"),
    rack_zone: garment.rack_zone ?? null,
    rack_slot: garment.rack_slot ?? null,
  });
}

export function orderSnapshot(value) {
  const order = asRecord(value, "ORDER_READBACK_INVALID");
  const garments = requireArray(order.garments, "ORDER_READBACK_INVALID")
    .map(mapGarment)
    .sort((left, right) => left.garment_id.localeCompare(right.garment_id));
  return Object.freeze({
    order_id: requireUuid(order.order_id, "ORDER_READBACK_INVALID"),
    status: requireString(order.status, "ORDER_READBACK_INVALID"),
    payable_cents: requireInteger(order.payable_cents, "ORDER_READBACK_INVALID"),
    paid_cents: requireInteger(order.paid_cents, "ORDER_READBACK_INVALID"),
    balance_cents: requireInteger(order.balance_cents, "ORDER_READBACK_INVALID"),
    garments: Object.freeze(garments),
  });
}

export function assertOrderSnapshot(actual, expected, code) {
  for (const field of ["order_id", "status", "payable_cents", "paid_cents", "balance_cents"]) {
    requireThat(actual[field] === expected[field], code);
  }
  requireThat(actual.garments.length === expected.garments.length, code);
  for (const [index, garment] of actual.garments.entries()) {
    const expectedGarment = expected.garments[index];
    for (const field of [
      "garment_id",
      "barcode",
      "status",
      "unit_price_cents",
      "rack_zone",
      "rack_slot",
    ]) {
      requireThat(garment[field] === expectedGarment[field], code);
    }
  }
}

export async function readOrder(api, session, orderId) {
  return orderSnapshot(await api.query(session, "order.get", { order_id: orderId }));
}

export async function readEvidence(api, session, businessDate) {
  const rawStats = asRecord(
    await api.query(
      session,
      "stats.day.summary",
      businessDate === undefined ? {} : { business_date: businessDate },
    ),
    "STATS_RESULT_INVALID",
  );
  const date = requireString(rawStats.business_date, "STATS_RESULT_INVALID");
  requireThat(businessDate === undefined || date === businessDate, "BUSINESS_DAY_ROLLOVER");
  const report = asRecord(
    await api.query(session, "accounting.report.get", {
      date_from: date,
      date_to: date,
      group_by: "day",
    }),
    "ACCOUNTING_RESULT_INVALID",
  );
  requireThat(report.date_from === date && report.date_to === date, "BUSINESS_DAY_ROLLOVER");
  return Object.freeze({
    date,
    stats: vector(rawStats, STATS_FIELDS, "STATS_RESULT_INVALID"),
    accounting: vector(report.totals, BASIS_FIELDS, "ACCOUNTING_RESULT_INVALID"),
  });
}

export function assertOrderMoney(order, expected, code) {
  for (const field of ["status", "payable_cents", "paid_cents", "balance_cents"]) {
    requireThat(order[field] === expected[field], code);
  }
}

export function assertEvidenceDelta(before, after, expectedStats, expectedAccounting, code) {
  requireThat(before.date === after.date, "BUSINESS_DAY_ROLLOVER");
  assertVector(
    subtract(after.stats, before.stats, STATS_FIELDS),
    expectedStats,
    STATS_FIELDS,
    code,
  );
  assertVector(
    subtract(after.accounting, before.accounting, BASIS_FIELDS),
    expectedAccounting,
    BASIS_FIELDS,
    code,
  );
}
