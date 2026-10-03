import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLocalRequest, createRequestSecurityPolicy } from "./request-security.js";
const policy = createRequestSecurityPolicy({
  allowedHosts: ["127.0.0.1:8787"],
  browserOrigin: "http://127.0.0.1:5173",
  browserFetchSite: "same-site",
  desktopOrigin: "http://127.0.0.1:8787",
});
const decide = (url: string, headers: Readonly<Record<string, string>> = {}, method = "POST") =>
  evaluateLocalRequest(
    {
      method,
      url,
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", ...headers },
    },
    policy,
  );
test("machine entrances retain host isolation and reject ambient browser authority", () => {
  assert.equal(decide("/api/v2/payment-channels/callback/wechat").allowed, true);
  assert.equal(
    decide("/api/v2/payment-channels/callback/alipay", {
      "content-type": "application/x-www-form-urlencoded",
    }).allowed,
    true,
  );
  for (const headers of [
    { origin: "http://127.0.0.1:5173" },
    { cookie: "session=bad" },
    { authorization: "Bearer staff" },
    { "sec-fetch-mode": "cors" },
    { host: "evil.example" },
  ])
    assert.equal(decide("/api/v2/payment-channels/callback/wechat", headers).allowed, false);
  assert.equal(decide("/api/v2/payment-channels/callback/wechat?x=1").allowed, false);
  assert.equal(decide("/api/v2/payment-channels/settings").allowed, false);
  assert.equal(decide("/api/v2/miniapp/public", {}, "GET").allowed, true);
  assert.equal(decide("/api/v2/miniapp/auth/login").allowed, true);
  assert.equal(decide("/api/v2/miniapp/query").allowed, false);
  assert.equal(
    decide("/api/v2/miniapp/query", { authorization: `Bearer m1.${"a".repeat(43)}` }).allowed,
    true,
  );
  assert.equal(decide("/api/v2/miniapp/query", { authorization: "Bearer staff" }).allowed, false);
  assert.equal(decide("/api/v2/miniapp/settings").allowed, false);
  assert.equal(
    decide("/api/v2/miniapp/auth/login", { authorization: `Bearer m1.${"a".repeat(43)}` }).allowed,
    false,
  );
});
