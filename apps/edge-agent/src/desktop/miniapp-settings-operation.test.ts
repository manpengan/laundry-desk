import assert from "node:assert/strict";
import test from "node:test";
import { DesktopMiniappSettingsResultSchema } from "@laundry/contracts";
import { createDesktopMiniappSettingsOperation } from "./miniapp-settings-operation.js";
import type { AuthState } from "./http-transport-support.js";
const id = "11111111-1111-4111-8111-111111111111";
const auth: AuthState = {
  accessToken: "synthetic",
  csrfToken: "synthetic",
  expiresAtMs: Date.now() + 60000,
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
      org_code: "TEST",
      store_code: "SYNTHETIC",
    },
  },
};
const settings = JSON.stringify({
  ok: true,
  data: {
    custody_available: true,
    version: 0,
    enabled: false,
    transactions_enabled: false,
    delegated_staff_id: null,
    app_id: null,
    credential_present: false,
    eligible_staff: [],
    subscription_template_ids: [],
  },
});
test("miniapp settings desktop refuses success envelopes on HTTP failures and session replacement", async () => {
  let current: AuthState | null = auth,
    statusCode = 200,
    calls = 0;
  const operation = createDesktopMiniappSettingsOperation(
    {
      request: async () => {
        calls++;
        return { statusCode, bodyText: settings };
      },
    },
    () => current,
    async () => {},
  );
  assert.equal(
    DesktopMiniappSettingsResultSchema.parse(await operation.execute({ operation: "read" })).ok,
    true,
  );
  for (const status of [301, 401, 403, 500]) {
    statusCode = status;
    assert.equal(
      DesktopMiniappSettingsResultSchema.parse(await operation.execute({ operation: "read" })).ok,
      false,
    );
  }
  current = null;
  assert.equal(
    DesktopMiniappSettingsResultSchema.parse(await operation.execute({ operation: "read" })).ok,
    false,
  );
  assert.equal(calls, 5);
  const switched = createDesktopMiniappSettingsOperation(
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
        return { statusCode: 200, bodyText: settings };
      },
    },
    () => current,
    async () => {},
  );
  current = auth;
  assert.equal(
    DesktopMiniappSettingsResultSchema.parse(await switched.execute({ operation: "read" })).ok,
    false,
  );
});
