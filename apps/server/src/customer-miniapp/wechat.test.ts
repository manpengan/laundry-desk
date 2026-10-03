import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderHttpPort, ProviderHttpRequest } from "../ai/provider-http.js";
import { createWechatLoginPort } from "./wechat.js";
const credential = { appId: "wx0123456789abcdef", secret: "synthetic-secret-fixture-0001" };
const response = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: (async function* () {
    yield Buffer.from(JSON.stringify(body));
  })(),
});
test("WeChat protocol sends code only to fixed origin and returns no session secret", async () => {
  const calls: ProviderHttpRequest[] = [];
  const http: ProviderHttpPort = {
    request: async (input) => {
      calls.push(input);
      return response({
        openid: "openid-fixture-00001",
        session_key: "synthetic-session-key",
        unionid: "unused",
      });
    },
  };
  assert.equal(
    await createWechatLoginPort(http).identity(credential, "login-code"),
    "openid-fixture-00001",
  );
  const call = calls[0];
  assert.ok(call);
  const url = new URL(call.url);
  assert.equal(url.origin, "https://api.weixin.qq.com");
  assert.equal(url.pathname, "/sns/jscode2session");
  assert.equal(url.searchParams.get("js_code"), "login-code");
  assert.equal(url.searchParams.get("grant_type"), "authorization_code");
  assert.equal(call.method, "GET");
  assert.equal(call.timeoutMs, 10000);
  assert.equal(call.signal.aborted, true);
});
test("phone verification obtains own-app stable token then checks watermark and mainland number", async () => {
  const calls: ProviderHttpRequest[] = [];
  const http: ProviderHttpPort = {
    request: async (input) => {
      calls.push(input);
      return calls.length === 1
        ? response({ access_token: "fixture-access-token", expires_in: 7200 })
        : response({
            errcode: 0,
            phone_info: {
              purePhoneNumber: "13800000001",
              countryCode: "86",
              watermark: { appid: credential.appId, timestamp: Math.floor(Date.now() / 1000) },
            },
          });
    },
  };
  assert.equal(
    await createWechatLoginPort(http).phone(credential, "one-time-phone-code"),
    "13800000001",
  );
  assert.equal(new URL(calls[0]!.url).pathname, "/cgi-bin/stable_token");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    grant_type: "client_credential",
    appid: credential.appId,
    secret: credential.secret,
    force_refresh: false,
  });
  assert.equal(new URL(calls[1]!.url).pathname, "/wxa/business/getuserphonenumber");
  assert.deepEqual(JSON.parse(calls[1]!.body!), { code: "one-time-phone-code" });
});
test("provider errors, redirects and oversized data fail closed with no secret in public error", async () => {
  for (const payload of [
    { errcode: 40029, errmsg: credential.secret },
    { openid: "fake" },
    "x".repeat(33000),
  ]) {
    const adapter = createWechatLoginPort({ request: async () => response(payload) });
    await assert.rejects(
      adapter.identity(credential, "code"),
      (error) => error instanceof Error && !error.message.includes(credential.secret),
    );
  }
  await assert.rejects(
    createWechatLoginPort({ request: async () => response({}, 302) }).identity(credential, "code"),
    /AUTHENTICATION_FAILED/u,
  );
});
test("a phone result for another app or stale grant cannot bind a customer", async () => {
  for (const watermark of [
    { appid: "wx1111111111111111", timestamp: Math.floor(Date.now() / 1000) },
    { appid: credential.appId, timestamp: 1 },
  ]) {
    let count = 0;
    const adapter = createWechatLoginPort({
      request: async () =>
        ++count === 1
          ? response({ access_token: "fixture", expires_in: 7200 })
          : response({
              phone_info: { purePhoneNumber: "13800000001", countryCode: "86", watermark },
            }),
    });
    await assert.rejects(adapter.phone(credential, "code"));
  }
});
