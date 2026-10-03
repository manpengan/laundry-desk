import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";

test("notification settings require administrator session and CSRF before secret input", async () => {
  const base = await createMemoryLocalRuntime();
  const runtime = {
    ...base,
    notification: {
      ...base.notification,
      externalSettings: {
        tenant: { orgId: LOCAL_PROFILE.orgId, storeId: LOCAL_PROFILE.storeId },
        reload: async () => undefined,
        kms: {
          wrapDataKey: async () => {
            throw new Error("must not wrap");
          },
          unwrapDataKey: async () => {
            throw new Error("must not unwrap");
          },
        },
      },
    },
  };
  const app = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  const host = { host: "127.0.0.1:8787" };
  const browser = { ...host, origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" };
  const path = "/api/v2/notification/provider-settings";
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
    const read = await app.inject({
      method: "GET",
      url: path,
      headers: { ...host, authorization: `Bearer ${admin}` },
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), {
      ok: true,
      data: { settings: null, credential_present: false, custody_available: false },
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          payload: {},
          headers: { ...browser, authorization: `Bearer ${admin}` },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
