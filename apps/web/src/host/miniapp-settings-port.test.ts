import assert from "node:assert/strict";
import test from "node:test";
import {
  createHttpMiniappSettingsOperation,
  createMiniappSettingsPort,
} from "./miniapp-settings-port.js";

const view = {
  custody_available: true,
  version: 0,
  enabled: false,
  transactions_enabled: false,
  delegated_staff_id: null,
  app_id: null,
  credential_present: false,
  eligible_staff: [],
  subscription_template_ids: [],
};
test("miniapp settings reject failure status, stale sessions and credential reflection", async () => {
  let token = "first",
    status = 200,
    switchSession = false;
  const operation = createHttpMiniappSettingsOperation({
    apiBaseUrl: "https://store.example/",
    getAccessToken: () => token,
    readCsrf: () => "csrf",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://store.example/api/v2/miniapp/settings");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      if (switchSession) token = "second";
      return new Response(JSON.stringify({ ok: true, data: view }), { status });
    },
  });
  const port = createMiniappSettingsPort(operation);
  assert.deepEqual(await port.read(), { ok: true, data: view });
  for (status of [401, 403, 500]) assert.equal((await port.read()).ok, false);
  status = 200;
  switchSession = true;
  assert.equal((await port.read()).ok, false);
  const failed = await createMiniappSettingsPort(async () => {
    throw new Error("synthetic-secret");
  }).read();
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-secret/u);
});
test("miniapp settings schema and missing CSRF block before sending", async () => {
  let calls = 0;
  const operation = createHttpMiniappSettingsOperation({
    apiBaseUrl: "https://store.example",
    getAccessToken: () => "access",
    readCsrf: () => null,
    fetchImpl: async () => {
      calls++;
      return new Response("{}");
    },
  });
  await assert.rejects(operation({ operation: "read", path: "https://other.example" } as never));
  assert.equal(
    await operation({
      operation: "save",
      body: {
        password: "synthetic",
        expected_version: 0,
        enabled: false,
        transactions_enabled: false,
        delegated_staff_id: null,
        app_id: "wx0123456789abcdef",
        subscription_template_ids: [],
      },
    }),
    null,
  );
  assert.equal(calls, 0);
});

test("miniapp settings discard a response when the session changes while reading its body", async () => {
  let token = "first";
  class DelayedResponse extends Response {
    override async text() {
      const body = await super.text();
      token = "second";
      return body;
    }
  }
  const port = createMiniappSettingsPort(
    createHttpMiniappSettingsOperation({
      apiBaseUrl: "https://store.example",
      getAccessToken: () => token,
      readCsrf: () => "csrf",
      fetchImpl: async () => new DelayedResponse(JSON.stringify({ ok: true, data: view })),
    }),
  );
  assert.equal((await port.read()).ok, false);
});
