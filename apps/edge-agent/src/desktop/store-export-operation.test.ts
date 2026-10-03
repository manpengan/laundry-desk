import assert from "node:assert/strict";
import test from "node:test";
import type { AuthState } from "./http-transport-support.js";
import { createDesktopStoreExportOperation } from "./store-export-operation.js";
const id = "11111111-1111-4111-8111-111111111111";
const state: AuthState = {
  accessToken: "main-only-access",
  csrfToken: "main-only-csrf",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
  sessionView: {
    session: {
      session_id: id,
      session_version: 1,
      org_id: id,
      store_id: id,
      staff_id: id,
      device_id: id,
      permission_version: 1,
    },
    role: "admin",
    features: {},
    display: {
      store_name: "Fixture",
      staff_name: "Fixture",
      org_code: "fixture",
      store_code: "fixture",
    },
  },
};

test("store export IPC rejects paths/tenant injection and binds renewed session credentials", async () => {
  let current: AuthState | null = state;
  let calls = 0;
  const operation = createDesktopStoreExportOperation(
    {
      request: async (request) => {
        calls++;
        assert.equal(request.url, "http://127.0.0.1:8787/api/v2/store-export");
        assert.equal(request.headers.Authorization, "Bearer refreshed");
        assert.equal(request.headers["X-CSRF-Token"], state.csrfToken);
        return {
          statusCode: 200,
          bodyText: JSON.stringify({
            ok: true,
            data: { request_id: id, expires_at: Date.now() + 60000 },
          }),
        };
      },
    },
    () => current,
    async () => {
      current = { ...state, accessToken: "refreshed" };
    },
  );
  assert.equal(
    (
      (await operation.execute({ operation: "preview", destination: "C:/arbitrary" })) as {
        ok: boolean;
      }
    ).ok,
    false,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      (await operation.execute({
        operation: "authorize",
        body: { password: "synthetic", policy_sha256: "a".repeat(64), privacy_acknowledged: true },
      })) as { ok: boolean }
    ).ok,
    true,
  );
  assert.equal(calls, 1);
  const expired = createDesktopStoreExportOperation(
    {
      request: async () => {
        throw new Error("must not dispatch");
      },
    },
    () => current,
    async () => {
      current = null;
    },
  );
  assert.equal(((await expired.execute({ operation: "preview" })) as { ok: boolean }).ok, false);
});
