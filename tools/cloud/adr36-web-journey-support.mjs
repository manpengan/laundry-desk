import { asRecord, requireInteger, requireThat } from "./adr36-web-core.mjs";

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const BASIS_FIELDS = Object.freeze([
  "real_income_cents",
  "performance_income_cents",
  "order_cashflow_cents",
  "stored_value_cashflow_cents",
  "stored_value_consumption_cents",
  "ledger_row_count",
]);
const ZERO_BASIS = Object.freeze(Object.fromEntries(BASIS_FIELDS.map((field) => [field, 0])));
export const EXPECTED_DELTA = Object.freeze({
  real_income_cents: 4_200,
  performance_income_cents: 5_200,
  order_cashflow_cents: 2_600,
  stored_value_cashflow_cents: 1_600,
  stored_value_consumption_cents: 2_600,
  ledger_row_count: 6,
});

function basis(value) {
  const record = asRecord(value, "ACCOUNTING_RESULT_INVALID");
  return Object.freeze(
    Object.fromEntries(
      BASIS_FIELDS.map((field) => [
        field,
        requireInteger(record[field], "ACCOUNTING_RESULT_INVALID"),
      ]),
    ),
  );
}

export function subtractBasis(after, before) {
  return Object.freeze(
    Object.fromEntries(BASIS_FIELDS.map((field) => [field, after[field] - before[field]])),
  );
}

export function assertBasis(actual, expected, code = "ACCOUNTING_DELTA_INVALID") {
  for (const field of BASIS_FIELDS) requireThat(actual[field] === expected[field], code);
}

export async function accountingReport(api, session, input) {
  const result = asRecord(
    await api.query(session, "accounting.report.get", input),
    "ACCOUNTING_RESULT_INVALID",
  );
  requireThat(
    BUSINESS_DATE.test(result.date_from) && result.date_from === result.date_to,
    "ACCOUNTING_DATE_INVALID",
  );
  requireThat(Array.isArray(result.rows), "ACCOUNTING_RESULT_INVALID");
  return Object.freeze({ date: result.date_from, totals: basis(result.totals), rows: result.rows });
}

export function staffBasis(report, staffId) {
  const matches = report.rows.filter(
    (row) => asRecord(row, "ACCOUNTING_RESULT_INVALID").key === staffId,
  );
  requireThat(matches.length <= 1, "ACCOUNTING_RESULT_INVALID");
  return matches.length === 0 ? ZERO_BASIS : basis(matches[0]);
}

export async function writeMutation(update, locator, operation, register = (value) => value) {
  update({ ...locator, cleanupUncertain: true });
  const value = await operation();
  const registered = register(value);
  update({ cleanupUncertain: false });
  return registered;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function orderArgs(artifacts, run, initialPayment) {
  return Object.freeze({
    customer_phone: artifacts.customerPhone,
    customer_name: run.label,
    lines: [
      Object.freeze({
        service_code: run.serviceCode,
        category_code: run.categoryCode,
        qty: 1,
        color: "UAT",
      }),
    ],
    ...(initialPayment === undefined ? {} : { initial_payment: initialPayment }),
    note: run.note,
  });
}
