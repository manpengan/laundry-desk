import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertIntegerFen,
  formatFenToYuan,
  formatMoneyFromFen,
  parseYuanToFen,
  YUAN_SIGN_UI,
} from "./money.js";

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

describe("money yuan parsing", () => {
  it("parseYuanToFen accepts yuan text and returns exact integer fen", () => {
    assert.deepEqual(parseYuanToFen("15"), { ok: true, fen: 1500 });
    assert.deepEqual(parseYuanToFen("15.5"), { ok: true, fen: 1550 });
    assert.deepEqual(parseYuanToFen("15.50"), { ok: true, fen: 1550 });
    assert.deepEqual(parseYuanToFen("0.01"), { ok: true, fen: 1 });
    assert.deepEqual(parseYuanToFen("  8.29  "), { ok: true, fen: 829 });
    assert.deepEqual(parseYuanToFen("-1.50"), { ok: true, fen: -150 });
  });

  it("parseYuanToFen never routes through a float", () => {
    // Number("8.29") * 100 === 828.9999999999999; the string parser must not.
    for (const [text, fen] of [
      ["8.29", 829],
      ["1.10", 110],
      ["70.07", 7007],
      ["1234.56", 123456],
    ] as const) {
      assert.deepEqual(parseYuanToFen(text), { ok: true, fen });
    }
  });

  it("parseYuanToFen rejects malformed, over-precise and oversized amounts", () => {
    for (const bad of ["", "   ", "abc", "1.234", "1.", ".5", "1,000", "1e3", "١٥", "+5", "--1"]) {
      const parsed = parseYuanToFen(bad);
      assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    }
    assert.equal(parseYuanToFen("999999999999999999").ok, false);
    assert.deepEqual(parseYuanToFen("90071992547409.91"), {
      ok: true,
      fen: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(parseYuanToFen("90071992547409.92").ok, false);
  });

  it("parseYuanToFen round-trips against formatFenToYuan", () => {
    for (const fen of [0, 1, 99, 100, 150, 829, 7007, 123456]) {
      assert.deepEqual(parseYuanToFen(formatFenToYuan(fen)), { ok: true, fen });
    }
  });
});
