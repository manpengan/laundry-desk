import assert from "node:assert/strict";
import test from "node:test";

import { AccessSessionResponseSchema } from "@laundry/contracts";

import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";

const browserHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

async function login(app: Awaited<ReturnType<typeof createLocalApp>>, username: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username,
      password: DEMO_PASSWORD,
      device_id:
        username === "admin"
          ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return AccessSessionResponseSchema.parse((response.json() as { data: unknown }).data);
}

test("owner dashboard HTTP is admin-only, strict, and never cacheable", async (t) => {
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  t.after(async () => app.close());
  const admin = await login(app, "admin");
  const staff = await login(app, "staff");

  const accepted = await app.inject({
    method: "POST",
    url: "/v1/queries/reporting.owner_dashboard.get",
    headers: { ...browserHeaders, authorization: `Bearer ${admin.access_token}` },
    payload: {},
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal((accepted.json() as { ok?: boolean }).ok, true);

  const denied = await app.inject({
    method: "POST",
    url: "/v1/queries/reporting.owner_dashboard.get",
    headers: { ...browserHeaders, authorization: `Bearer ${staff.access_token}` },
    payload: {},
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.headers["cache-control"], "no-store");
  assert.equal((denied.json() as { error?: { code?: string } }).error?.code, "PERMISSION_DENIED");

  const forgedScope = await app.inject({
    method: "POST",
    url: "/v1/queries/reporting.owner_dashboard.get",
    headers: { ...browserHeaders, authorization: `Bearer ${admin.access_token}` },
    payload: { org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
  assert.equal(forgedScope.statusCode, 400, forgedScope.body);
  assert.equal(forgedScope.headers["cache-control"], "no-store");
  assert.equal(
    (forgedScope.json() as { error?: { code?: string } }).error?.code,
    "VALIDATION_FAILED",
  );

  for (const payload of [null, [], "unexpected"] as const) {
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/queries/reporting.owner_dashboard.get",
      headers: {
        ...browserHeaders,
        authorization: `Bearer ${admin.access_token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    assert.equal(
      (malformed.json() as { error?: { code?: string } }).error?.code,
      "VALIDATION_FAILED",
    );
  }
});

test("owner dashboard transaction failures remain server errors without leaking details", async (t) => {
  const baseRuntime = await createMemoryLocalRuntime();
  const sentinel = "private-reporting-failure";
  const runtime = Object.freeze({
    ...baseRuntime,
    reporting: Object.freeze({
      ...baseRuntime.reporting,
      source: Object.freeze({
        readOperations: async () => {
          throw new Error(sentinel);
        },
      }),
    }),
  });
  const app = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  t.after(async () => app.close());
  const admin = await login(app, "admin");

  const response = await app.inject({
    method: "POST",
    url: "/v1/queries/reporting.owner_dashboard.get",
    headers: { ...browserHeaders, authorization: `Bearer ${admin.access_token}` },
    payload: {},
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(
    (response.json() as { error?: { code?: string } }).error?.code,
    "TRANSACTION_FAILED",
  );
  assert.doesNotMatch(response.body, new RegExp(sentinel, "u"));
});
