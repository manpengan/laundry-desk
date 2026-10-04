import assert from "node:assert/strict";
import test from "node:test";
import { createPinnedProviderHttp, requireSuccessfulResponse } from "./provider-http.js";
import { ProviderAdapterError } from "./provider-types.js";

const request = (body = "{}") => ({
  url: "https://api.deepseek.com/chat/completions",
  method: "POST" as const,
  headers: {},
  body,
  signal: new AbortController().signal,
  timeoutMs: 1_000,
});

async function failure(promise: Promise<unknown>): Promise<ProviderAdapterError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProviderAdapterError);
    return error;
  }
  assert.fail("expected a provider failure");
}

test("an offline lookup or an oversize request never reaches the provider, so nothing is owed", async () => {
  const offline = createPinnedProviderHttp(["api.deepseek.com"], async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  });
  const dns = await failure(offline.request(request()));
  assert.deepEqual([dns.code, dns.unbilled], ["NETWORK_POLICY_DENIED", true]);
  const large = await failure(offline.request(request("x".repeat(262_145))));
  assert.deepEqual([large.code, large.unbilled], ["PROVIDER_RESPONSE_TOO_LARGE", true]);
});

test("every HTTP error status is an unbilled provider refusal", () => {
  for (const [status, code] of [
    [400, "PROVIDER_RESPONSE_INVALID"],
    [401, "PROVIDER_AUTH_REJECTED"],
    [403, "PROVIDER_AUTH_REJECTED"],
    [429, "PROVIDER_RATE_LIMITED"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const) {
    assert.throws(
      () => requireSuccessfulResponse(status),
      (error) => error instanceof ProviderAdapterError && error.code === code && error.unbilled,
    );
  }
  assert.doesNotThrow(() => requireSuccessfulResponse(200));
  // Errors raised after a 2xx answer may follow billed generation and default to billed.
  assert.equal(new ProviderAdapterError("PROVIDER_TIMEOUT").unbilled, false);
});
