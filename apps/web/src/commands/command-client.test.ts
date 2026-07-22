import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpCommandClient,
  createMockCommandClient,
  isStepUpRequired,
} from "./command-client.js";

test("isStepUpRequired detects POLICY_STEP_UP_REQUIRED + confirm_ref", () => {
  assert.equal(
    isStepUpRequired({
      ok: false,
      error: {
        code: "POLICY_STEP_UP_REQUIRED",
        detail: { kind: "confirmation", confirm_ref: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      },
    }),
    true,
  );
  assert.equal(
    isStepUpRequired({
      ok: false,
      error: { code: "POLICY_DENIED" },
    }),
    false,
  );
  assert.equal(isStepUpRequired({ ok: true, data: {} }), false);
});

test("HTTP command client posts confirm_ref only on resume hop", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: true, data: { saved: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createHttpCommandClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "tok",
    readCsrf: () => "csrf-token",
    fetchImpl,
  });
  const result = await client.execute(
    "platform.settings.set",
    { entries: [] },
    { confirmRef: "ref-1" },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/commands\/platform\.settings\.set$/u);
  assert.equal(calls[0]!.body, JSON.stringify({ confirm_ref: "ref-1" }));
});

test("mock command client returns injectable step-up gate", async () => {
  const client = createMockCommandClient();
  const result = await client.execute("platform.settings.set", {});
  assert.equal(isStepUpRequired(result), true);
});
