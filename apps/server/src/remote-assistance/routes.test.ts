import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool } from "../db/pg-pool.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "../http/types.js";
const browser = {
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
};
test("remote assistance HTTP rejects anonymous, clerk, CSRF, missing consent, arbitrary commands and bad password", async () => {
  const pool = createPgPool({
    connectionString: "postgresql://laundry_app@127.0.0.1:1/unused",
    connectionTimeoutMillis: 100,
  });
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({
    runtime: { ...runtime, pool },
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  const url = "/api/v2/remote-assistance";
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
    const cookies = response.headers["set-cookie"];
    const pairs = (Array.isArray(cookies) ? cookies : [cookies ?? ""]).map(
      (line) => line.split(";", 1)[0]!,
    );
    const csrf = pairs
      .find((pair) => pair.startsWith(`${LOCAL_COOKIE_NAMES.csrf}=`))
      ?.split("=")[1];
    assert.ok(csrf);
    return {
      ...browser,
      authorization: `Bearer ${(response.json() as { data: { access_token: string } }).data.access_token}`,
      cookie: pairs.join("; "),
      "x-csrf-token": csrf,
    };
  };
  try {
    const input = { operation: "authorize", body: { password: "synthetic-bad", consent: true } };
    assert.equal(
      (await app.inject({ method: "POST", url, headers: browser, payload: input })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: "POST", url, headers: await login("staff"), payload: input }))
        .statusCode,
      403,
    );
    const admin = await login("admin");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: admin,
          payload: { operation: "authorize", body: { password: DEMO_PASSWORD, consent: true } },
        })
      ).statusCode,
      409,
    );
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
    for (const payload of [
      { operation: "shell" },
      { operation: "authorize", body: { password: "x" } },
      { ...input, org_id: randomUUID() },
      { operation: "status", url: "https://attacker.example" },
    ])
      assert.equal(
        (await app.inject({ method: "POST", url, headers: admin, payload })).statusCode,
        400,
      );
    assert.equal(
      (await app.inject({ method: "POST", url, headers: admin, payload: input })).statusCode,
      401,
    );
    const replies = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({ method: "POST", url, headers: admin, payload: input }),
      ),
    );
    assert.ok(replies.some((reply) => reply.statusCode === 429));
    assert.doesNotMatch(
      replies.map((reply) => reply.body).join(""),
      /synthetic-bad|password_hash|broker_token/,
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
