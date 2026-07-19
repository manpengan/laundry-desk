import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fenToYuanText } from "../lib/money.ts";
import { WASH_LABEL_VARS, STICKER_VARS, type SampleOrder } from "../lib/variables.ts";
import { buildXp58Receipt } from "../src/xp58-receipt.ts";
import { buildDl206WashLabel, listWashVarsRendered } from "../src/dl206-wash.ts";
import { buildGp3120Sticker, listStickerVarsRendered } from "../src/gp3120-sticker.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const order = JSON.parse(
  readFileSync(join(root, "fixtures/sample-order.json"), "utf8"),
) as SampleOrder;

describe("money fen", () => {
  it("formats integer fen without float", () => {
    assert.equal(fenToYuanText(6000), "60.00");
    assert.equal(fenToYuanText(1), "0.01");
    assert.throws(() => fenToYuanText(1.5));
  });
});

describe("generators", () => {
  it("builds XP-58 ESC/POS with init and cut", () => {
    const buf = buildXp58Receipt(order);
    assert.ok(buf.length > 50);
    assert.equal(buf[0], 0x1b);
    assert.equal(buf[1], 0x40);
    // GS V partial cut
    assert.ok(buf.includes(0x1d) && buf.includes(0x56));
  });

  it("renders all wash variables and includes cutter", () => {
    const lines = listWashVarsRendered(order);
    assert.equal(lines.length, WASH_LABEL_VARS.length);
    assert.ok(lines.every((l) => l.includes("=")));
    const buf = buildDl206WashLabel(order);
    // GS V 0 full cut
    const idx = buf.indexOf(Buffer.from([0x1d, 0x56, 0x00]));
    assert.ok(idx >= 0, "expected GS V 0 cutter");
  });

  it("renders 22 sticker variables as TSPL", () => {
    const lines = listStickerVarsRendered(order);
    assert.equal(lines.length, STICKER_VARS.length);
    assert.equal(STICKER_VARS.length, 22);
    const buf = buildGp3120Sticker(order);
    const text = buf.toString("latin1");
    assert.ok(text.includes("SIZE "));
    assert.ok(text.includes("PRINT "));
    assert.ok(text.includes("BARCODE "));
  });
});
