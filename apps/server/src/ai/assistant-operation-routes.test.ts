import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";

test("assistant confirmation endpoint requires session, CSRF and an exact nonce-only body", async () => {
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  const browser = {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:5173",
    "sec-fetch-site": "same-site",
  };
  const url = "/api/v2/ai/operations/confirm";
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: browser,
          payload: { confirm_ref: randomUUID() },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers: browser,
      payload: {
        org_code: "local",
        store_code: "main",
        username: "admin",
        password: DEMO_PASSWORD,
        device_id: randomUUID(),
      },
    });
    const data = login.json() as { data: { access_token: string } };
    const headers = { ...browser, authorization: `Bearer ${data.data.access_token}` };
    assert.equal(
      (await app.inject({ method: "POST", url, headers, payload: { confirm_ref: randomUUID() } }))
        .statusCode,
      403,
    );
    const raw = login.headers["set-cookie"];
    const cookies = (Array.isArray(raw) ? raw : [raw ?? ""])
      .map((value) => value.split(";")[0])
      .join("; ");
    const csrf = /laundry_csrf=([^;]+)/u.exec(cookies)?.[1] ?? "";
    const authenticated = { ...headers, cookie: cookies, "x-csrf-token": csrf };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authenticated,
          payload: { confirm_ref: randomUUID(), input: {} },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authenticated,
          payload: { confirm_ref: randomUUID() },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
