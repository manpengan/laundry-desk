import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertIntegerFen, formatFenToYuan, formatMoneyFromFen, YUAN_SIGN_UI } from "./money.js";

describe("money fen formatting", () => {
  it("formats integer fen to yuan text", () => {
    assert.equal(formatFenToYuan(0), "0.00");
    assert.equal(formatFenToYuan(1), "0.01");
    assert.equal(formatFenToYuan(6000), "60.00");
    assert.equal(formatFenToYuan(-150), "-1.50");
  });

  it("rejects non-integer fen", () => {
    assert.throws(() => assertIntegerFen(1.5));
    assert.throws(() => formatFenToYuan(1.5));
    assert.throws(() => formatMoneyFromFen(0.1));
  });

  it("prefixes currency for MoneyText", () => {
    assert.equal(YUAN_SIGN_UI, "¥");
    assert.equal(formatMoneyFromFen(6000), "¥60.00");
    assert.equal(formatMoneyFromFen(-150), "-¥1.50");
  });
});
