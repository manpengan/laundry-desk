import assert from "node:assert/strict";
import test from "node:test";
import { createMiniappClient } from "./client.js";
import { createTransactions, invokePayment, type PaymentIntent } from "./transaction-client.js";
import { nativeHarness, loginReply, reply, APP_ID } from "./native-test-support.js";
import { amountCents, appointmentEpoch } from "./model.js";
import type { WxPort } from "./wx-port.js";

const ID = "b1d73334-3e85-4b37-9a03-e322b382c221";
const pending: PaymentIntent = {
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
};
test("uncertain create response retries the exact idempotency key and integer cents", async () => {
  let failures = 1;
  const harness = nativeHarness((request) => {
    if (request.url.endsWith("auth/login")) return loginReply(request);
    if (failures-- > 0) return request.fail({ errMsg: "timeout" });
    reply(request, pending);
  });
  const client = createMiniappClient(harness.wx, { apiOrigin: "https://laundry.example.com" });
  await client.login();
  const transactions = createTransactions(client, harness.wx);
  await assert.rejects(transactions.topup(1200), /网络连接失败/u);
  assert.deepEqual(await transactions.topup(1200), pending);
  assert.deepEqual(harness.requests()[1]?.data, harness.requests()[2]?.data);
  assert.equal(harness.randomCalls(), 1);
  assert.equal(harness.payments().length, 0);
});
test("native payment success is only submitted and cannot mark the server intent paid", async () => {
  const harness = nativeHarness(() => undefined);
  assert.equal(await invokePayment(harness.wx, pending), "submitted");
  assert.equal(pending.state, "pending");
  assert.deepEqual(Object.keys(harness.payments()[0] ?? {}).sort(), [
    "fail",
    "nonceStr",
    "package",
    "paySign",
    "signType",
    "success",
    "timeStamp",
  ]);
  await assert.rejects(invokePayment(harness.wx, { ...pending, state: "unknown" }), /结果待确认/u);
  await assert.rejects(
    invokePayment(harness.wx, {
      ...pending,
      checkout: { ...pending.checkout!, appId: "wx0000000000000000" },
    }),
    /配置不匹配/u,
  );
  assert.equal(harness.payments().length, 1);
});
test("monetary input and appointment time are deterministic without phone timezone", () => {
  assert.equal(amountCents("0.29"), 29);
  assert.equal(amountCents("50000"), 5_000_000);
  for (const value of ["-1", "1e3", "0", "1.001", "50000.01", "NaN"])
    assert.throws(() => amountCents(value));
  assert.equal(
    appointmentEpoch("2026-10-03", "09:30", "Asia/Shanghai"),
    Date.UTC(2026, 9, 3, 1, 30) / 1000,
  );
  assert.throws(() => appointmentEpoch("2026-02-30", "09:30", "Asia/Shanghai"));
  assert.throws(() => appointmentEpoch("2026-10-03", "09:30", "America/New_York"));
});

test("late native random identifier cannot replay a mutation into a new session", async () => {
  let random: Parameters<WxPort["getRandomValues"]>[0] | undefined;
  const harness = nativeHarness((request) => {
    if (request.url.endsWith("auth/login")) loginReply(request);
    else assert.fail(request.url);
  });
  const wx: WxPort = {
    ...harness.wx,
    getRandomValues: (value) => {
      random = value;
    },
  };
  const client = createMiniappClient(wx, { apiOrigin: "https://laundry.example.com" });
  await client.login();
  const transactions = createTransactions(client, wx);
  const operation = transactions.topup(1200);
  assert.ok(random);
  client.clear();
  transactions.clear();
  await client.login();
  random.success({ randomValues: new Uint8Array(16).buffer });
  await assert.rejects(operation, /会话已结束/u);
  assert.equal(harness.requests().length, 2);
});
