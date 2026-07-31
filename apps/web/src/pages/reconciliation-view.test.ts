import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { verifyReconciliationExport } from "./reconciliation-export.js";
import {
  parseReconciliationExport,
  parseReconciliationView,
  type ReconciliationView,
} from "./reconciliation-view.js";
import { ReconciliationSnapshot } from "./ReconciliationSnapshot.js";

const SAMPLE: ReconciliationView = Object.freeze({
  business_date: "2026-07-30",
  generated_at: "2026-07-30T12:00:00.000Z",
  orders: Object.freeze({
    count: 4,
    payable_cents: 12_000,
    paid_cents: 10_000,
    balance_cents: 2_000,
  }),
  ledger: Object.freeze({
    row_count: 4,
    gross_cents: 11_000,
    refund_cents: 1_000,
    net_cents: 10_000,
    difference_from_orders_cents: 0,
    buckets: Object.freeze([
      Object.freeze({
        method: "cash",
        kind: "pay",
        row_count: 2,
        amount_cents: 7_000,
        net_cents: 7_000,
      }),
      Object.freeze({
        method: "wechat",
        kind: "refund",
        row_count: 1,
        amount_cents: 1_000,
        net_cents: -1_000,
      }),
    ]),
  }),
  shift: Object.freeze({
    closed_at: "2026-07-30T11:00:00.000Z",
    order_count: 4,
    payable_cents: 12_000,
    paid_cents: 10_000,
    payment_cents: 10_000,
    counted_cash_cents: 7_000,
    retained_float_cents: 1_000,
    expected_cash_cents: 6_000,
    cash_difference_cents: 0,
  }),
  print: Object.freeze({
    total: 3,
    statuses: Object.freeze([
      Object.freeze({ status: "done", count: 2 }),
      Object.freeze({ status: "failed", count: 1 }),
    ]),
  }),
  edge_replay: Object.freeze({
    total: 2,
    conflict_count: 1,
    decisions: Object.freeze([
      Object.freeze({ decision: "applied", count: 1 }),
      Object.freeze({ decision: "rejected", count: 1 }),
    ]),
  }),
});

test("parseReconciliationView accepts the exact bounded redacted projection", () => {
  assert.deepEqual(parseReconciliationView(SAMPLE), SAMPLE);
  assert.equal(parseReconciliationView({ ...SAMPLE, customer_phone: "13800000000" }), null);
  assert.equal(
    parseReconciliationView({
      ...SAMPLE,
      ledger: {
        ...SAMPLE.ledger,
        buckets: [SAMPLE.ledger.buckets[0], SAMPLE.ledger.buckets[0]],
      },
    }),
    null,
  );
});

test("parseReconciliationView rejects unsafe money and unbounded evidence", () => {
  assert.equal(
    parseReconciliationView({
      ...SAMPLE,
      ledger: { ...SAMPLE.ledger, net_cents: 1.5 },
    }),
    null,
  );
  assert.equal(
    parseReconciliationView({
      ...SAMPLE,
      print: {
        total: 5,
        statuses: [
          { status: "queued", count: 1 },
          { status: "printing", count: 1 },
          { status: "done", count: 1 },
          { status: "failed", count: 1 },
          { status: "done", count: 1 },
        ],
      },
    }),
    null,
  );
});

test("ReconciliationSnapshot renders ledger, shift, print and replay evidence", () => {
  const html = renderToStaticMarkup(createElement(ReconciliationSnapshot, { value: SAMPLE }));
  assert.match(html, /data-testid="reconciliation-snapshot"/u);
  assert.match(html, /当日口径一致/u);
  assert.match(html, /支付账本/u);
  assert.match(html, /现金/u);
  assert.match(html, /退款/u);
  assert.match(html, /打印（软件状态）/u);
  assert.match(html, /离线回放/u);
  assert.doesNotMatch(html, /13800000000|token|cookie/iu);
});

test("reconciliation export requires a safe filename and matching SHA-256", async () => {
  const csv = "section,key,value\r\nsummary,net_cents,100\r\n";
  const content_sha256 = createHash("sha256").update(csv, "utf8").digest("hex");
  const parsed = parseReconciliationExport({
    filename: "reconciliation-2026-07-30.csv",
    content_sha256,
    csv,
  });
  assert.ok(parsed);
  assert.equal(await verifyReconciliationExport(parsed), true);
  assert.equal(
    await verifyReconciliationExport({ ...parsed, csv: `${parsed.csv}tampered` }),
    false,
  );
  assert.equal(
    parseReconciliationExport({
      filename: "../reconciliation-2026-07-30.csv",
      content_sha256,
      csv,
    }),
    null,
  );
});
