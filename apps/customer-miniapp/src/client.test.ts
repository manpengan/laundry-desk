import assert from "node:assert/strict";
import test from "node:test";
import { createMiniappClient } from "./client.js";
import { MiniappConfigSchema } from "./config.js";
import {
  APP_ID,
  TOKEN,
  nativeHarness,
  loginReply,
  reply,
  type Request,
} from "./native-test-support.js";

const config = { apiOrigin: "https://laundry.example.com" };
test("native login uses one-time WeChat codes; opaque session remains in memory and no tenant/cookie reaches query", async () => {
  const harness = nativeHarness((request) => {
    if (request.url.endsWith("auth/login")) return loginReply(request);
    if (request.url.endsWith("query"))
      return reply(request, { execution: "executed", result: { orders: [] } });
    reply(request, { logged_out: true });
  });
  const client = createMiniappClient(harness.wx, config);
  assert.equal(await client.login("phone-code"), true);
  assert.deepEqual(harness.requests()[0]?.data, {
    code: "synthetic-login-code",
    phone_code: "phone-code",
  });
  assert.deepEqual(await client.query("customer.self_service.orders.list", { limit: 20 }), {
    orders: [],
  });
  assert.deepEqual(harness.requests()[1]?.header, {
    "content-type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  });
  await client.logout();
  assert.equal(client.isAuthenticated(), false);
  const count = harness.requests().length;
  await assert.rejects(client.query("customer.self_service.orders.list", {}), /登录已过期/u);
  assert.equal(harness.requests().length, count);
});
test("late response after logout cannot repopulate the old identity", async () => {
  let held: Request | undefined;
  const harness = nativeHarness((request) => {
    if (request.url.endsWith("auth/login")) loginReply(request);
    else held = request;
  });
  const client = createMiniappClient(harness.wx, config);
  await client.login();
  const response = client.query("customer.self_service.orders.list", {});
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  client.clear();
  assert.ok(held);
  reply(held, { execution: "executed", result: { orders: [] } });
  await assert.rejects(response, /会话已结束/u);
  assert.equal(harness.aborts(), 1);
  assert.equal(client.isAuthenticated(), false);
});
test("login callback cleared before native code returns never starts network authentication", async () => {
  let login: Parameters<typeof harness.wx.login>[0] | undefined;
  const harness = nativeHarness(() => assert.fail("unexpected request"));
  const client = createMiniappClient(
    {
      ...harness.wx,
      login: (value) => {
        login = value;
      },
    },
    config,
  );
  const operation = client.login();
  client.clear();
  assert.ok(login);
  login.success({ code: "test-code" });
  await assert.rejects(operation, /会话已结束/u);
});
test("HTTPS configuration, matching app identity and strict data response are required", async () => {
  for (const origin of [
    "http://localhost:8080",
    "https://127.0.0.1",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
  ]) {
    assert.equal(MiniappConfigSchema.safeParse({ apiOrigin: origin }).success, false);
  }
  const harness = nativeHarness((request) =>
    reply(request, { store_name: "测试门店", app_id: APP_ID, subscription_template_ids: [] }),
  );
  const client = createMiniappClient(harness.wx, config);
  assert.equal((await client.public()).store_name, "测试门店");
  const wrong = createMiniappClient(
    { ...harness.wx, getAccountInfoSync: () => ({ miniProgram: { appId: "wx0000000000000000" } }) },
    config,
  );
  await assert.rejects(wrong.public(), /配置不匹配/u);
});
test("server 401 clears authority and malformed result never enters product data", async () => {
  const harness = nativeHarness((request) => {
    if (request.url.endsWith("auth/login")) loginReply(request);
    else request.success({ statusCode: 401, data: { ok: false } });
  });
  const client = createMiniappClient(harness.wx, config);
  await client.login();
  await assert.rejects(client.query("customer.self_service.wallet.get", {}), /登录已过期/u);
  assert.equal(client.isAuthenticated(), false);
});
