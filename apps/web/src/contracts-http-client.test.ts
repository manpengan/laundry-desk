import assert from "node:assert/strict";
import test from "node:test";

import { createContractsHttpClient } from "./contracts-http-client.js";

test("contracts HTTP client validates command input before issuing a request", async () => {
  let calls = 0;
  const client = createContractsHttpClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "token",
    readCsrf: () => "csrf",
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}", { status: 500 });
    },
  });

  const result = await client.executeCommand("order.receive", {
    lines: [],
    paid_cents: 0,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
  assert.equal(calls, 0);
});

test("contracts HTTP client rejects unknown operations and malformed envelopes", async () => {
  const client = createContractsHttpClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "token",
    readCsrf: () => "csrf",
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true, data: { arbitrary: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  const unknown = await client.executeQuery("not.in.contract", {});
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "VALIDATION_FAILED");

  const malformed = await client.executeQuery("stats.day.summary", {
    business_date: "2026-07-23",
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "RESOURCE_UNAVAILABLE");
});
