import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fenToYuanText } from "../lib/money.ts";
import {
  WASH_LABEL_VARS,
  STICKER_VARS,
  type SampleOrder,
} from "../lib/variables.ts";
import {
  encodeCode128Payload,
  estimateCode128Dots,
  barcodeCode128,
  XP58_PRINTABLE_DOTS,
} from "../lib/escpos.ts";
import { escapeTsplText, text as tsplText } from "../lib/tspl.ts";
import {
  emptyVarsOrder,
  longTextOrder,
  specialCharsOrder,
} from "../lib/boundary.ts";
import { buildXp58Receipt, XP58_BARCODE_VARIANTS } from "../src/xp58-receipt.ts";
import { buildDl206WashLabel, listWashVarsRendered } from "../src/dl206-wash.ts";
import {
  buildGp3120Sticker,
  buildGp3120StickerCompact,
  listStickerVarsRendered,
} from "../src/gp3120-sticker.ts";

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

describe("CODE128 code-set prefix", () => {
  it("prefixes {B for pure B", () => {
    const p = encodeCode128Payload("LD20260719000101", "B");
    assert.equal(p.subarray(0, 2).toString("ascii"), "{B");
    assert.ok(p.toString("ascii").startsWith("{BLD"));
  });

  it("builds {B/{C mixed for alphanumeric ticket", () => {
    const p = encodeCode128Payload("LD20260719000101", "BC");
    const s = p.toString("ascii");
    assert.ok(s.startsWith("{B"));
    assert.ok(s.includes("{C"));
    assert.ok(s.includes("LD"));
  });

  it("BC+w1 estimate fits 58mm printable; pure B+w2 does not", () => {
    const bc = encodeCode128Payload(order.barcode, "BC");
    const b = encodeCode128Payload(order.barcode, "B");
    const bcW1 = estimateCode128Dots(bc.length, 1);
    const bW2 = estimateCode128Dots(b.length, 2);
    assert.ok(bcW1 <= XP58_PRINTABLE_DOTS, `BC w1 ${bcW1} > ${XP58_PRINTABLE_DOTS}`);
    assert.ok(bW2 > XP58_PRINTABLE_DOTS, `expected B w2 ${bW2} to exceed paper`);
  });

  it("GS k payload includes 0x7B code-set marker", () => {
    const buf = barcodeCode128(order.barcode, { mode: "BC", moduleWidth: 1 });
    const idx = buf.indexOf(0x1d);
    assert.ok(idx >= 0);
    // find GS k 73
    let found = false;
    for (let i = 0; i < buf.length - 3; i += 1) {
      if (buf[i] === 0x1d && buf[i + 1] === 0x6b && buf[i + 2] === 73) {
        const len = buf[i + 3];
        const body = buf.subarray(i + 4, i + 4 + len);
        assert.equal(body[0], 0x7b); // {
        assert.ok(body[1] === 0x42 || body[1] === 0x43); // B or C
        found = true;
        break;
      }
    }
    assert.ok(found, "GS k 73 not found");
  });
});

describe("TSPL escape", () => {
  it("escapes quotes and flattens newlines", () => {
    assert.equal(escapeTsplText('a"b\nc'), "a＂b c");
  });

  it("TEXT command contains fullwidth quote not raw ASCII quote in value", () => {
    const buf = tsplText(0, 0, "TSS16.BF2", '名"称');
    const raw = buf.toString("binary");
    // field should not contain unescaped "name" pattern that closes early
    assert.ok(raw.includes("TEXT "));
    assert.ok(!raw.includes('TSS16.BF2",0,1,1,"名"称"'));
  });
});

describe("generators", () => {
  it("builds XP-58 with default BC barcode variants available", () => {
    const buf = buildXp58Receipt(order);
    assert.ok(buf.length > 50);
    assert.equal(buf[0], 0x1b);
    assert.equal(buf[1], 0x40);
    assert.ok(buf.includes(0x1d) && buf.includes(0x56));
    assert.equal(XP58_BARCODE_VARIANTS.length, 4);
  });

  it("renders all wash variables and includes cutter", () => {
    const lines = listWashVarsRendered(order);
    assert.equal(lines.length, WASH_LABEL_VARS.length);
    const buf = buildDl206WashLabel(order);
    const idx = buf.indexOf(Buffer.from([0x1d, 0x56, 0x00]));
    assert.ok(idx >= 0, "expected GS V 0 cutter");
  });

  it("fullvars sticker fits raised SIZE 40x90", () => {
    const lines = listStickerVarsRendered(order);
    assert.equal(lines.length, STICKER_VARS.length);
    const buf = buildGp3120Sticker(order);
    const text = buf.toString("latin1");
    assert.ok(text.includes("SIZE 40 mm, 90 mm"));
    assert.ok(text.includes("BARCODE "));
    assert.ok(text.includes("PRINT "));
  });

  it("compact sticker stays on 40x30", () => {
    const buf = buildGp3120StickerCompact(order);
    assert.ok(buf.toString("latin1").includes("SIZE 40 mm, 30 mm"));
  });

  it("boundary samples generate without throw", () => {
    for (const sample of [
      emptyVarsOrder(),
      longTextOrder(),
      specialCharsOrder(),
    ]) {
      assert.ok(buildXp58Receipt(sample).length > 20);
      assert.ok(buildDl206WashLabel(sample).length > 20);
      assert.ok(buildGp3120StickerCompact(sample).length > 20);
    }
  });

  it("special-char sticker escapes quotes in TEXT payload", () => {
    assert.equal(escapeTsplText('名"称\nX'), "名＂称 X");
    const asciiLine = tsplText(0, 0, "TSS16.BF2", 'val"ue').toString("latin1");
    // content uses fullwidth ＂ (GBK), not raw 0x22 inside value
    assert.ok(asciiLine.startsWith("TEXT "));
    assert.ok(!asciiLine.includes('1,1,"val"ue"'));
    assert.ok(buildGp3120StickerCompact(specialCharsOrder()).length > 20);
  });
});
