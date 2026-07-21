import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateCode128Dots,
  estimateCode128Modules,
  fitsXp58,
  XP58_PRINTABLE_DOTS,
} from "./code128-width.js";

test("modules use 11n+55 not the old 11n+23 undercount", () => {
  assert.equal(estimateCode128Modules(1), 66);
  assert.notEqual(estimateCode128Modules(1), 11 + 23);
  assert.equal(estimateCode128Dots(1, 2), 132);
});

test("fitsXp58 against 384 printable dots", () => {
  assert.equal(XP58_PRINTABLE_DOTS, 384);
  assert.equal(fitsXp58(10, 1), true);
  assert.equal(fitsXp58(40, 2), false);
});
