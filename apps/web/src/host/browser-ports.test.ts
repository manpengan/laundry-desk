import assert from "node:assert/strict";
import test from "node:test";

import { setDeviceIdForTests } from "../auth/device-id.js";
import { createBrowserPorts } from "./browser-ports.js";

const API_BASE_URL = "http://127.0.0.1:8787";
const DEVICE_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const STORE_ID = "44444444-4444-4444-8444-444444444444";
const STAFF_ID = "11111111-1111-4111-8111-111111111103";

function sessionWire(accessToken: string, version = 1): Readonly<Record<string, unknown>> {
  return Object.freeze({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: Object.freeze({
      session_id: SESSION_ID,
      session_version: version,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      device_id: DEVICE_ID,
      permission_version: 1,
    }),
    role: "admin",
    features: Object.freeze({ member_enabled: true }),
    display: Object.freeze({
      store_name: "本地门店",
      staff_name: "本地管理员",
      org_code: "local",
      store_code: "main",
    }),
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("browser ports keep credentials outside SessionView and attach them internally", async () => {
  setDeviceIdForTests(DEVICE_ID);
  const observedHeaders: Array<Readonly<{ authorization: string | null; csrf: string | null }>> =
    [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return jsonResponse({ ok: true, data: { status: "ready" } });
    }
    if (url.endsWith("/api/v2/auth/login")) {
      return jsonResponse({ ok: true, data: sessionWire("first.token.sig") });
    }
    if (url.endsWith("/api/v2/local/staff")) {
      return jsonResponse({
        ok: true,
        data: [{ staff_id: STAFF_ID, display_name: "本地管理员", role: "admin" }],
      });
    }
    if (url.includes("/v1/commands/") || url.includes("/v1/queries/")) {
      const headers = new Headers(init?.headers);
      observedHeaders.push(
        Object.freeze({
          authorization: headers.get("authorization"),
          csrf: headers.get("x-csrf-token"),
        }),
      );
      return jsonResponse({ ok: true, data: { execution: "executed", result: {} } });
    }
    return new Response("not found", { status: 404 });
  };
  const ports = createBrowserPorts({
    apiBaseUrl: API_BASE_URL,
    fetchImpl,
    readCsrf: () => "csrf-proof",
  });

  const login = await ports.auth.login({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "correct horse battery staple",
  });

  assert.equal(login.ok, true);
  if (!login.ok) return;
  const serialized = JSON.stringify(login.data);
  assert.doesNotMatch(
    serialized,
    /access_token|refresh_token|authorization|cookie|header|first\.token\.sig/iu,
  );
  assert.deepEqual(Object.keys(login.data).sort(), ["display", "features", "role", "session"]);

  await ports.command.execute("order.create", { customer_id: "customer-1" });
  await ports.query.execute("order.list", { limit: 20 });
  assert.deepEqual(observedHeaders, [
    { authorization: "Bearer first.token.sig", csrf: "csrf-proof" },
    { authorization: "Bearer first.token.sig", csrf: "csrf-proof" },
  ]);
  assert.doesNotMatch(JSON.stringify(ports), /first\.token\.sig|csrf-proof/u);
});

test("quick switch rotates the private token without returning or storing either token", async () => {
  setDeviceIdForTests(DEVICE_ID);
  const observedHeaders: Array<Readonly<{ authorization: string | null; csrf: string | null }>> =
    [];
  let csrfProof = "login-csrf";
  const storageWrites: Array<readonly [string, string]> = [];
  const storage: Storage = {
    length: 0,
    clear: () => undefined,
    getItem: () => null,
    key: () => null,
    removeItem: () => undefined,
    setItem: (key, value) => {
      storageWrites.push(Object.freeze([key, value]));
    },
  };
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperties(globalThis, {
    localStorage: { configurable: true, value: storage },
    sessionStorage: { configurable: true, value: storage },
  });

  try {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v2/auth/login")) {
        return jsonResponse({ ok: true, data: sessionWire("login.token.sig") });
      }
      if (url.endsWith("/api/v2/local/staff")) {
        return jsonResponse({
          ok: true,
          data: [{ staff_id: STAFF_ID, display_name: "本地管理员", role: "admin" }],
        });
      }
      if (url.endsWith("/api/v2/auth/pin/challenges/switch-1/verify")) {
        return jsonResponse({ ok: true, data: sessionWire("rotated.token.sig", 2) });
      }
      if (url.includes("/v1/commands/") || url.includes("/v1/queries/")) {
        const headers = new Headers(init?.headers);
        observedHeaders.push(
          Object.freeze({
            authorization: headers.get("authorization"),
            csrf: headers.get("x-csrf-token"),
          }),
        );
        return jsonResponse({ ok: true, data: { execution: "executed" } });
      }
      return new Response("not found", { status: 404 });
    };
    const ports = createBrowserPorts({
      apiBaseUrl: API_BASE_URL,
      fetchImpl,
      readCsrf: () => csrfProof,
    });

    const login = await ports.auth.login({
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: "fixture-password",
    });
    assert.equal(login.ok, true);
    await ports.command.execute("order.list");

    const switched = await ports.auth.verifyPin({
      challenge_id: "switch-1",
      pin: "1234",
    });
    assert.equal(switched.ok, true);
    csrfProof = "rotated-csrf";
    await ports.command.execute("order.list");
    await ports.query.execute("order.list");

    assert.deepEqual(observedHeaders, [
      { authorization: "Bearer login.token.sig", csrf: "login-csrf" },
      { authorization: "Bearer rotated.token.sig", csrf: "rotated-csrf" },
      { authorization: "Bearer rotated.token.sig", csrf: "rotated-csrf" },
    ]);
    assert.deepEqual(storageWrites, []);
    assert.doesNotMatch(
      JSON.stringify([login, switched, ports]),
      /login\.token\.sig|rotated\.token\.sig|access_token|refresh_token/iu,
    );
  } finally {
    if (previousLocal === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", previousLocal);
    if (previousSession === undefined) Reflect.deleteProperty(globalThis, "sessionStorage");
    else Object.defineProperty(globalThis, "sessionStorage", previousSession);
  }
});

test("browser health port accepts only the strict ready envelope", async () => {
  const responses = [
    jsonResponse({ ok: true, data: { status: "starting" } }),
    jsonResponse({ ok: true, data: { status: "ready" } }),
  ];
  const ports = createBrowserPorts({
    apiBaseUrl: API_BASE_URL,
    fetchImpl: async () => responses.shift() ?? new Response("missing", { status: 500 }),
    readCsrf: () => null,
  });

  const malformed = await ports.health.get();
  assert.deepEqual(malformed, {
    ok: false,
    error: { code: "SERVICE_UNAVAILABLE", message: "本地服务响应格式错误" },
  });
  assert.deepEqual(await ports.health.get(), {
    ok: true,
    data: { status: "ready" },
  });
});
