import assert from "node:assert/strict";
import test from "node:test";

import { buildXp58EscPos, escCode128, escCut, escInit, escLine } from "./escpos-xp58.js";
import { renderTicketTemplate } from "./template-render.js";

test("ESC/POS primitives produce non-empty bytes", () => {
  assert.ok(escInit().byteLength > 0);
  assert.ok(escLine("hello").byteLength > 1);
  assert.ok(escCut().byteLength > 0);
});

test("XP-58 CODE128 requires printable ASCII and emits GS k", () => {
  const bytes = escCode128("HF202607230001");
  assert.ok(bytes.some((byte, index) => byte === 0x1d && bytes[index + 1] === 0x6b));
  assert.throws(() => escCode128("条码"), /printable ASCII/u);
});

test("buildXp58EscPos yields non-empty stream with init + cut", () => {
  const ticket = renderTicketTemplate({
    storeName: "店",
    ticketNo: "T9",
    barcode: "HF001",
    customerName: "客",
    receiveDate: "2026-07-21",
    lines: [{ name: "衣", qty: 1, unitPriceFen: 100 }],
    totalFen: 100,
    paidFen: 100,
  });
  const bytes = buildXp58EscPos(ticket);
  assert.ok(bytes.byteLength > 0);
  // ESC @
  assert.equal(bytes[0], 0x1b);
  assert.equal(bytes[1], 0x40);
  // ends with GS V (cut)
  assert.equal(bytes[bytes.byteLength - 3], 0x1d);
  assert.equal(bytes[bytes.byteLength - 2], 0x56);
});
