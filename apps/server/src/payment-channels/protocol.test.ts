import assert from "node:assert/strict";
import { createCipheriv, sign, verify } from "node:crypto";
import { test } from "node:test";
import { createWechatAdapter } from "./wechat.js";
import { createAlipayAdapter } from "./alipay.js";
import { channelFixture } from "./protocol-fixture.js";
import { fen, yuan } from "./protocol.js";
import { createChannelHttp } from "./http.js";

const fixture = channelFixture();
const order = "store_test_order_1";
const checkout = {
  merchantOrder: order,
  amountCents: 1234,
  description: "洗护服务",
  expiresAt: new Date(fixture.now + 900000),
};
const wxPaid = {
  appid: fixture.wechat.appId,
  mchid: fixture.wechat.merchantId,
  out_trade_no: order,
  transaction_id: "4200000000000000001",
  trade_state: "SUCCESS",
  amount: { total: 1234, currency: "CNY" },
  success_time: "2026-10-03T08:00:00+08:00",
};
const aliPaid = {
  out_trade_no: order,
  trade_no: "2026100300000000001",
  trade_status: "TRADE_SUCCESS",
  total_amount: "12.34",
  send_pay_date: "2026-10-03 08:00:00",
};

test("Wechat Native and JSAPI requests and client invocation carry verifiable RSA signatures", async () => {
  const adapter = createWechatAdapter(
    fixture.wechat,
    async (request) => {
      const auth = Object.fromEntries(
        [...request.headers.Authorization!.matchAll(/(\w+)="([^"]+)"/gu)].map((match) => [
          match[1],
          match[2],
        ]),
      );
      const canonical = `${request.method}\n${request.path}\n${auth.timestamp}\n${auth.nonce_str}\n${request.body}\n`;
      assert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(canonical),
          fixture.merchant.publicKey,
          Buffer.from(auth.signature!, "base64"),
        ),
      );
      const body = JSON.parse(request.body) as Record<string, unknown>;
      assert.equal(body.out_trade_no, order);
      assert.deepEqual(body.amount, { total: 1234, currency: "CNY" });
      return fixture.response(
        "wechat",
        request.path.endsWith("jsapi")
          ? { prepay_id: "prepay_test_1" }
          : { code_url: "weixin://wxpay/bizpayurl?pr=abc123" },
      );
    },
    fixture.clock,
  );
  assert.deepEqual(await adapter.checkout(checkout), {
    kind: "qr",
    value: "weixin://wxpay/bizpayurl?pr=abc123",
  });
  const result = await adapter.checkout({ ...checkout, openId: "openid_synthetic_123456789" });
  assert.equal(result.kind, "jsapi");
  if (result.kind === "jsapi")
    assert.ok(
      verify(
        "RSA-SHA256",
        Buffer.from(
          `${result.appId}\n${result.timeStamp}\n${result.nonceStr}\n${result.package}\n`,
        ),
        fixture.merchant.publicKey,
        Buffer.from(result.paySign, "base64"),
      ),
    );
});

test("both signed query protocols bind the requested order and preserve integer fen", async () => {
  const wx = createWechatAdapter(
    fixture.wechat,
    async () => fixture.response("wechat", wxPaid),
    fixture.clock,
  );
  const ali = createAlipayAdapter(
    fixture.alipay,
    async (request) => {
      const header = request.headers.Authorization!;
      const authority = header.slice("ALIPAY-SHA256withRSA ".length, header.indexOf(",sign="));
      const signature = header.slice(header.indexOf(",sign=") + 6);
      assert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(`${authority}\nPOST\n${request.path}\n${request.body}\n`),
          fixture.merchant.publicKey,
          Buffer.from(signature, "base64"),
        ),
      );
      return fixture.response("alipay", aliPaid);
    },
    fixture.clock,
  );
  for (const adapter of [wx, ali]) {
    const paid = await adapter.query(order);
    assert.equal(paid.state, "paid");
    assert.equal(paid.amountCents, 1234);
    assert.equal(paid.paidAt?.getTime(), fixture.now);
    await assert.rejects(adapter.query("another_order"), /CHANNEL_BINDING_MISMATCH/u);
  }
  assert.equal(fen("1.1"), 110);
  assert.equal(fen("1"), 100);
  assert.equal(yuan(1), "0.01");
  for (const invalid of ["NaN", "1e3", "1.001", "-1.00", "00.01", "50000.01"])
    assert.throws(() => fen(invalid));
});

test("unsigned, modified, stale and wrong-platform responses cannot settle", async () => {
  for (const channel of ["wechat", "alipay"] as const) {
    const response = fixture.response(channel, channel === "wechat" ? wxPaid : aliPaid);
    const prefix = channel === "wechat" ? "wechatpay" : "alipay";
    const failures = [
      { ...response, body: response.body.replace("1234", "9999").replace("12.34", "99.99") },
      { ...response, headers: {} },
      { ...response, headers: { ...response.headers, [`${prefix}-timestamp`]: "1000000000" } },
      {
        ...response,
        headers: { ...response.headers, [`${prefix}-signature`]: "WECHATPAY/SIGNTEST/invalid" },
      },
    ];
    for (const failed of failures) {
      const adapter =
        channel === "wechat"
          ? createWechatAdapter(fixture.wechat, async () => failed, fixture.clock)
          : createAlipayAdapter(fixture.alipay, async () => failed, fixture.clock);
      await assert.rejects(adapter.query(order), /CHANNEL_SIGNATURE_INVALID/u);
    }
  }
  const mismatch = createWechatAdapter(
    fixture.wechat,
    async () => fixture.response("wechat", { ...wxPaid, mchid: "9999999999" }),
    fixture.clock,
  );
  await assert.rejects(mismatch.query(order), /CHANNEL_BINDING_MISMATCH/u);
});

test("Wechat callback requires signed authenticated encryption and merchant binding", () => {
  const encrypt = (value: unknown) => {
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(fixture.wechat.apiV3Key),
      Buffer.from("123456789012"),
    );
    cipher.setAAD(Buffer.from("transaction"));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      id: "notification_1",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: {
        algorithm: "AEAD_AES_256_GCM",
        nonce: "123456789012",
        associated_data: "transaction",
        ciphertext: bytes.toString("base64"),
      },
    };
  };
  const adapter = createWechatAdapter(
    fixture.wechat,
    async () => {
      throw new Error("must not send");
    },
    fixture.clock,
  );
  assert.equal(adapter.notification(fixture.response("wechat", encrypt(wxPaid))).kind, "payment");
  assert.throws(
    () => adapter.notification(fixture.response("wechat", encrypt({ ...wxPaid, appid: "wrong" }))),
    /CHANNEL_BINDING_MISMATCH/u,
  );
  const wrongAad = encrypt(wxPaid);
  assert.throws(
    () =>
      adapter.notification(
        fixture.response("wechat", {
          ...wrongAad,
          resource: { ...wrongAad.resource, associated_data: "other" },
        }),
      ),
    /CHANNEL_SIGNATURE_INVALID/u,
  );
});

test("Alipay callback canonicalizes once, rejects duplicate fields and mismatched seller", () => {
  const notification = (extra: Record<string, string> = {}) => {
    const values: Record<string, string> = {
      ...aliPaid,
      app_id: fixture.alipay.appId,
      seller_id: fixture.alipay.sellerId,
      notify_id: "notify_123",
      gmt_payment: "2026-10-03 08:00:00",
      subject: "洗护+服务 & 备注",
      ...extra,
    };
    const canonical = Object.keys(values)
      .sort()
      .map((key) => `${key}=${values[key]}`)
      .join("&");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(canonical),
      fixture.platform.privateKey,
    ).toString("base64");
    return {
      status: 200,
      headers: {},
      body: new URLSearchParams({ ...values, sign: signature, sign_type: "RSA2" }).toString(),
    };
  };
  const adapter = createAlipayAdapter(
    fixture.alipay,
    async () => {
      throw new Error("must not send");
    },
    fixture.clock,
  );
  assert.equal(adapter.notification(notification()).kind, "payment");
  assert.throws(
    () => adapter.notification(notification({ seller_id: "2088999999999999" })),
    /CHANNEL_BINDING_MISMATCH/u,
  );
  const valid = notification();
  assert.throws(
    () => adapter.notification({ ...valid, body: `${valid.body}&total_amount=99.99` }),
    /CHANNEL_RESPONSE_INVALID/u,
  );
  assert.throws(
    () => adapter.notification({ ...valid, body: valid.body.replace("12.34", "99.99") }),
    /CHANNEL_SIGNATURE_INVALID/u,
  );
});

test("refund submission is followed by an exact reference and amount query", async () => {
  const paths: string[] = [];
  const input = {
    merchantOrder: order,
    merchantRefund: "refund_1",
    originalCents: 1234,
    amountCents: 234,
    reason: "重复服务",
  };
  const adapter = createAlipayAdapter(
    fixture.alipay,
    async (request) => {
      paths.push(request.path);
      return fixture.response(
        "alipay",
        request.path.endsWith("/refund")
          ? {}
          : {
              out_trade_no: order,
              out_request_no: "refund_1",
              trade_no: aliPaid.trade_no,
              total_amount: "12.34",
              refund_amount: "2.34",
              refund_status: "REFUND_SUCCESS",
            },
      );
    },
    fixture.clock,
  );
  assert.equal((await adapter.refund(input)).state, "refunded");
  assert.deepEqual(paths, ["/v3/alipay/trade/refund", "/v3/alipay/trade/fastpay/refund/query"]);
  await assert.rejects(
    adapter.queryRefund({ ...input, amountCents: 235 }),
    /CHANNEL_BINDING_MISMATCH/u,
  );
  const wx = createWechatAdapter(
    fixture.wechat,
    async () =>
      fixture.response("wechat", {
        out_trade_no: order,
        out_refund_no: "refund_1",
        refund_id: "refund_provider_1",
        status: "PROCESSING",
        amount: { refund: 234, total: 1234, currency: "CNY" },
      }),
    fixture.clock,
  );
  assert.equal((await wx.refund(input)).state, "pending");
});

test("production transport pins HTTPS origins, rejects redirects and bounds bytes", async () => {
  const request = {
    channel: "wechat" as const,
    method: "POST" as const,
    path: "/v3/pay/transactions/native",
    headers: {},
    body: "{}",
  };
  const seen: string[] = [];
  const transport = createChannelHttp(async (url, options) => {
    seen.push(String(url));
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    return new Response(null, { status: 204 });
  });
  assert.equal((await transport(request)).body, "");
  assert.deepEqual(seen, ["https://api.mch.weixin.qq.com/v3/pay/transactions/native"]);
  // A rejected destination never leaves this computer.
  await assert.rejects(
    transport({ ...request, path: "https://evil.invalid/v3/test" }),
    /CHANNEL_NOT_SENT/u,
  );
  const tooLarge = createChannelHttp(async () => new Response(new Uint8Array(1_048_577)));
  await assert.rejects(tooLarge(request), /CHANNEL_TRANSPORT_FAILED/u);
  const invalidUtf8 = createChannelHttp(async () => new Response(new Uint8Array([255])));
  await assert.rejects(invalidUtf8(request), /CHANNEL_TRANSPORT_FAILED/u);
});
