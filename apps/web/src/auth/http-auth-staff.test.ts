import assert from "node:assert/strict";
import test from "node:test";

import { createHttpAuthClient, type HttpAuthCredentialStore } from "./HttpAuthClient.js";

const STAFF_ID = "11111111-1111-4111-8111-111111111103";
const SETUP_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function accessSession(token = "initial.token.sig") {
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: {
      session_id: "22222222-2222-4222-8222-222222222222",
      session_version: 1,
      org_id: "33333333-3333-4333-8333-333333333333",
      store_id: "44444444-4444-4444-8444-444444444444",
      staff_id: STAFF_ID,
      device_id: "55555555-5555-4555-8555-555555555555",
      permission_version: 1,
    },
    role: "admin",
    features: { member_enabled: true },
    display: {
      store_name: "测试门店",
      staff_name: "店长",
      org_code: "local",
      store_code: "main",
    },
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function directoryResponse(): Response {
  return jsonResponse({
    ok: true,
    data: [{ staff_id: STAFF_ID, display_name: "店长", role: "admin" }],
  });
}

function loginValues() {
  return { org_code: "local", store_code: "main", username: "admin", password: "password" };
}

function harness(fetchImpl: typeof fetch) {
  let accessToken: string | null = null;
  const store: HttpAuthCredentialStore = Object.freeze({
    getAccessToken: () => accessToken,
    replaceAccessToken: (next) => {
      accessToken = next;
    },
    readCsrf: () => "csrf-proof",
  });
  return {
    client: createHttpAuthClient({
      apiBaseUrl: "http://127.0.0.1:8787",
      fetchImpl,
      credentialStore: store,
    }),
    token: () => accessToken,
  };
}

for (const refreshFailure of [
  Object.freeze({
    name: "401",
    response: jsonResponse({ ok: false, error: { code: "AUTHENTICATION_FAILED" } }, 401),
  }),
  Object.freeze({
    name: "malformed 200",
    response: jsonResponse({ ok: true, data: { access_token: "bad" } }),
  }),
]) {
  test(`refresh ${refreshFailure.name} clears local authority and attempts server logout`, async () => {
    let logoutCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v2/auth/login"))
        return jsonResponse({ ok: true, data: accessSession() });
      if (url.endsWith("/api/v2/local/staff")) return directoryResponse();
      if (url.endsWith("/api/v2/auth/refresh")) return refreshFailure.response.clone();
      if (url.endsWith("/api/v2/auth/logout")) {
        logoutCalls += 1;
        return jsonResponse({ ok: true, data: { revoked: true } });
      }
      return new Response("not found", { status: 404 });
    };
    const testHarness = harness(fetchImpl);
    assert.equal((await testHarness.client.login(loginValues())).ok, true);

    const result = await testHarness.client.refreshSession();

    assert.equal(result.ok, false);
    assert.equal(testHarness.token(), null);
    assert.deepEqual(testHarness.client.listSwitchableStaff(), []);
    assert.equal(logoutCalls, 1);
  });
}

test("a lost refresh response clears local authority because cookies may have changed", async () => {
  let logoutCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login")) {
      return jsonResponse({ ok: true, data: accessSession() });
    }
    if (url.endsWith("/api/v2/local/staff")) return directoryResponse();
    if (url.endsWith("/api/v2/auth/refresh")) throw new Error("response lost");
    if (url.endsWith("/api/v2/auth/logout")) {
      logoutCalls += 1;
      return jsonResponse({ ok: true, data: { revoked: true } });
    }
    return new Response("not found", { status: 404 });
  };
  const testHarness = harness(fetchImpl);
  assert.equal((await testHarness.client.login(loginValues())).ok, true);

  assert.equal((await testHarness.client.refreshSession()).ok, false);
  assert.equal(testHarness.token(), null);
  assert.deepEqual(testHarness.client.listSwitchableStaff(), []);
  assert.equal(logoutCalls, 1);
});

test("credential completion uses the fixed authenticated route and returns no secret material", async () => {
  const completeRequests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login"))
      return jsonResponse({ ok: true, data: accessSession() });
    if (url.endsWith("/api/v2/local/staff")) return directoryResponse();
    if (url.endsWith("/api/v2/auth/staff/credentials/complete")) {
      completeRequests.push(Object.freeze({ url, ...(init === undefined ? {} : { init }) }));
      return jsonResponse({
        ok: true,
        data: { target_staff_id: STAFF_ID, permission_version: 2, status: "active" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  const testHarness = harness(fetchImpl);
  assert.equal((await testHarness.client.login(loginValues())).ok, true);

  const result = await testHarness.client.completeStaffCredentials({
    credential_setup_ref: SETUP_REF,
    password: "correct-horse-battery",
    pin: "864209",
  });

  assert.equal(result.ok, true);
  const completeRequest = completeRequests[0];
  assert.ok(completeRequest);
  assert.equal(completeRequest.url, "http://127.0.0.1:8787/api/v2/auth/staff/credentials/complete");
  assert.equal(
    new Headers(completeRequest.init?.headers).get("authorization"),
    "Bearer initial.token.sig",
  );
  assert.equal(new Headers(completeRequest.init?.headers).get("x-csrf-token"), "csrf-proof");
  assert.deepEqual(JSON.parse(String(completeRequest.init?.body)), {
    credential_setup_ref: SETUP_REF,
    password: "correct-horse-battery",
    pin: "864209",
  });
  assert.doesNotMatch(JSON.stringify(result), /password|pin|credential_setup_ref|access_token/iu);
});
