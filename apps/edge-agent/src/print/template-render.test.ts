import assert from "node:assert/strict";
import test from "node:test";

import { YUAN_SIGN_GBK } from "../drivers/render/money-gbk.js";
import { renderTicketTemplate, type TicketTemplateInput } from "./template-render.js";

const base: TicketTemplateInput = Object.freeze({
  storeName: "测试店",
  ticketNo: "T1",
  barcode: "ABC1234567890123",
  customerName: "张三",
  receiveDate: "2026-07-21",
  lines: Object.freeze([Object.freeze({ name: "西裤", qty: 1, unitPriceFen: 2500 })]),
  totalFen: 2500,
  paidFen: 2500,
});

test("render money uses integer fen only and fullwidth yen", () => {
  const rendered = renderTicketTemplate(base);
  assert.equal(rendered.totalText, `${YUAN_SIGN_GBK}25.00`);
  assert.equal(rendered.paidText, `${YUAN_SIGN_GBK}25.00`);
  assert.ok(rendered.lines.some((l) => l.includes(`${YUAN_SIGN_GBK}25.00`)));
  assert.notEqual(rendered.totalText[0], "¥");
});

test("render rejects non-integer fen", () => {
  assert.throws(() => renderTicketTemplate({ ...base, totalFen: 10.5 }), /integer fen/);
  assert.throws(() => renderTicketTemplate({ ...base, paidFen: 1.1 }), /integer fen/);
  assert.throws(
    () =>
      renderTicketTemplate({
        ...base,
        lines: [{ name: "x", qty: 1, unitPriceFen: 0.3 }],
      }),
    /integer fen/,
  );
});

test("barcode width plan uses code128 estimator", () => {
  const rendered = renderTicketTemplate({ ...base, barcodeModuleWidth: 1 });
  assert.equal(rendered.barcodeSymbolCount, base.barcode.length);
  assert.equal(rendered.barcodeDots, 11 * base.barcode.length + 55);
  assert.equal(rendered.barcodeFitsXp58, true);
  assert.equal(rendered.printableDots, 384);
});
