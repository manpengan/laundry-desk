import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool } from "../db/pg-pool.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "../http/types.js";
import type { SecurityEventInput } from "../http/security-events.js";
const browser = {
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
};
test("export authorization rejects anonymous, clerk, CSRF, scope injection and bad password before database", async () => {
  const pool = createPgPool({
    connectionString: "postgresql://laundry_app@127.0.0.1:1/unused",
    connectionTimeoutMillis: 100,
  });
  const runtime = await createMemoryLocalRuntime();
  const events: SecurityEventInput[] = [];
  const app = await createLocalApp({
    runtime: { ...runtime, pool },
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    securityEventSink: {
      record: (_request, event) => {
        events.push(event);
      },
    },
  });
  const url = "/api/v2/store-export";
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
    const cookie = result.headers["set-cookie"];
    const pairs = (Array.isArray(cookie) ? cookie : [cookie ?? ""]).map(
      (line) => line.split(";", 1)[0]!,
    );
    const csrf = pairs
      .find((pair) => pair.startsWith(`${LOCAL_COOKIE_NAMES.csrf}=`))
      ?.split("=")[1];
    assert.ok(csrf);
    return {
      ...browser,
      authorization: `Bearer ${(result.json() as { data: { access_token: string } }).data.access_token}`,
      cookie: pairs.join("; "),
      "x-csrf-token": csrf,
    };
  };
  try {
    assert.equal((await app.inject({ method: "GET", url, headers: browser })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "GET", url, headers: await login("staff") })).statusCode,
      403,
    );
    const admin = await login("admin");
    const preview = await app.inject({ method: "GET", url, headers: admin });
    assert.equal(preview.statusCode, 200);
    const policy = (preview.json() as { data: { policy_sha256: string } }).data.policy_sha256;
    const input = {
      policy_sha256: policy,
      privacy_acknowledged: true,
      password: "synthetic-bad-password",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...browser, authorization: admin.authorization },
          payload: input,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: admin,
          payload: { ...input, org_id: randomUUID() },
        })
      ).statusCode,
      400,
    );
    for (let index = 0; index < 5; index++) {
      const response = await app.inject({ method: "POST", url, headers: admin, payload: input });
      assert.equal(response.statusCode, 401);
      assert.equal(response.body.includes(input.password), false);
    }
    assert.equal(
      (await app.inject({ method: "POST", url, headers: admin, payload: input })).statusCode,
      429,
    );
    assert.equal(events.filter((event) => event.reason === "LOGIN_FAILED").length, 5);
  } finally {
    await app.close();
    await pool.end();
  }
});
