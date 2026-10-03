import assert from "node:assert/strict";
import test from "node:test";
import { createMiniappClient } from "./client.js";
import { createPortalController } from "./controller.js";
import { nativeHarness, loginReply, reply, APP_ID, type Request } from "./native-test-support.js";
import type { WxPort } from "./wx-port.js";

const ID = "b1d73334-3e85-4b37-9a03-e322b382c221";
const order = {
  order_id: ID,
  ticket_no: "SYNTHETIC-001",
  status: "open",
  payable_cents: 1200,
  paid_cents: 0,
  balance_cents: 1200,
  garment_count: 1,
  created_at: "2026-10-03T00:00:00Z",
  updated_at: "2026-10-03T00:00:00Z",
};
const publicData = {
  store_name: "合成门店",
  app_id: APP_ID,
  subscription_template_ids: ["template-accepted", "template-rejected"],
};
function baseRequest(request: Request): boolean {
  if (request.url.endsWith("/public")) {
    reply(request, publicData);
    return true;
  }
  if (request.url.endsWith("auth/login")) {
    loginReply(request);
    return true;
  }
  if (request.url.endsWith("/query")) {
    const { name } = request.data as { name: string };
    const results = {
      "customer.self_service.orders.list": { orders: [order] },
      "customer.self_service.wallet.get": { wallet: null },
      "customer.self_service.benefits.get": { benefits: null },
      "customer.self_service.profile.get": { version: 0, preferred_contact: "none", addresses: [] },
    };
    const result = results[name as keyof typeof results];
    assert.ok(result);
    reply(request, { execution: "executed", result });
    return true;
  }
  if (request.url.endsWith("transactions/options")) {
    reply(request, {
      timezone: "Asia/Shanghai",
      delivery_policy: null,
      topup_bonus_rules: [],
      wechat_pay_enabled: true,
      delegation_enabled: true,
    });
    return true;
  }
  if (request.url.endsWith("appointments/list")) {
    reply(request, { appointments: [] });
    return true;
  }
  if (request.url.endsWith("payment/list")) {
    reply(request, { intents: [] });
    return true;
  }
  return false;
}
test("full native controller login, payment and refresh require authoritative paid state", async () => {
  let paid = false;
  const harness = nativeHarness((request) => {
    if (baseRequest(request)) return;
    if (request.url.endsWith("payment/create"))
      reply(request, {
        intent_id: ID,
        state: "pending",
        amount_cents: 1200,
        checkout: {
          kind: "jsapi",
          appId: APP_ID,
          timeStamp: "1791010000",
          nonceStr: "nonce-0123456789abcd",
          package: "prepay_id=synthetic",
          signType: "RSA",
          paySign: "s".repeat(344),
        },
      });
    else if (request.url.endsWith("payment/status"))
      reply(request, {
        intent_id: ID,
        state: paid ? "paid" : "unknown",
        amount_cents: 1200,
        checkout: null,
      });
    else assert.fail(request.url);
  });
  const client = createMiniappClient(harness.wx, { apiOrigin: "https://laundry.example.com" });
  const controller = createPortalController(client, harness.wx, () => undefined);
  await controller.start();
  await controller.login();
  assert.equal(controller.snapshot().authenticated, true);
  await controller.pay(ID);
  assert.equal(harness.payments().length, 1);
  assert.equal(controller.snapshot().intent?.state, "unknown");
  assert.doesNotMatch(controller.snapshot().notice, /已确认/u);
  await controller.pay(ID);
  assert.match(controller.snapshot().error, /上一笔付款/u);
  assert.equal(harness.payments().length, 1);
  paid = true;
  await controller.paymentStatus();
  assert.equal(controller.snapshot().intent?.state, "paid");
  controller.dispose();
  assert.equal(controller.snapshot().orders.length, 0);
  assert.equal(controller.snapshot().intent, null);
  assert.equal(client.isAuthenticated(), false);
});
test("subscription sends only templates explicitly accepted by the native prompt", async () => {
  let subscriptionBody: unknown;
  const harness = nativeHarness((request) => {
    if (baseRequest(request)) return;
    if (request.url.endsWith("/subscriptions")) {
      subscriptionBody = request.data;
      reply(request, { accepted: true });
    } else assert.fail(request.url);
  });
  const controller = createPortalController(
    createMiniappClient(harness.wx, { apiOrigin: "https://laundry.example.com" }),
    harness.wx,
    () => undefined,
  );
  await controller.start();
  await controller.login();
  await controller.subscribe();
  assert.deepEqual(subscriptionBody, { template_ids: ["template-accepted"] });
  assert.equal(controller.snapshot().error, "");
});
test("unknown foreign order and invalid recharge amount are rejected before mutations", async () => {
  const harness = nativeHarness((request) => {
    if (!baseRequest(request)) assert.fail(request.url);
  });
  const controller = createPortalController(
    createMiniappClient(harness.wx, { apiOrigin: "https://laundry.example.com" }),
    harness.wx,
    () => undefined,
  );
  await controller.start();
  await controller.login();
  const count = harness.requests().length;
  await controller.pay("foreign-order");
  assert.match(controller.snapshot().error, /本人未结订单/u);
  controller.input("amount", "1e3");
  await controller.topup();
  assert.match(controller.snapshot().error, /有效金额/u);
  assert.equal(harness.requests().length, count);
});

test("late native confirmation after page disposal cannot create a payment", async () => {
  let prompt: Parameters<WxPort["showModal"]>[0] | undefined;
  const harness = nativeHarness((request) => {
    if (!baseRequest(request)) assert.fail(request.url);
  });
  const wx: WxPort = {
    ...harness.wx,
    showModal: (value) => {
      prompt = value;
    },
  };
  const controller = createPortalController(
    createMiniappClient(wx, { apiOrigin: "https://laundry.example.com" }),
    wx,
    () => undefined,
  );
  await controller.start();
  await controller.login();
  const count = harness.requests().length;
  const operation = controller.pay(ID);
  assert.ok(prompt);
  controller.dispose();
  prompt.success({ confirm: true });
  await operation;
  assert.equal(harness.requests().length, count);
  assert.equal(controller.snapshot().authenticated, false);
  assert.equal(controller.snapshot().intent, null);
});
