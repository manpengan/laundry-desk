import assert from "node:assert/strict";
import test from "node:test";
import { RemoteAssistanceStatusSchema } from "@laundry/contracts";
import { createDesktopRemoteAssistanceOperation } from "./remote-assistance-operation.js";
import { RESOURCE_FAILURE, type AuthState } from "./http-transport-support.js";

const id = "11111111-1111-4111-8111-111111111111";
const auth: AuthState = {
  accessToken: "synthetic-access",
  csrfToken: "synthetic-csrf",
  expiresAtMs: 100000,
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
      store_name: "Synthetic",
      staff_name: "Synthetic",
      org_code: "test",
      store_code: "test",
    },
  },
};
const success = {
  ok: true as const,
  data: RemoteAssistanceStatusSchema.parse({
    configured: true,
    state: "idle",
    session_id: null,
    expires_at: null,
    commands_completed: 0,
    allowed_commands: ["runtime.health", "runtime.version", "maintenance.summary"],
  }),
};

test("remote assistance rejects successful envelopes from non-success HTTP responses", async () => {
  for (const statusCode of [200, 299, 301, 401, 403, 429, 500, 503]) {
    const operation = createDesktopRemoteAssistanceOperation(
      { request: async () => ({ statusCode, bodyText: JSON.stringify(success) }) },
      () => auth,
      async () => undefined,
    );
    assert.deepEqual(
      await operation.execute({ operation: "status" }),
      statusCode < 300 ? success : RESOURCE_FAILURE,
    );
  }
});

test("remote assistance discards late account responses and secret-shaped output", async () => {
  let current: AuthState | null = auth;
  const switched = createDesktopRemoteAssistanceOperation(
    {
      request: async () => {
        current = {
          ...auth,
          sessionView: {
            ...auth.sessionView,
            session: {
              ...auth.sessionView.session,
              session_id: "22222222-2222-4222-8222-222222222222",
            },
          },
        };
        return { statusCode: 200, bodyText: JSON.stringify(success) };
      },
    },
    () => current,
    async () => undefined,
  );
  assert.deepEqual(await switched.execute({ operation: "status" }), RESOURCE_FAILURE);
  const secret = createDesktopRemoteAssistanceOperation(
    {
      request: async () => ({
        statusCode: 200,
        bodyText: JSON.stringify({
          ok: true,
          data: { ...success.data, broker_token: "must-not-pass" },
        }),
      }),
    },
    () => auth,
    async () => undefined,
  );
  const result = await secret.execute({ operation: "status" });
  assert.deepEqual(result, RESOURCE_FAILURE);
  assert.doesNotMatch(JSON.stringify(result), /broker_token|must-not-pass/u);
});
