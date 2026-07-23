import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import {
  parseShiftClosing,
  ShiftClosePanel,
  unwrapShiftResult,
  type ShiftClosingView,
} from "./ShiftClosePanel.js";

const SAMPLE: ShiftClosingView = Object.freeze({
  shift_id: "s1111111-1111-4111-8111-111111111111",
  business_date: "2026-07-22",
  closed_at: 1_721_606_400,
  order_count: 3,
  payable_cents: 12000,
  paid_cents: 4000,
  payment_cents: 2000,
  signature_name: "店员甲",
  note: "晚班",
});

test("parseShiftClosing accepts documented result shape", () => {
  assert.deepEqual(parseShiftClosing(SAMPLE), SAMPLE);
  assert.equal(parseShiftClosing(null), null);
  assert.equal(parseShiftClosing({ business_date: "x" }), null);
});

test("unwrapShiftResult peels bus envelope", () => {
  assert.deepEqual(unwrapShiftResult({ execution: "executed", result: SAMPLE }), SAMPLE);
  assert.deepEqual(unwrapShiftResult(SAMPLE), SAMPLE);
  assert.equal(unwrapShiftResult({ execution: "executed", result: null }), null);
});

test("ShiftClosePanel SSR shows signature form when not closed", () => {
  const queryClient = createMockQueryClient();
  const commandClient = createMockCommandClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(ShiftClosePanel, {
        queryClient,
        commandClient,
        businessDate: "2026-07-22",
        autoLoad: false,
      }),
    ),
  );

  assert.match(html, /交班 \/ 日结签字/);
  assert.match(html, /签字人/);
  assert.match(html, /交班确认/);
  assert.match(html, /data-testid="shift-close-panel"/);
  assert.match(html, /data-testid="shift-signature-input"/);
  assert.match(html, /data-testid="shift-close-btn"/);
  assert.doesNotMatch(html, /data-testid="shift-closed-status"/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});
