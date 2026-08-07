import assert from "node:assert/strict";
import test from "node:test";

import { createHttpAuthClient } from "./HttpAuthClient.js";

const ID = Object.freeze({
  session: "22222222-2222-4222-8222-222222222222",
  org: "33333333-3333-4333-8333-333333333333",
  store: "44444444-4444-4444-8444-444444444444",
  staff: "11111111-1111-4111-8111-111111111103",
  device: "55555555-5555-4555-8555-555555555555",
});

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("explicit logout revokes with CSRF and clears local authority even when transport fails", async () => {
  let accessToken: string | null = null;
  const calls: Array<
    Readonly<{ url: string; method: string | null; csrf: string | null; body: unknown }>
  > = [];
  const fetchImpl: typeof fetch = async function (this: unknown, input, init) {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login")) {
      return success({
        access_token: "logout.token.sig",
        token_type: "Bearer",
        expires_in: 900,
        storage: "memory_only",
        session: {
          session_id: ID.session,
          session_version: 1,
          org_id: ID.org,
          store_id: ID.store,
          staff_id: ID.staff,
          device_id: ID.device,
          permission_version: 1,
        },
        role: "admin",
        features: { member_enabled: true },
        display: {
          store_name: "本地门店",
          staff_name: "管理员",
          org_code: "local",
          store_code: "main",
        },
      });
    }
    if (url.endsWith("/api/v2/local/staff")) {
      return success([{ staff_id: ID.staff, display_name: "管理员", role: "admin" }]);
    }
    if (url.endsWith("/api/v2/auth/logout")) {
      assert.equal(this, undefined, "native fetch must be called without an options receiver");
      calls.push(
        Object.freeze({
          url,
          method: init?.method ?? null,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
          body: init?.body,
        }),
      );
      throw new Error("network unavailable");
    }
    return new Response("not found", { status: 404 });
  };
  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
    credentialStore: Object.freeze({
      getAccessToken: () => accessToken,
      replaceAccessToken: (next: string | null) => {
        accessToken = next;
      },
      readCsrf: () => "csrf-proof",
    }),
  });

  assert.equal(
    (
      await client.login({
        org_code: "local",
        store_code: "main",
        username: "admin",
        password: "secret",
      })
    ).ok,
    true,
  );
  assert.equal(accessToken, "logout.token.sig");
  await client.logout();

  assert.equal(accessToken, null);
  assert.deepEqual(client.listSwitchableStaff(), []);
  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:8787/api/v2/auth/logout",
      method: "POST",
      csrf: "csrf-proof",
      body: "{}",
    },
  ]);
});
