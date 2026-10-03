import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopMigrationOperation, isMigrationBinaryUpload } from "./migration-operation.js";
import type { AuthState } from "./http-transport-support.js";
import type { DesktopHttpRequest } from "./request-builder.js";
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
test("migration refreshes expired credentials without accepting a changed actor", async () => {
  let current: AuthState | null = state;
  let calls = 0;
  const operation = createDesktopMigrationOperation(
    {
      request: async (request) => {
        calls++;
        assert.equal(request.headers.Authorization, "Bearer renewed-access");
        return {
          statusCode: 200,
          bodyText: JSON.stringify({ ok: true, data: { uploaded: true } }),
        };
      },
    },
    () => current,
    async () => {
      current = { ...state, accessToken: "renewed-access" };
    },
  );
  assert.equal(
    (
      (await operation.execute({
        operation: "photo",
        draft_id: id,
        photo_id: id,
        bytes: new Uint8Array([1]),
      })) as { ok: boolean }
    ).ok,
    true,
  );
  assert.equal(calls, 1);
  const changed = createDesktopMigrationOperation(
    {
      request: async () => {
        calls++;
        throw new Error("must not dispatch");
      },
    },
    () => current,
    async () => {
      current = null;
    },
  );
  assert.equal(
    ((await changed.execute({ operation: "review", draft_id: id })) as { ok: boolean }).ok,
    false,
  );
  assert.equal(calls, 1);
});
test("migration IPC keeps credentials and routes in main and rejects unrecognized or oversized inputs", async () => {
  const requests: DesktopHttpRequest[] = [];
  const operation = createDesktopMigrationOperation(
    {
      request: async (request) => {
        requests.push(request);
        return {
          statusCode: 200,
          bodyText: JSON.stringify({ ok: true, data: { uploaded: true } }),
        };
      },
    },
    () => state,
  );
  assert.equal(
    (
      (await operation.execute({
        operation: "draft",
        bytes: new Uint8Array([1]),
        path: "/arbitrary",
      })) as { ok: boolean }
    ).ok,
    false,
  );
  assert.equal(
    (
      (await operation.execute({
        operation: "photo",
        draft_id: id,
        photo_id: id,
        bytes: new Uint8Array(8 * 1024 * 1024 + 1),
      })) as { ok: boolean }
    ).ok,
    false,
  );
  assert.equal(requests.length, 0);
  assert.deepEqual(
    await operation.execute({
      operation: "photo",
      draft_id: id,
      photo_id: id,
      bytes: new Uint8Array([1, 2]),
    }),
    { ok: true, data: { uploaded: true } },
  );
  const request = requests[0]!;
  assert.equal(request.url, `http://127.0.0.1:8787/api/v2/migrations/v1/drafts/${id}/photos/${id}`);
  assert.equal(request.headers.Authorization, "Bearer main-only-access");
  assert.equal(request.headers["X-CSRF-Token"], "main-only-csrf");
  assert.equal(isMigrationBinaryUpload(new URL(request.url), request), true);
  assert.equal(isMigrationBinaryUpload(new URL(`${request.url}?path=outside`), request), false);
  assert.equal(
    isMigrationBinaryUpload(new URL("http://127.0.0.1:8787/api/v2/commands"), request),
    false,
  );
});
test("migration IPC drops late responses from a logged-out session", async () => {
  let current: AuthState | null = state;
  let complete: (value: { statusCode: number; bodyText: string }) => void = () => undefined;
  const operation = createDesktopMigrationOperation(
    {
      request: async () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
    () => current,
  );
  const pending = operation.execute({ operation: "review", draft_id: id });
  await Promise.resolve();
  current = null;
  complete({ statusCode: 200, bodyText: JSON.stringify({ ok: true, data: { uploaded: true } }) });
  assert.equal(((await pending) as { ok: boolean }).ok, false);
  assert.equal(
    ((await operation.execute({ operation: "review", draft_id: id })) as { ok: boolean }).ok,
    false,
  );
});
