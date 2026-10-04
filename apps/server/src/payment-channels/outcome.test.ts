import assert from "node:assert/strict";
import { test } from "node:test";
import { createChannelHttp } from "./http.js";
import { createWechatAdapter } from "./wechat.js";
import { createAlipayAdapter } from "./alipay.js";
import { channelFixture } from "./protocol-fixture.js";
import { notCreated } from "./outcome.js";
import { ChannelProtocolError, type ChannelHttpRequest } from "./types.js";

const fixture = channelFixture();
const order = "store_test_order_1";
const request: ChannelHttpRequest = {
  channel: "wechat",
  method: "GET",
  path: "/v3/pay/transactions/out-trade-no/store_test_order_1?mchid=1",
  headers: {},
  body: "",
};
const rejectsWith = async (promise: Promise<unknown>, code: string, providerCode?: string) => {
  const error = await promise.then(
    () => assert.fail("expected a channel error"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ChannelProtocolError);
  assert.equal(error.code, code);
  if (providerCode !== undefined) assert.equal(error.providerCode, providerCode);
};

test("a connection that never opened is not sent; anything after sending is unknown", async () => {
  const offline = createChannelHttp(async () => {
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  });
  await rejectsWith(offline(request), "CHANNEL_NOT_SENT");
  const refused = createChannelHttp(async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  await rejectsWith(refused(request), "CHANNEL_NOT_SENT");
  const timeout = createChannelHttp(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  await rejectsWith(timeout(request), "CHANNEL_TRANSPORT_FAILED");
  const reset = createChannelHttp(async () => {
    throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
  });
  await rejectsWith(reset(request), "CHANNEL_TRANSPORT_FAILED");
});

test("Wechat errors: signed 4xx is definitive, unsigned 401 rejects, other unsigned answers stay unknown", async () => {
  const answer = (response: ReturnType<typeof fixture.response>) =>
    createWechatAdapter(fixture.wechat, async () => response, fixture.clock);
  await rejectsWith(
    answer(fixture.response("wechat", { code: "ORDER_NOT_EXIST", message: "x" }, 404)).query(order),
    "CHANNEL_ORDER_NOT_FOUND",
    "ORDER_NOT_EXIST",
  );
  await rejectsWith(
    answer(fixture.response("wechat", { code: "ORDERPAID", message: "x" }, 403)).close(order),
    "CHANNEL_REJECTED",
    "ORDERPAID",
  );
  await rejectsWith(
    answer(fixture.response("wechat", { code: "SYSTEM_ERROR", message: "x" }, 500)).query(order),
    "CHANNEL_TRANSPORT_FAILED",
  );
  const unsigned = (status: number) =>
    answer({ status, headers: {}, body: JSON.stringify({ code: "SIGN_ERROR", message: "x" }) });
  await rejectsWith(unsigned(401).query(order), "CHANNEL_REJECTED", "SIGN_ERROR");
  await rejectsWith(unsigned(400).query(order), "CHANNEL_SIGNATURE_INVALID");
  await rejectsWith(
    answer({ status: 200, headers: {}, body: "{}" }).query(order),
    "CHANNEL_SIGNATURE_INVALID",
  );
});

test("Wechat sends time_expire in documented seconds +08:00 and tolerates unpaid amount fields", async () => {
  let sent: Record<string, unknown> = {};
  const adapter = createWechatAdapter(
    fixture.wechat,
    async (call) => {
      if (call.method === "POST") {
        sent = JSON.parse(call.body) as Record<string, unknown>;
        return fixture.response("wechat", { code_url: "weixin://wxpay/bizpayurl?pr=abc123" });
      }
      return fixture.response("wechat", {
        appid: fixture.wechat.appId,
        mchid: fixture.wechat.merchantId,
        out_trade_no: order,
        trade_state: "NOTPAY",
        amount: { payer_currency: "CNY", total: 1234 },
      });
    },
    fixture.clock,
  );
  await adapter.checkout({
    merchantOrder: order,
    amountCents: 1234,
    description: "洗护服务",
    expiresAt: new Date(fixture.now + 15 * 60_000),
  });
  assert.equal(sent.time_expire, "2026-10-03T08:15:00+08:00");
  assert.deepEqual(await adapter.query(order), {
    merchantOrder: order,
    providerOrder: null,
    state: "pending",
    amountCents: 1234,
    paidAt: null,
  });
  const paidWithoutTotal = createWechatAdapter(
    fixture.wechat,
    async () =>
      fixture.response("wechat", {
        appid: fixture.wechat.appId,
        mchid: fixture.wechat.merchantId,
        out_trade_no: order,
        transaction_id: "4200000000000000001",
        trade_state: "SUCCESS",
        success_time: "2026-10-03T08:00:00+08:00",
      }),
    fixture.clock,
  );
  await rejectsWith(paidWithoutTotal.query(order), "CHANNEL_RESPONSE_INVALID");
});

test("Alipay ends unpaid codes with cancel and recognises a trade that was never scanned", async () => {
  const paths: string[] = [];
  const answers: Record<string, ReturnType<typeof fixture.response>> = {
    "/v3/alipay/trade/cancel": fixture.response("alipay", {
      out_trade_no: order,
      retry_flag: "N",
      action: "close",
    }),
    "/v3/alipay/trade/query": fixture.response(
      "alipay",
      { code: "ACQ.TRADE_NOT_EXIST", message: "x" },
      400,
    ),
    "/v3/alipay/trade/fastpay/refund/query": fixture.response("alipay", {}),
  };
  const adapter = createAlipayAdapter(
    fixture.alipay,
    async (call) => {
      paths.push(call.path);
      return answers[call.path]!;
    },
    fixture.clock,
  );
  assert.deepEqual(await adapter.close(order), { outcome: "closed" });
  await rejectsWith(adapter.query(order), "CHANNEL_ORDER_NOT_FOUND", "ACQ.TRADE_NOT_EXIST");
  await rejectsWith(
    adapter.queryRefund({
      merchantOrder: order,
      merchantRefund: "store_test_refund_1",
      amountCents: 100,
      originalCents: 1234,
      reason: "customer_request",
    }),
    "CHANNEL_ORDER_NOT_FOUND",
  );
  assert.deepEqual(paths.slice(0, 2), ["/v3/alipay/trade/cancel", "/v3/alipay/trade/query"]);
  answers["/v3/alipay/trade/cancel"] = fixture.response("alipay", {
    out_trade_no: order,
    retry_flag: "Y",
  });
  assert.deepEqual(await adapter.close(order), { outcome: "retry" });
});

test("only requests that cannot have created an order release the reservation at dispatch", () => {
  assert.equal(notCreated(new ChannelProtocolError("CHANNEL_NOT_SENT")), true);
  assert.equal(notCreated(new ChannelProtocolError("CHANNEL_REJECTED", "PARAM_ERROR")), true);
  assert.equal(notCreated(new ChannelProtocolError("CHANNEL_REJECTED")), true);
  assert.equal(notCreated(new ChannelProtocolError("CHANNEL_REJECTED", "ORDERPAID")), false);
  assert.equal(
    notCreated(new ChannelProtocolError("CHANNEL_REJECTED", "OUT_TRADE_NO_USED")),
    false,
  );
  assert.equal(notCreated(new ChannelProtocolError("CHANNEL_TRANSPORT_FAILED")), false);
  assert.equal(notCreated(new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID")), false);
});
