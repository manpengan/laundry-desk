import assert from "node:assert/strict";
import test from "node:test";
import { fenToYuanGbk, fenToYuanText, YUAN_SIGN_GBK } from "./money-gbk.js";

test("uses fullwidth yen for thermal GBK", () => {
  assert.equal(YUAN_SIGN_GBK, "￥");
  assert.equal(fenToYuanText(6000), "60.00");
  assert.equal(fenToYuanGbk(6000), "￥60.00");
  assert.notEqual(fenToYuanGbk(100)[0], "¥");
});

test("rejects non-integer fen", () => {
  assert.throws(() => fenToYuanText(1.5), /integer fen/);
});
