import assert from "node:assert/strict";
import test from "node:test";
import { DesktopPaymentChannelResultSchema } from "@laundry/contracts";
import { createDesktopPaymentChannelOperation } from "./payment-channel-operation.js";
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
const settings = JSON.stringify({ ok: true, data: { custody_available: true, settings: [] } });
test("payment desktop refuses success envelopes on HTTP failures and session replacement", async () => {
  let current: AuthState | null = auth,
    statusCode = 200,
    calls = 0;
  const operation = createDesktopPaymentChannelOperation(
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
    DesktopPaymentChannelResultSchema.parse(await operation.execute({ operation: "settings.get" }))
      .ok,
    true,
  );
  for (const status of [301, 401, 403, 500]) {
    statusCode = status;
    assert.equal(
      DesktopPaymentChannelResultSchema.parse(
        await operation.execute({ operation: "settings.get" }),
      ).ok,
      false,
    );
  }
  current = null;
  assert.equal(
    DesktopPaymentChannelResultSchema.parse(await operation.execute({ operation: "settings.get" }))
      .ok,
    false,
  );
  assert.equal(calls, 5);
  const switched = createDesktopPaymentChannelOperation(
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
    DesktopPaymentChannelResultSchema.parse(await switched.execute({ operation: "settings.get" }))
      .ok,
    false,
  );
});
test("desktop channel rejects a paid receipt for a different requested intent", async () => {
  const other = "22222222-2222-4222-8222-222222222222";
  const receipt = {
    intent_id: other,
    order_id: id,
    purpose: "order",
    channel: "wechat",
    amount_cents: 100,
    state: "paid",
    qr_url: null,
    payment_id: id,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    error_code: null,
  };
  const operation = createDesktopPaymentChannelOperation(
    {
      request: async () => ({
        statusCode: 200,
        bodyText: JSON.stringify({ ok: true, data: receipt }),
      }),
    },
    () => auth,
    async () => {},
  );
  assert.equal(
    DesktopPaymentChannelResultSchema.parse(
      await operation.execute({ operation: "status", body: { intent_id: id } }),
    ).ok,
    false,
  );
});
