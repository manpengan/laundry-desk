import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";

import { createMockCommandClient } from "../commands/command-client.js";
import { PaymentCollectionDialog, paymentCommandFor } from "./PaymentCollectionDialog.js";
import type { OrderGetResult } from "./order-form.js";

const OPEN_ORDER: OrderGetResult = Object.freeze({
  order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  customer_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ticket_no: "20260722-0001",
  pickup_code: "P202607220001",
  status: "open",
  customer_phone: "13800000111",
  customer_name: "张三",
  payable_cents: 3000,
  paid_cents: 500,
  balance_cents: 2500,
  garments: Object.freeze([
    Object.freeze({
      garment_id: "11111111-2222-4333-8444-555555555555",
      barcode: "BC1",
      status: "received",
      line_index: 0,
      seq: 1,
      unit_price_cents: 3000,
      rack_zone: null,
      rack_slot: null,
    }),
  ]),
});

test("PaymentCollectionDialog selects collection before pickup and displays payment methods", () => {
  assert.equal(paymentCommandFor(OPEN_ORDER), "payment.collect");
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PaymentCollectionDialog, {
        open: true,
        order: OPEN_ORDER,
        commandClient: createMockCommandClient(),
        onClose: () => undefined,
        onCompleted: () => undefined,
      }),
    ),
  );
  assert.match(html, /独立收款/);
  assert.match(html, /微信/);
  assert.match(html, /本次将追加一条不可修改的支付流水/);
});

test("PaymentCollectionDialog uses repayment only after all garments are terminal", () => {
  const repaid = Object.freeze({
    ...OPEN_ORDER,
    garments: Object.freeze([{ ...OPEN_ORDER.garments[0]!, status: "picked_up" }]),
  });
  assert.equal(paymentCommandFor(repaid), "payment.repay");
});
