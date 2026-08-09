import assert from "node:assert/strict";
import test from "node:test";

import { AccessSessionResponseSchema, CSRF_HEADER_NAME } from "@laundry/contracts";

import { createTestPasswordPort } from "../identity/password.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
import { createLocalApp } from "../http/create-app.js";
import { LOCAL_COOKIE_NAMES } from "../http/types.js";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SETUP_REF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const localCookies = resolveCookiePolicy({ secure: false });
const mutationHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

function parseSetCookie(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(
    lines.flatMap((line) => {
      const pair = line.split(";")[0];
      if (pair === undefined) return [];
      const separator = pair.indexOf("=");
      return separator < 1 ? [] : [[pair.slice(0, separator), pair.slice(separator + 1)]];
    }),
  );
}

test("credential completion enforces CSRF and consumes one creator-bound setup", async () => {
  const base = await createMemoryLocalRuntime();
  const testPasswords = createTestPasswordPort();
  const runtime = Object.freeze({
    ...base,
    identity: Object.freeze({
      ...base.identity,
      login: Object.freeze({
        ...base.identity.login,
        passwordPort: Object.freeze({
          hashPassword: testPasswords.hashPassword,
          verifyPassword: base.identity.login.passwordPort.verifyPassword,
        }),
      }),
    }),
  });
  const created = await runtime.staffAccess.credentials.create(
    LOCAL_PROFILE.adminStaffId,
    {
      username: "cashier-route",
      display_name: "路由店员",
      role: "staff",
      privacy_admin: false,
      reason: "入职",
    },
    {
      setupRef: SETUP_REF,
      targetStaffId: TARGET_ID,
      roleRowId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      createdAt: 1_000,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  );
  assert.equal(created.ok, true);
  const app = await createLocalApp({ runtime, cookiePolicy: localCookies, logger: false });
  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: mutationHeaders,
    payload: {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE_ID,
    },
  });
  assert.equal(login.statusCode, 200, login.body);
  const access = AccessSessionResponseSchema.parse((login.json() as { data: unknown }).data);
  const cookies = parseSetCookie(login.headers as Record<string, unknown>);
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const payload = {
    credential_setup_ref: SETUP_REF,
    password: "correct horse battery staple",
    pin: "123456",
  };

  const noCsrf = await app.inject({
    method: "POST",
    url: "/api/v2/auth/staff/credentials/complete",
    headers: {
      ...mutationHeaders,
      authorization: `Bearer ${access.access_token}`,
      cookie: cookieHeader,
    },
    payload,
  });
  assert.equal(noCsrf.statusCode, 403, noCsrf.body);

  const headers = {
    ...mutationHeaders,
    authorization: `Bearer ${access.access_token}`,
    cookie: cookieHeader,
    [CSRF_HEADER_NAME]: cookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
  };
  const completed = await app.inject({
    method: "POST",
    url: "/api/v2/auth/staff/credentials/complete",
    headers,
    payload,
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.deepEqual(completed.json(), {
    ok: true,
    data: { target_staff_id: TARGET_ID, permission_version: 2, status: "active" },
  });
  const identity = await runtime.identity.login.staff.findById(LOCAL_PROFILE.orgId, TARGET_ID);
  assert.equal(
    await testPasswords.verifyPassword(
      "correct horse battery staple",
      identity?.password_hash ?? "",
    ),
    true,
  );
  assert.equal(await testPasswords.verifyPassword("123456", identity?.pin_hash ?? ""), true);

  const replay = await app.inject({
    method: "POST",
    url: "/api/v2/auth/staff/credentials/complete",
    headers,
    payload,
  });
  assert.equal(replay.statusCode, 400, replay.body);
  assert.equal((replay.json() as { error: { code: string } }).error.code, "RESOURCE_UNAVAILABLE");

  const oversized = await app.inject({
    method: "POST",
    url: "/api/v2/auth/staff/credentials/complete",
    headers,
    payload: { ...payload, password: "x".repeat(5_000) },
  });
  assert.equal(oversized.statusCode, 413, oversized.body);
  await app.close();
});
