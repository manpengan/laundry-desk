import assert from "node:assert/strict";
import test from "node:test";
import iconv from "iconv-lite";

import { YUAN_SIGN_GBK } from "../drivers/render/money-gbk.js";
import { buildDl206Tspl } from "./tspl-dl206.js";
import { buildGp3120Tspl } from "./tspl-gp3120.js";
import { buildPrinterPayload } from "./printer-drivers.js";
import { renderTicketTemplate, type TicketTemplateInput } from "./template-render.js";

const SAMPLE: TicketTemplateInput = Object.freeze({
  storeName: "宏发洗衣演示店",
  ticketNo: "T202607230001",
  barcode: "HF202607230001",
  customerName: "演示顾客",
  receiveDate: "2026-07-23",
  pickupDate: "2026-07-25",
  lines: Object.freeze([Object.freeze({ name: "羊毛大衣", qty: 1, unitPriceFen: 12_500 })]),
  totalFen: 12_500,
  paidFen: 12_500,
  payMethod: "现金",
  noticeLines: Object.freeze(["请凭条码取衣"]),
});

function gbk(bytes: Uint8Array): string {
  return iconv.decode(Buffer.from(bytes), "gbk");
}

test("XP-58 golden includes init, fullwidth ￥, CODE128 and cut", () => {
  const bytes = buildPrinterPayload("xp58", renderTicketTemplate(SAMPLE));
  assert.deepEqual([...bytes.slice(0, 2)], [0x1b, 0x40]);
  assert.match(gbk(bytes), new RegExp(YUAN_SIGN_GBK, "u"));
  assert.equal(bytes.includes(0x3f), false, "GBK money glyph must not degrade to ?");
  assert.ok(bytes.some((byte, index) => byte === 0x1d && bytes[index + 1] === 0x6b));
  assert.deepEqual([...bytes.slice(-3)], [0x1d, 0x56, 1]);
});

test("DL-206 golden uses wash-label TSPL, fullwidth ￥ and cut/feed", () => {
  const bytes = buildDl206Tspl(renderTicketTemplate(SAMPLE));
  const text = gbk(bytes);
  assert.match(text, /^SIZE 58 mm, 50 mm\r\n/u);
  assert.match(text, new RegExp(YUAN_SIGN_GBK, "u"));
  assert.match(text, /BARCODE /u);
  assert.match(text, /CUT\r\n$/u);
});

test("GP-3120 golden uses bounded TSPL label and does not issue a cutter command", () => {
  const bytes = buildGp3120Tspl(
    renderTicketTemplate({ ...SAMPLE, customerName: "超长字段".repeat(30) }),
  );
  const text = gbk(bytes);
  assert.match(text, /^SIZE 40 mm, 30 mm\r\n/u);
  assert.match(text, /BARCODE /u);
  assert.match(text, /PRINT 1,1\r\n$/u);
  assert.equal(text.includes("CUT"), false);
  assert.match(text, /…/u);
});

test("drivers reject control-byte template injection before serializing TSPL", () => {
  const ticket = renderTicketTemplate({ ...SAMPLE, customerName: "bad\u0000field" });
  assert.throws(() => buildGp3120Tspl(ticket), /control character/u);
  assert.throws(() => buildDl206Tspl(ticket), /control character/u);
});
