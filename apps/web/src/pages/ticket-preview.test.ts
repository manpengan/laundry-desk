import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReceiveTicketPreview,
  buildTicketPreviewInputFromReceive,
  formatReceiveDateLabel,
  ticketLineName,
  toTicketPreviewLines,
  triggerBrowserPrint,
} from "./ticket-preview.js";
import type { ReceiveOrderResult } from "./order-form.js";

const result: ReceiveOrderResult = Object.freeze({
  order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ticket_no: "20260722-0001",
  payable_cents: 3000,
  paid_cents: 1000,
  balance_cents: 2000,
  garment_count: 2,
  garments: Object.freeze([
    Object.freeze({
      garment_id: "11111111-2222-4333-8444-555555555555",
      barcode: "BC1",
      status: "received",
      line_index: 0,
      seq: 1,
    }),
  ]),
});

const lines = Object.freeze([
  Object.freeze({
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1500,
    qty: 2,
  }),
]);

test("ticketLineName joins service/category", () => {
  assert.equal(ticketLineName("wash", "shirt"), "wash/shirt");
});

test("toTicketPreviewLines maps drafts", () => {
  const mapped = toTicketPreviewLines(lines);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]?.name, "wash/shirt");
  assert.equal(mapped[0]?.qty, 2);
  assert.equal(mapped[0]?.unit_price_cents, 1500);
});

test("buildTicketPreviewInputFromReceive maps money + ticket_no", () => {
  const input = buildTicketPreviewInputFromReceive(result, lines, {
    storeName: "前台店",
    storePhone: "010-1",
    receiveDate: "2026-07-22",
  });
  assert.equal(input.ticket_no, "20260722-0001");
  assert.equal(input.store_name, "前台店");
  assert.equal(input.payable_cents, 3000);
  assert.equal(input.paid_cents, 1000);
  assert.equal(input.balance_cents, 2000);
  assert.equal(input.lines[0]?.name, "wash/shirt");
});

test("buildReceiveTicketPreview renders halfwidth yen and ticket_no", () => {
  const preview = buildReceiveTicketPreview({
    result,
    lines,
    storeName: "前台店",
    receiveDate: "2026-07-22",
    customerName: "李四",
    customerPhone: "13800000111",
  });
  assert.ok(preview.lines.some((l) => l.includes("20260722-0001")));
  assert.ok(preview.lines.some((l) => l.includes("李四")));
  assert.equal(preview.total_text, "¥30.00");
  assert.equal(preview.paid_text, "¥10.00");
  assert.equal(preview.balance_text, "¥20.00");
  assert.equal(preview.total_text[0], "\u00A5");
});

test("formatReceiveDateLabel is YYYY-MM-DD", () => {
  const label = formatReceiveDateLabel(new Date(Date.UTC(2026, 6, 22, 12, 0, 0)));
  // Local timezone may shift day; shape still YYYY-MM-DD
  assert.match(label, /^\d{4}-\d{2}-\d{2}$/u);
});

test("triggerBrowserPrint is a no-op without window.print", () => {
  assert.doesNotThrow(() => triggerBrowserPrint());
});
