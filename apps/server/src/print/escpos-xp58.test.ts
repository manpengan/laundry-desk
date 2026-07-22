/**
 * Unit tests for server XP-58 ESC/POS builder (no USB).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildXp58EscPosFromTicket, escCut, escInit, escLine } from "./escpos-xp58.js";

test("ESC/POS primitives produce non-empty bytes", () => {
  assert.ok(escInit().byteLength > 0);
  assert.ok(escLine("hello").byteLength > 1);
  assert.ok(escCut().byteLength > 0);
});

test("buildXp58EscPosFromTicket yields init + cut and includes ticket no", () => {
  const bytes = buildXp58EscPosFromTicket("20260722-0001");
  assert.ok(bytes.byteLength > 0);
  assert.equal(bytes[0], 0x1b);
  assert.equal(bytes[1], 0x40);
  assert.equal(bytes[bytes.byteLength - 3], 0x1d);
  assert.equal(bytes[bytes.byteLength - 2], 0x56);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes("20260722-0001"));
});

test("buildXp58EscPosFromTicket accepts custom lines", () => {
  const bytes = buildXp58EscPosFromTicket("T1", ["A", "B"]);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes("A"));
  assert.ok(text.includes("B"));
});
