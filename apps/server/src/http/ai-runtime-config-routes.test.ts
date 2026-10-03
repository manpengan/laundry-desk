import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";

test("runtime config requires manager authority and CSRF and reports unavailable custody honestly", async () => {
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  const host = { host: "127.0.0.1:8787" };
  const browser = { ...host, origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" };
  const login = async (username: string) => {
    const result = await app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers: browser,
      payload: {
        org_code: "local",
        store_code: "main",
        username,
        password: DEMO_PASSWORD,
        device_id: randomUUID(),
      },
    });
    assert.equal(result.statusCode, 200);
    return (result.json() as { data: { access_token: string } }).data.access_token;
  };
  try {
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/v2/ai/runtime-config",
      headers: host,
    });
    assert.equal(anonymous.statusCode, 401);
    const staff = await login("staff");
    const admin = await login("admin");
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v2/ai/runtime-config",
      headers: { ...host, authorization: `Bearer ${staff}` },
    });
    assert.equal(forbidden.statusCode, 403);
    const read = await app.inject({
      method: "GET",
      url: "/api/v2/ai/runtime-config",
      headers: { ...host, authorization: `Bearer ${admin}` },
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), { ok: true, data: { config: null, custody_available: false } });
    const mutation = await app.inject({
      method: "POST",
      url: "/api/v2/ai/runtime-config",
      headers: { ...browser, authorization: `Bearer ${admin}` },
      payload: {},
    });
    assert.equal(mutation.statusCode, 403);
  } finally {
    await app.close();
  }
});
