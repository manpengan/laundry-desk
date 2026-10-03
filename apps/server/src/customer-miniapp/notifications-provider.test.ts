import test from "node:test";
import assert from "node:assert/strict";
import { createWechatNotificationPort } from "./notifications-provider.js";
import type { ProviderHttpRequest } from "../ai/provider-http.js";
import { WechatNotificationConfigSchema } from "@laundry/contracts";
const config = WechatNotificationConfigSchema.parse({
  version: 1,
  available: true,
  enabled: true,
  template_id: "approved_template",
  ticket_field: "character_string1",
  store_field: "thing2",
  status_field: "phrase3",
  miniprogram_state: "trial",
});
const payload = { ticket: "20261003-1", store: "虚构门店", status: "可以取衣" };
const response = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: (async function* () {
    yield Buffer.from(JSON.stringify(body));
  })(),
});
test("WeChat adapter uses fixed endpoints, stable token and exact typed template fields", async () => {
  const calls: ProviderHttpRequest[] = [];
  const provider = createWechatNotificationPort({
    request: async (input) => {
      calls.push(input);
      return response(
        input.url.includes("stable_token")
          ? { access_token: "synthetic_token", expires_in: 7200 }
          : { errcode: 0 },
      );
    },
  });
  const token = await provider.token({
    appId: "wx1234567890abcdef",
    secret: "synthetic-secret-value",
  });
  assert.equal(token, "synthetic_token");
  assert.deepEqual(await provider.send(token, "synthetic_openid_1234", config, payload), {
    state: "accepted",
    errorCode: null,
  });
  assert.equal(new URL(calls[0]!.url).origin, "https://api.weixin.qq.com");
  assert.equal(new URL(calls[0]!.url).pathname, "/cgi-bin/stable_token");
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    grant_type: "client_credential",
    appid: "wx1234567890abcdef",
    secret: "synthetic-secret-value",
    force_refresh: false,
  });
  assert.equal(new URL(calls[1]!.url).pathname, "/cgi-bin/message/subscribe/send");
  assert.deepEqual(JSON.parse(calls[1]!.body!), {
    touser: "synthetic_openid_1234",
    template_id: "approved_template",
    page: "pages/home/index",
    miniprogram_state: "trial",
    lang: "zh_CN",
    data: {
      character_string1: { value: payload.ticket },
      thing2: { value: payload.store },
      phrase3: { value: payload.status },
    },
  });
  assert.ok(calls.every((c) => c.timeoutMs === 10000 && c.method === "POST"));
});
test("rejected and ambiguous responses never imply delivery or retry sends", async () => {
  for (const mode of ["reject", "timeout", "malformed", "http"] as const) {
    let sends = 0;
    const provider = createWechatNotificationPort({
      request: async () => {
        sends++;
        if (mode === "timeout") throw new Error("secret-url-must-not-leak");
        return mode === "reject"
          ? response({ errcode: 43101 })
          : mode === "http"
            ? response({}, 302)
            : response({ errmsg: "ok" });
      },
    });
    const result = await provider.send("token", "synthetic_openid_1234", config, payload);
    assert.equal(result.state, mode === "reject" ? "failed" : "unknown");
    assert.equal(sends, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-url/u);
  }
});
test("token errors are redacted and invalid messages are never submitted", async () => {
  let requests = 0;
  const provider = createWechatNotificationPort({
    request: async () => {
      requests++;
      return response({ errcode: 40013, errmsg: "sensitive" });
    },
  });
  await assert.rejects(
    provider.token({ appId: "wx1234567890abcdef", secret: "synthetic-secret-value" }),
    /^Error: WECHAT_TOKEN_UNAVAILABLE$/u,
  );
  await assert.rejects(
    provider.send("token", "synthetic_openid_1234", config, { ...payload, ticket: "x".repeat(33) }),
  );
  assert.equal(requests, 1);
});
