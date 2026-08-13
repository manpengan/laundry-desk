import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserPorts } from "./browser-ports.js";

const STAFF_ID = "11111111-1111-4111-8111-111111111111";

function accessSession(accessToken = "private.mobile.token") {
  return Object.freeze({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: Object.freeze({
      session_id: "22222222-2222-4222-8222-222222222222",
      session_version: 1,
      org_id: "33333333-3333-4333-8333-333333333333",
      store_id: "44444444-4444-4444-8444-444444444444",
      staff_id: STAFF_ID,
      device_id: "55555555-5555-4555-8555-555555555555",
      permission_version: 1,
    }),
    role: "staff",
    features: Object.freeze({ delivery_enabled: true }),
    display: Object.freeze({
      store_name: "移动门店",
      staff_name: "配送员工",
      org_code: "ORG",
      store_code: "S1",
    }),
  });
}

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

test("cold browser resume keeps the access token private and reuses it for task queries", async () => {
  const authorizations: Array<Readonly<{ path: string; value: string | null }>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/refresh")) return success(accessSession());
    if (url.endsWith("/api/v2/local/staff")) {
      authorizations.push({
        path: "staff",
        value: new Headers(init?.headers).get("authorization"),
      });
      return success([{ staff_id: STAFF_ID, display_name: "配送员工", role: "staff" }]);
    }
    if (url.endsWith("/v1/queries/delivery.tasks.list")) {
      authorizations.push({
        path: "tasks",
        value: new Headers(init?.headers).get("authorization"),
      });
      return success({ execution: "executed", result: { delivery_tasks: [] } });
    }
    return new Response("not found", { status: 404 });
  };
  const ports = createBrowserPorts({
    apiBaseUrl: "https://laundry.example",
    fetchImpl,
    readCsrf: () => "csrf-cookie",
  });

  const resumed = await ports.resume?.resume();

  assert.equal(resumed?.ok, true);
  assert.doesNotMatch(
    JSON.stringify(resumed),
    /private\.mobile\.token|access_token|refresh_token|authorization|cookie/iu,
  );
  assert.equal((await ports.query.execute("delivery.tasks.list", {})).ok, true);
  assert.deepEqual(authorizations, [
    { path: "staff", value: "Bearer private.mobile.token" },
    { path: "tasks", value: "Bearer private.mobile.token" },
  ]);
});

test("logout during deferred cold resume prevents old credentials from being restored", async () => {
  const refreshResponse = deferred<Response>();
  const refreshStarted = deferred<void>();
  let taskQueries = 0;
  let logoutRequests = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/refresh")) {
      refreshStarted.resolve();
      return refreshResponse.promise;
    }
    if (url.endsWith("/api/v2/local/staff")) {
      return success([{ staff_id: STAFF_ID, display_name: "旧员工", role: "staff" }]);
    }
    if (url.endsWith("/api/v2/auth/logout")) {
      logoutRequests += 1;
      return success({ logged_out: true });
    }
    if (url.endsWith("/v1/queries/delivery.tasks.list")) {
      taskQueries += 1;
      return success({ execution: "executed", result: { delivery_tasks: [] } });
    }
    return new Response("not found", { status: 404 });
  };
  const ports = createBrowserPorts({
    apiBaseUrl: "https://laundry.example",
    fetchImpl,
    readCsrf: () => "csrf-cookie",
  });

  const staleResume = ports.resume!.resume();
  await refreshStarted.promise;
  const logout = ports.auth.logout();
  refreshResponse.resolve(success(accessSession("stale.mobile.token")));

  assert.deepEqual(await staleResume, { ok: false });
  await logout;
  const query = await ports.query.execute("delivery.tasks.list", {});
  assert.equal(query.ok, false);
  if (!query.ok) assert.equal(query.error.code, "AUTHENTICATION_FAILED");
  assert.equal(taskQueries, 0);
  assert.ok(logoutRequests >= 1);
});
