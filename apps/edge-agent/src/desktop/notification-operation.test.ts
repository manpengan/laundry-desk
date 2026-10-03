import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopNotificationOperation } from "./notification-operation.js";
import type { AuthState } from "./http-transport-support.js";
import type { DesktopHttpRequest } from "./request-builder.js";

const id = "11111111-1111-4111-8111-111111111111";
const initial: AuthState = {
  accessToken: "main-access",
  csrfToken: "main-csrf",
  expiresAtMs: 0,
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
const response = {
  ok: true,
  data: { settings: null, custody_available: true, credential_present: false },
};
test("notification IPC keeps fixed routes/main credentials and refreshes before dispatch", async () => {
  let current: AuthState = initial;
  const calls: DesktopHttpRequest[] = [];
  const operation = createDesktopNotificationOperation(
    {
      request: async (request) => {
        calls.push(request);
        return { statusCode: 200, bodyText: JSON.stringify(response) };
      },
    },
    () => current,
    async () => {
      current = { ...initial, accessToken: "refreshed-main-access" };
    },
  );
  assert.equal(
    ((await operation.execute({ kind: "get", url: "https://attacker.invalid" })) as { ok: boolean })
      .ok,
    false,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await operation.execute({ kind: "get" }), response);
  assert.equal(calls[0]?.url, "http://127.0.0.1:8787/api/v2/notification/provider-settings");
  assert.equal(calls[0]?.headers.Authorization, "Bearer refreshed-main-access");
});
test("notification settings never project response secrets and drop changed actors", async () => {
  const body = {
    kind: "save",
    input: {
      provider: "aliyun_sms",
      expected_version: 0,
      enabled: false,
      sign_name: "测试洗衣",
      template_code: "SMS_123",
      unit_cost_cents: 5,
      max_batch_cost_cents: 250,
      password: "synthetic-password",
      credential: { accessKeyId: "SyntheticId123", accessKeySecret: "SyntheticSecret123" },
    },
  };
  let request: DesktopHttpRequest | undefined;
  const operation = createDesktopNotificationOperation(
    {
      request: async (value) => {
        request = value;
        return {
          statusCode: 200,
          bodyText: JSON.stringify({
            ...response,
            data: { ...response.data, secret: "must-not-return" },
          }),
        };
      },
    },
    () => initial,
  );
  const result = await operation.execute(body);
  assert.equal((result as { ok: boolean }).ok, false);
  assert.doesNotMatch(JSON.stringify(result), /must-not-return/u);
  assert.equal(request?.method, "POST");
  assert.equal(request?.headers["X-CSRF-Token"], initial.csrfToken);
  let current: AuthState | null = initial;
  let requests = 0;
  const changed = createDesktopNotificationOperation(
    {
      request: async () => {
        requests++;
        return { statusCode: 200, bodyText: JSON.stringify(response) };
      },
    },
    () => current,
    async () => {
      current = null;
    },
  );
  assert.equal(((await changed.execute(body)) as { ok: boolean }).ok, false);
  assert.equal(requests, 0);
});
