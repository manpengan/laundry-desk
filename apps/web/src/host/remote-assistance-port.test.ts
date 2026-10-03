import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemoteAssistancePort,
  createHttpRemoteAssistanceOperation,
} from "./remote-assistance-port.js";
const view = {
  configured: false,
  state: "unconfigured",
  session_id: null,
  expires_at: null,
  commands_completed: 0,
  allowed_commands: ["runtime.health", "runtime.version", "maintenance.summary"],
};
test("remote assistance UI port validates every output and uses only the fixed CSRF-bound route", async () => {
  let token = "synthetic-session",
    calls = 0;
  const operation = createHttpRemoteAssistanceOperation({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => token,
    readCsrf: () => "synthetic-csrf",
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "http://127.0.0.1:8787/api/v2/remote-assistance");
      assert.equal(options?.method, "POST");
      assert.equal(options?.redirect, "error");
      assert.deepEqual(JSON.parse(String(options?.body)), { operation: "status" });
      assert.equal(new Headers(options?.headers).get("x-csrf-token"), "synthetic-csrf");
      return new Response(JSON.stringify({ ok: true, data: view }));
    },
  });
  const port = createRemoteAssistancePort(operation);
  assert.deepEqual(await port.status(), { ok: true, data: view });
  assert.equal(calls, 1);
  const hostile = createRemoteAssistancePort(async () => ({
    ok: true,
    data: { ...view, secret: "forbidden" },
  }));
  assert.equal((await hostile.status()).ok, false);
  token = "";
  assert.equal((await port.status()).ok, false);
  assert.equal(calls, 1);
});
test("session replacement discards a late authorization response", async () => {
  let token = "first";
  const operation = createHttpRemoteAssistanceOperation({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => token,
    readCsrf: () => "csrf",
    fetchImpl: async () => {
      token = "replacement";
      return new Response(JSON.stringify({ ok: true, data: view }));
    },
  });
  assert.equal(
    (
      await createRemoteAssistancePort(operation).authorize({
        password: "synthetic",
        consent: true,
      })
    ).ok,
    false,
  );
});
