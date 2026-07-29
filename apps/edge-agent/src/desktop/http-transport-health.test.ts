import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopHttpTransport,
  DESKTOP_API_BASE_URL,
  DESKTOP_REQUEST_ORIGIN,
  type DesktopHttpRequest,
  type DesktopHttpResponse,
  type DesktopHttpTransportDependencies,
} from "./http-transport.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";

function jsonResponse(payload: unknown): DesktopHttpResponse {
  return Object.freeze({ statusCode: 200, bodyText: JSON.stringify(payload) });
}

test("health uses the fixed loopback route and converts malformed responses to a safe envelope", async () => {
  let requests: readonly DesktopHttpRequest[] = [];
  let responses = [
    jsonResponse({ ok: true, data: { status: "ready" } }),
    jsonResponse({ ok: true, data: { status: "compromised", secret: "detail" } }),
  ];
  const dependencies = Object.freeze({
    async request(request: DesktopHttpRequest) {
      requests = Object.freeze([...requests, request]);
      const [response, ...remaining] = responses;
      responses = remaining;
      if (response === undefined) throw new Error("Unexpected HTTP request");
      return response;
    },
    cookies: Object.freeze({
      async get() {
        return Object.freeze([]);
      },
      async clear() {},
    }),
    deviceId: DEVICE_ID,
  }) satisfies DesktopHttpTransportDependencies;
  const transport = createDesktopHttpTransport(dependencies);

  assert.deepEqual(await transport.health.get(), { ok: true, data: { status: "ready" } });
  const malformed = await transport.health.get();
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "RESOURCE_UNAVAILABLE");
  assert.equal(JSON.stringify(malformed).includes("secret"), false);
  requests.forEach((request) => {
    assert.equal(request.url, `${DESKTOP_API_BASE_URL}/health`);
    assert.equal(request.method, "GET");
    assert.equal(request.credentials, "include");
    assert.equal(request.origin, DESKTOP_REQUEST_ORIGIN);
    assert.equal(request.headers.Authorization, undefined);
  });
});
