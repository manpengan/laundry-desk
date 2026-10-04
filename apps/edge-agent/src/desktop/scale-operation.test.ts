import assert from "node:assert/strict";
import test from "node:test";
import type { AuthState } from "./http-transport-support.js";
import { createDesktopScaleOperation } from "./scale-operation.js";
import { DesktopScaleResultSchema } from "@laundry/contracts";
const id = "11111111-1111-4111-8111-111111111111";
const auth: AuthState = {
  accessToken: "synthetic",
  csrfToken: "synthetic",
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
    role: "staff",
    features: {},
    display: {
      store_name: "Synthetic",
      staff_name: "Synthetic",
      org_code: "test",
      store_code: "test",
    },
  },
};
const input = { operation: "read", port: "COM7", baud: 2400, framing: "7E1" };
test("scale boundary requires current session and exact finite serial input", async () => {
  let current: AuthState | null = auth;
  let calls = 0;
  let now = 1000;
  const operation = createDesktopScaleOperation(
    () => current,
    async () => {
      calls += 1;
      return { capture: "ST,NT,+0001.250kg\r\n" };
    },
    () => now,
  );
  for (const invalid of [
    { ...input, port: "\\\\.\\C:" },
    { ...input, port: "COM257" },
    { ...input, baud: 115200 },
    { ...input, script: "secret" },
    { ...input, framing: "8N2" },
  ]) {
    assert.equal(DesktopScaleResultSchema.parse(await operation.execute(invalid)).ok, false);
  }
  assert.equal(calls, 0);
  const result = DesktopScaleResultSchema.parse(await operation.execute(input));
  assert.deepEqual(result, {
    ok: true,
    data: {
      grams: 1250,
      basis: "net",
      port: "COM7",
      captured_at: 1000,
      protocol: "and-standard-ascii-v1",
    },
  });
  assert.equal(DesktopScaleResultSchema.parse(await operation.execute(input)).ok, false);
  assert.equal(calls, 1);
  now += 1100;
  current = null;
  assert.equal(DesktopScaleResultSchema.parse(await operation.execute(input)).ok, false);
  assert.equal(calls, 1);
});
test("logout during a read discards its result and malformed device data never escapes", async () => {
  let current: AuthState | null = auth;
  const operation = createDesktopScaleOperation(
    () => current,
    async () => {
      current = null;
      return { capture: "ST,+1kg\r\n" };
    },
    () => 1000,
  );
  assert.equal(DesktopScaleResultSchema.parse(await operation.execute(input)).ok, false);
  const corrupt = createDesktopScaleOperation(
    () => auth,
    async () => ({ capture: "secret\r\n" }),
    () => 1000,
  );
  const result = await corrupt.execute(input);
  assert.equal(DesktopScaleResultSchema.parse(result).ok, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
