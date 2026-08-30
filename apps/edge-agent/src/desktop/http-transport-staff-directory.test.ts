import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopHttpTransport,
  type DesktopHttpRequest,
  type DesktopHttpResponse,
  type DesktopHttpTransportDependencies,
} from "./http-transport.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const STORE_ID = "00000000-0000-4000-8000-000000000004";
const ADMIN_ID = "00000000-0000-4000-8000-000000000005";
const STAFF_ID = "00000000-0000-4000-8000-000000000006";
const ACCESS_TOKEN = "header.payload.staff-signature";
const CSRF_TOKEN = `v1.${"a".repeat(43)}`;
const LOGIN_INPUT = Object.freeze({
  org_code: "demo-org",
  store_code: "demo-store",
  username: "staff",
  password: "password",
});

function jsonResponse(payload: unknown): DesktopHttpResponse {
  return Object.freeze({ statusCode: 200, bodyText: JSON.stringify(payload) });
}

function accessSession() {
  return Object.freeze({
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: Object.freeze({
      session_id: SESSION_ID,
      session_version: 1,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      device_id: DEVICE_ID,
      permission_version: 1,
    }),
    role: "staff",
    features: Object.freeze({ pin_quick_switch: true }),
    display: Object.freeze({
      store_name: "Demo Store",
      staff_name: "Staff",
      org_code: "demo-org",
      store_code: "demo-store",
    }),
  });
}

function directoryResponse(): DesktopHttpResponse {
  return jsonResponse({
    ok: true,
    data: [
      {
        staff_id: ADMIN_ID,
        display_name: "Admin",
        role: "admin",
        username: "admin-private-login",
      },
      {
        staff_id: STAFF_ID,
        display_name: "Staff",
        role: "staff",
        username: "staff-private-login",
      },
    ],
  });
}

type ResponseStep = DesktopHttpResponse | (() => Promise<DesktopHttpResponse>);

function createHarness(responses: readonly ResponseStep[]) {
  let pending = [...responses];
  let requests: readonly DesktopHttpRequest[] = [];
  const dependencies = Object.freeze({
    request: async (request: DesktopHttpRequest) => {
      requests = Object.freeze([...requests, request]);
      const [next, ...remaining] = pending;
      pending = remaining;
      if (next === undefined) throw new Error("Unexpected HTTP request");
      return typeof next === "function" ? next() : next;
    },
    cookies: Object.freeze({
      get: async () => Object.freeze([{ name: "laundry_csrf", value: CSRF_TOKEN }]),
      clear: async () => undefined,
    }),
    deviceId: DEVICE_ID,
  }) satisfies DesktopHttpTransportDependencies;
  return Object.freeze({
    dependencies,
    get requests(): readonly DesktopHttpRequest[] {
      return requests;
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return Object.freeze({ promise, resolve });
}

test("ordinary staff reads the token-free switch directory through the dedicated GET", async () => {
  const harness = createHarness([
    jsonResponse({ ok: true, data: accessSession() }),
    directoryResponse(),
    directoryResponse(),
  ]);
  const transport = createDesktopHttpTransport(harness.dependencies);

  const login = await transport.auth.login(LOGIN_INPUT);
  const directory = await transport.auth.staffDirectory();

  assert.equal(login.ok, true);
  assert.deepEqual(directory, {
    ok: true,
    data: [
      { staff_id: ADMIN_ID, display_name: "Admin", role: "admin" },
      { staff_id: STAFF_ID, display_name: "Staff", role: "staff" },
    ],
  });
  assert.deepEqual(
    harness.requests.map((request) => [new URL(request.url).pathname, request.method]),
    [
      ["/api/v2/auth/login", "POST"],
      ["/api/v2/local/staff", "GET"],
      ["/api/v2/local/staff", "GET"],
    ],
  );
  assert.equal(harness.requests[2]?.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(harness.requests[2]?.headers["X-CSRF-Token"], undefined);
  assert.doesNotMatch(JSON.stringify(directory), /username|access_token|authorization/iu);
});

test("staff directory lookup fails closed before login without sending a request", async () => {
  const harness = createHarness([]);
  const result = await createDesktopHttpTransport(harness.dependencies).auth.staffDirectory();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "AUTHENTICATION_FAILED");
  assert.deepEqual(harness.requests, []);
});

test("a delayed staff directory response is suppressed after concurrent logout", async () => {
  const started = deferred<void>();
  const delayed = deferred<DesktopHttpResponse>();
  const harness = createHarness([
    jsonResponse({ ok: true, data: accessSession() }),
    directoryResponse(),
    async () => {
      started.resolve();
      return delayed.promise;
    },
    jsonResponse({ ok: true, data: { logged_out: true } }),
  ]);
  const transport = createDesktopHttpTransport(harness.dependencies);
  assert.equal((await transport.auth.login(LOGIN_INPUT)).ok, true);

  const loading = transport.auth.staffDirectory();
  await started.promise;
  assert.equal((await transport.auth.logout()).ok, true);
  delayed.resolve(directoryResponse());
  const result = await loading;

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RESOURCE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), /username|access_token|authorization/iu);
});
