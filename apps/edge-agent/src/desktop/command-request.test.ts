import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopSessionView } from "@laundry/contracts";
import { createDesktopJsonRequester } from "./command-request.js";
import type { DesktopHttpRequest } from "./request-builder.js";

const session: DesktopSessionView = {
  session: {
    session_id: "session-a",
    session_version: 1,
    org_id: "org",
    store_id: "store",
    staff_id: "clerk",
    device_id: "device",
    permission_version: 1,
  },
  role: "admin",
  features: { pin_quick_switch: true },
  display: { store_name: "Demo", staff_name: "Admin", org_code: "demo", store_code: "demo" },
};
const path = "/v1/commands/order.receive";
const options = { body: { initial_payment_cents: 1000 } };
const response = (payload: unknown, statusCode = 200) => ({
  statusCode,
  bodyText: JSON.stringify(payload),
});

test("desktop lost and 5xx responses retain the key; success releases it for the next order", async () => {
  const seen: DesktopHttpRequest[] = [];
  let keys = 0;
  const send = createDesktopJsonRequester(
    async (request) => {
      seen.push(request);
      if (seen.length === 1) throw new Error("response lost");
      if (seen.length === 2)
        return response({ ok: false, error: { code: "TRANSACTION_FAILED" } }, 500);
      return response({ ok: true, data: {} });
    },
    () => session,
    () => `key-${++keys}`,
  );
  for (let i = 0; i < 4; i++) await send("POST", path, options);
  assert.deepEqual(
    seen.map((r) => r.headers["Idempotency-Key"]),
    ["key-1", "key-1", "key-1", "key-2"],
  );
});

test("desktop confirmation and its lost-response retry preserve the first-hop key", async () => {
  const seen: DesktopHttpRequest[] = [];
  let keys = 0;
  const send = createDesktopJsonRequester(
    async (request) => {
      seen.push(request);
      if (seen.length === 1)
        return response(
          {
            ok: false,
            error: { code: "POLICY_CONFIRMATION_REQUIRED", detail: { confirm_ref: "ref-1" } },
          },
          403,
        );
      if (seen.length === 2) throw new Error("confirmation result lost");
      return response({ ok: true, data: {} });
    },
    () => session,
    () => `key-${++keys}`,
  );
  await send("POST", path, options);
  await send("POST", path, { body: { confirm_ref: "ref-1" } });
  await send("POST", path, { body: { confirm_ref: "ref-1" } });
  assert.deepEqual(
    seen.map((r) => r.headers["Idempotency-Key"]),
    ["key-1", "key-1", "key-1"],
  );
});

test("desktop scope preserves keys on token refresh and isolates staff switches", async () => {
  let current = session;
  let keys = 0;
  const seen: DesktopHttpRequest[] = [];
  const send = createDesktopJsonRequester(
    async (request) => {
      seen.push(request);
      throw new Error("offline");
    },
    () => current,
    () => `key-${++keys}`,
  );
  await send("POST", path, { ...options, accessToken: "old-test-token" });
  await send("POST", path, { ...options, accessToken: "new-test-token" });
  current = {
    ...session,
    session: { ...session.session, staff_id: "clerk-b", session_version: 2 },
  };
  await send("POST", path, options);
  await send("GET", "/health/ready");
  assert.deepEqual(
    seen.map((r) => r.headers["Idempotency-Key"]),
    ["key-1", "key-1", "key-2", undefined],
  );
});

test("an explicit new desktop operation never consumes an identical uncertain order's receipt", async () => {
  const seen: DesktopHttpRequest[] = [];
  let keys = 0;
  const send = createDesktopJsonRequester(
    async (request) => {
      seen.push(request);
      throw new Error("lost");
    },
    () => session,
    () => `key-${++keys}`,
  );
  await send("POST", path, { ...options, operationId: "op-a" });
  await send("POST", path, { ...options, operationId: "op-a" });
  await send("POST", path, { ...options, operationId: "op-b" });
  assert.deepEqual(
    seen.map((r) => r.headers["Idempotency-Key"]),
    ["key-1", "key-1", "key-2"],
  );
  assert.equal(seen[0]?.body, JSON.stringify(options.body));
  assert.equal(
    Object.keys(seen[0]?.headers ?? {}).some((key) => /operation/i.test(key)),
    false,
  );
});
