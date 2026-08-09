import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopHttpTransport,
  DESKTOP_API_BASE_URL,
  DESKTOP_REQUEST_ORIGIN,
  type DesktopHttpRequest,
  type DesktopHttpResponse,
  type DesktopHttpTransportDependencies,
} from "./http-transport.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const STAFF_ID = "00000000-0000-4000-8000-000000000005";
const SETUP_REF = "00000000-0000-4000-8000-000000000008";
const ACCESS_TOKEN = "header.payload.signature";
const CSRF = `v1.${"a".repeat(43)}`;

function response(payload: unknown): DesktopHttpResponse {
  return Object.freeze({ statusCode: 200, bodyText: JSON.stringify(payload) });
}

function accessSession() {
  return {
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: {
      session_id: "00000000-0000-4000-8000-000000000002",
      session_version: 1,
      org_id: "00000000-0000-4000-8000-000000000003",
      store_id: "00000000-0000-4000-8000-000000000004",
      staff_id: STAFF_ID,
      device_id: DEVICE_ID,
      permission_version: 1,
    },
    role: "admin",
    features: { member_enabled: true },
    display: {
      store_name: "Demo Store",
      staff_name: "Admin",
      org_code: "demo-org",
      store_code: "demo-store",
    },
  };
}

function createHarness() {
  const pending: DesktopHttpResponse[] = [
    response({ ok: true, data: accessSession() }),
    response({
      ok: true,
      data: [{ staff_id: STAFF_ID, display_name: "Admin", role: "admin" }],
    }),
    response({
      ok: true,
      data: { target_staff_id: STAFF_ID, permission_version: 2, status: "active" },
    }),
  ];
  const requests: DesktopHttpRequest[] = [];
  const dependencies: DesktopHttpTransportDependencies = Object.freeze({
    deviceId: DEVICE_ID,
    request: async (request) => {
      requests.push(request);
      const next = pending.shift();
      if (next === undefined) throw new Error("unexpected request");
      return next;
    },
    cookies: Object.freeze({
      get: async () => Object.freeze([{ name: "laundry_csrf", value: CSRF }]),
      clear: async () => undefined,
    }),
  });
  return Object.freeze({ dependencies, requests });
}

test("desktop credential completion fixes route and injects main-process auth", async () => {
  const harness = createHarness();
  const transport = createDesktopHttpTransport(harness.dependencies);
  const login = await transport.auth.login({
    org_code: "demo-org",
    store_code: "demo-store",
    username: "admin",
    password: "login-password",
  });
  assert.equal(login.ok, true);
  const input = Object.freeze({
    credential_setup_ref: SETUP_REF,
    password: "correct-horse-battery",
    pin: "864209",
  });

  const result = await transport.auth.credentialComplete(input);

  assert.deepEqual(result, {
    ok: true,
    data: { target_staff_id: STAFF_ID, permission_version: 2, status: "active" },
  });
  assert.doesNotMatch(JSON.stringify(result), /password|pin|credential_setup_ref|access_token/iu);
  const request = harness.requests[2];
  assert.ok(request);
  assert.equal(request.url, `${DESKTOP_API_BASE_URL}/api/v2/auth/staff/credentials/complete`);
  assert.equal(request.method, "POST");
  assert.equal(request.origin, DESKTOP_REQUEST_ORIGIN);
  assert.equal(request.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(request.headers["X-CSRF-Token"], CSRF);
  assert.deepEqual(JSON.parse(String(request.body)), input);
});

test("desktop credential completion rejects extra transport fields before HTTP", async () => {
  const harness = createHarness();
  const transport = createDesktopHttpTransport(harness.dependencies);
  assert.equal(
    (
      await transport.auth.login({
        org_code: "demo-org",
        store_code: "demo-store",
        username: "admin",
        password: "login-password",
      })
    ).ok,
    true,
  );

  const result = await transport.auth.credentialComplete({
    credential_setup_ref: SETUP_REF,
    password: "correct-horse-battery",
    pin: "864209",
    url: "https://attacker.invalid",
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
  assert.equal(harness.requests.length, 2);
});
