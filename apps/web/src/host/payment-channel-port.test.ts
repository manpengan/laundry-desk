import assert from "node:assert/strict";
import test from "node:test";
import {
  createHttpPaymentChannelOperation,
  createPaymentChannelPort,
} from "./payment-channel-port.js";
const id = "11111111-1111-4111-8111-111111111111";
const settings = { custody_available: true, settings: [] };
test("channel operations reject invalid input and mismatched success shapes without reflecting credentials", async () => {
  let calls = 0;
  const port = createPaymentChannelPort(async () => {
    calls++;
    return { ok: true, data: settings };
  });
  assert.equal(
    (await port.checkout({ idempotency_key: id, order_id: "not-an-order", channel: "wechat" })).ok,
    false,
  );
  assert.equal(calls, 0);
  assert.equal((await port.status(id)).ok, false);
  assert.deepEqual(await port.settings(), { ok: true, data: settings });
  const secret = "private merchant credential";
  const error = await createPaymentChannelPort(async () => {
    throw new Error(secret);
  }).settings();
  assert.equal(error.ok, false);
  assert.equal(JSON.stringify(error).includes(secret), false);
});
test("HTTP channel adapter uses only fixed routes with session/CSRF and aborts cross-session results", async () => {
  let token: string | null = "first",
    csrf: string | null = "csrf";
  const seen: { url: string; init: RequestInit }[] = [];
  let release: ((response: Response) => void) | undefined;
  const op = createHttpPaymentChannelOperation({
    apiBaseUrl: "https://store.example/",
    getAccessToken: () => token,
    readCsrf: () => csrf,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = op({ operation: "status", body: { intent_id: id } });
  assert.equal(seen[0]!.url, "https://store.example/api/v2/payment-channels/status");
  assert.equal(seen[0]!.init.redirect, "error");
  assert.ok(seen[0]!.init.signal);
  assert.equal(new Headers(seen[0]!.init.headers).get("x-csrf-token"), "csrf");
  token = "second";
  release!(new Response(JSON.stringify({ ok: true, data: settings })));
  assert.equal(await pending, null);
  csrf = null;
  assert.equal(await op({ operation: "close", body: { intent_id: id } }), null);
  token = null;
  assert.equal(await op({ operation: "settings.get" }), null);
  assert.equal(seen.length, 1);
});
test("HTTP channel adapter rejects route injection and an oversized response", async () => {
  let calls = 0;
  const op = createHttpPaymentChannelOperation({
    apiBaseUrl: "https://store.example",
    getAccessToken: () => "access",
    readCsrf: () => "csrf",
    fetchImpl: async () => {
      calls++;
      return new Response("x".repeat(2_000_001));
    },
  });
  await assert.rejects(op({ operation: "settings.get", path: "https://evil.example" } as never));
  assert.equal(calls, 0);
  assert.equal(await op({ operation: "settings.get" }), null);
});

test("channel receipts must match the requested order, intent and refund", async () => {
  const other = "22222222-2222-4222-8222-222222222222";
  const intent = {
    intent_id: id,
    order_id: id,
    purpose: "order",
    channel: "wechat",
    amount_cents: 100,
    state: "paid",
    qr_url: null,
    payment_id: id,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    error_code: null,
  };
  const port = createPaymentChannelPort(async () => ({ ok: true, data: intent }));
  assert.equal((await port.status(other)).ok, false);
  assert.equal((await port.close(other)).ok, false);
  assert.equal(
    (await port.checkout({ idempotency_key: id, order_id: other, channel: "wechat" })).ok,
    false,
  );
  assert.equal(
    (await port.checkout({ idempotency_key: id, order_id: id, channel: "alipay" })).ok,
    false,
  );
  assert.equal((await port.status(id)).ok, true);
  const refund = createPaymentChannelPort(async () => ({
    ok: true,
    data: {
      refund_id: id,
      intent_id: id,
      amount_cents: 1,
      state: "refunded",
      payment_id: id,
      error_code: null,
    },
  }));
  assert.equal((await refund.refundStatus(other)).ok, false);
  const filtered = createPaymentChannelPort(async () => ({
    ok: true,
    data: { intents: [intent] },
  }));
  assert.equal((await filtered.list({ order_id: other })).ok, false);
});
