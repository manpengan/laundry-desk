import assert from "node:assert/strict";
import test from "node:test";

import { formatShiftHistoryCsv } from "./shift-history-csv.js";
import type { ShiftClosingView } from "./shift-closing-view.js";

const ROW: ShiftClosingView = Object.freeze({
  shift_id: "11111111-1111-4111-8111-111111111111",
  business_date: "2026-07-30",
  closed_at: 1_722_297_600,
  order_count: 8,
  payable_cents: 12_000,
  paid_cents: 9_000,
  payment_cents: 9_000,
  opening_float_cents: 500,
  counted_cash_cents: 9_500,
  retained_float_cents: 500,
  expected_cash_cents: 9_500,
  cash_difference_cents: 0,
  signature_name: '=HYPERLINK("bad")',
  note: "+formula",
});

test("shift history CSV keeps integer fen and neutralizes spreadsheet formulas", () => {
  const csv = formatShiftHistoryCsv([ROW]);
  assert.match(csv, /business_date,signature_name,order_count/u);
  assert.match(csv, /"12000","9000"/u);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/u);
  assert.match(csv, /"'\+formula"/u);
  assert.doesNotMatch(csv, /95\.00/u);
});
