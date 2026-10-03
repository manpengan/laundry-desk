import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthState } from "./http-transport-support.js";
import type { DesktopHttpRequest } from "./request-builder.js";
import { createDesktopAiOperation } from "./ai-operation.js";

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
const config = { ok: true, data: { config: null, custody_available: true } };

test("AI IPC rejects arbitrary URLs and keeps authentication in fixed main-owned requests", async () => {
  const requests: DesktopHttpRequest[] = [];
  const service = createDesktopAiOperation(
    {
      async request(request) {
        requests.push(request);
        return { statusCode: 200, bodyText: JSON.stringify(config) };
      },
    },
    () => state,
  );
  const bad = await service.execute({ operation: "config", url: "https://attacker.invalid" });
  assert.equal((bad as { ok: boolean }).ok, false);
  assert.equal(requests.length, 0);
  assert.deepEqual(await service.execute({ operation: "config" }), config);
  assert.equal(requests[0]?.url, "http://127.0.0.1:8787/api/v2/ai/runtime-config");
  assert.equal(requests[0]?.headers.Authorization, "Bearer main-only-access");
  assert.equal(JSON.stringify(config).includes(state.accessToken), false);
});
test("logout cancels an owned stream and rejects late response from an old session", async () => {
  let current: AuthState | null = state;
  let request: DesktopHttpRequest | undefined;
  let resolve: (value: { statusCode: number; bodyText: string }) => void = () => undefined;
  const service = createDesktopAiOperation(
    {
      request: async (input) => {
        request = input;
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
    () => current,
  );
  const pending = service.execute({ operation: "stream", session_id: id, after: 0 });
  await Promise.resolve();
  assert.equal(request?.signal?.aborted, false);
  current = null;
  service.cancelAll();
  assert.equal(request?.signal?.aborted, true);
  resolve({ statusCode: 200, bodyText: "" });
  assert.equal(((await pending) as { ok: boolean }).ok, false);
});
test("secret ingress is POST with CSRF and response cannot project secret material", async () => {
  let sent: DesktopHttpRequest | undefined;
  const service = createDesktopAiOperation(
    {
      async request(input) {
        sent = input;
        return {
          statusCode: 200,
          bodyText: JSON.stringify({ ok: true, data: { api_key: "must-not-return" } }),
        };
      },
    },
    () => state,
  );
  const result = await service.execute({
    operation: "secret",
    body: { confirm_ref: id, step_up_proof_id: id, api_key: "synthetic-api-key" },
  });
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.headers["X-CSRF-Token"], state.csrfToken);
  assert.equal((result as { ok: boolean }).ok, false);
  assert.equal(JSON.stringify(result).includes("must-not-return"), false);
});

test("same-session refresh uses fresh credentials while actor changes deny before HTTP", async () => {
  let current = state;
  let requests = 0;
  let header = "";
  const dependencies = {
    async request(input: DesktopHttpRequest) {
      requests++;
      header = input.headers.Authorization ?? "";
      return { statusCode: 200, bodyText: JSON.stringify(config) };
    },
  };
  const refresh = createDesktopAiOperation(
    dependencies,
    () => current,
    async () => {
      current = { ...state, accessToken: "refreshed-access" };
    },
  );
  assert.deepEqual(await refresh.execute({ operation: "config" }), config);
  assert.equal(header, "Bearer refreshed-access");
  const switched = createDesktopAiOperation(
    dependencies,
    () => current,
    async () => {
      current = {
        ...state,
        sessionView: {
          ...state.sessionView,
          session: {
            ...state.sessionView.session,
            session_id: "22222222-2222-4222-8222-222222222222",
          },
        },
      };
    },
  );
  assert.equal(((await switched.execute({ operation: "config" })) as { ok: boolean }).ok, false);
  assert.equal(requests, 1);
});

test("cancellation during credential refresh prevents opening the stream", async () => {
  let release: () => void = () => undefined;
  let requests = 0;
  const service = createDesktopAiOperation(
    {
      async request() {
        requests++;
        return { statusCode: 200, bodyText: "" };
      },
    },
    () => state,
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = service.execute({ operation: "stream", session_id: id, after: 0 });
  await service.execute({ operation: "cancel", session_id: id });
  release();
  assert.equal(((await pending) as { ok: boolean }).ok, false);
  assert.equal(requests, 0);
});
