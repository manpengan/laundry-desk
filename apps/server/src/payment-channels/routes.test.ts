import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
test("payment administration rejects staff, anonymous and missing-CSRF mutation before parsing credentials", async () => {
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  const host = { host: "127.0.0.1:8787" };
  const browser = { ...host, origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" };
  const login = async (username: string) => {
    const response = await app.inject({
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
    assert.equal(response.statusCode, 200);
    return (response.json() as { data: { access_token: string } }).data.access_token;
  };
  try {
    const path = "/api/v2/payment-channels/settings";
    assert.equal((await app.inject({ method: "GET", url: path, headers: host })).statusCode, 401);
    const staff = await login("staff");
    const admin = await login("admin");
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path,
          headers: { ...host, authorization: `Bearer ${staff}` },
        })
      ).statusCode,
      403,
    );
    const view = await app.inject({
      method: "GET",
      url: path,
      headers: { ...host, authorization: `Bearer ${admin}` },
    });
    assert.equal(view.statusCode, 200);
    assert.deepEqual(view.json(), { ok: true, data: { custody_available: false, settings: [] } });
    for (const operation of ["settings", "checkout", "close", "refunds/status", "reconcile"])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/v2/payment-channels/${operation}`,
            headers: { ...browser, authorization: `Bearer ${admin}` },
            payload: {},
          })
        ).statusCode,
        403,
      );
  } finally {
    await app.close();
  }
});
