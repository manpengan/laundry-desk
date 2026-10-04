import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelIntent } from "@laundry/contracts";
import { parseChannelStatement, paymentQrAllowed } from "./payment-channel-model.js";
const intent: ChannelIntent = {
  intent_id: "11111111-1111-4111-8111-111111111111",
  order_id: null,
  purpose: "order",
  channel: "wechat",
  amount_cents: 100,
  state: "pending",
  qr_url: "weixin://wxpay/bizpayurl?pr=example",
  payment_id: null,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60000).toISOString(),
  error_code: null,
};
test("QR is local-only and only displays approved provider URLs while payment remains pending", () => {
  assert.equal(paymentQrAllowed(intent), true);
  assert.equal(
    paymentQrAllowed({ ...intent, channel: "alipay", qr_url: "https://qr.alipay.com/valid" }),
    true,
  );
  for (const qr_url of [
    "javascript:alert(1)",
    "https://qr.alipay.com.evil.test/pay",
    "https://qr.alipay.com@evil.test/pay",
    "https://user@qr.alipay.com/pay",
    "weixin://evil/pay",
  ])
    assert.equal(paymentQrAllowed({ ...intent, qr_url }), false);
  assert.equal(paymentQrAllowed({ ...intent, state: "paid" }), false);
  assert.equal(paymentQrAllowed({ ...intent, state: "unknown" }), false);
  assert.equal(paymentQrAllowed({ ...intent, expires_at: new Date(0).toISOString() }), false);
});
const header = "商户订单号,渠道订单号,金额分,类型,商户退款号\n";
test("statement import keeps exact cents and validates complete bounded canonical rows", () => {
  assert.deepEqual(
    parseChannelStatement(
      "wechat",
      "2026-10-03",
      "\uFEFF" + header + "ld123,wx456,123,收款,\r\nld789,wx999,1,退款,rf100",
    ).rows,
    [
      {
        merchant_order: "ld123",
        provider_order: "wx456",
        amount_cents: 123,
        kind: "payment",
        merchant_refund: null,
      },
      {
        merchant_order: "ld789",
        provider_order: "wx999",
        amount_cents: 1,
        kind: "refund",
        merchant_refund: "rf100",
      },
    ],
  );
  for (const line of [
    "ld123,wx456,1.23,收款,",
    "ld123,wx456,0,收款,",
    "=FORMULA,wx456,123,收款,",
    "ld123,wx456,123,invalid,",
    "ld123,wx456,5000001,收款,",
  ])
    assert.throws(() => parseChannelStatement("alipay", "2026-10-03", header + line));
  assert.throws(() =>
    parseChannelStatement("alipay", "2026-02-30", header + "ld123,wx456,1,收款,"),
  );
  assert.throws(() => parseChannelStatement("alipay", "2026-10-03", header));
  assert.throws(() => parseChannelStatement("alipay", "2026-10-03", "x".repeat(2_000_001)));
});
