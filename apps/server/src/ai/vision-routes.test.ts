import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
test("vision HTTP denies anonymous/CSRF/URL injection and leaves external providers off until explicitly configured", async () => {
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
  const url = "/api/v2/ai/vision/candidates";
  try {
    assert.equal(
      (await app.inject({ method: "POST", url, headers: browser, payload: { key: "test" } }))
        .statusCode,
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
    const headers = {
      ...browser,
      authorization: `Bearer ${(login.json() as { data: { access_token: string } }).data.access_token}`,
    };
    assert.equal(
      (await app.inject({ method: "POST", url, headers, payload: { key: "test" } })).statusCode,
      403,
    );
    const raw = login.headers["set-cookie"];
    const cookies = (Array.isArray(raw) ? raw : [raw ?? ""]).map((v) => v.split(";")[0]).join("; ");
    const auth = {
      ...headers,
      cookie: cookies,
      "x-csrf-token": /laundry_csrf=([^;]+)/u.exec(cookies)?.[1] ?? "",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: auth,
          payload: { key: "test", url: "https://arbitrary.invalid" },
        })
      ).statusCode,
      400,
    );
    const disabled = await app.inject({
      method: "POST",
      url: "/api/v2/ai/vision/analyze",
      headers: auth,
      payload: {},
    });
    assert.equal(disabled.statusCode, 503);
  } finally {
    await app.close();
  }
});
