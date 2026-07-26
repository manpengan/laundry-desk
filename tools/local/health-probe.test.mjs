import assert from "node:assert/strict";
import test from "node:test";

import { probeHealthEndpoint } from "./health-probe.mjs";

test("health is down only when the endpoint cannot be reached", async () => {
  const disconnected = await probeHealthEndpoint("http://127.0.0.1:8787/health", async () => {
    throw new Error("connection refused");
  });
  assert.deepEqual(disconnected, { reachable: false, ready: false });

  for (const response of [
    new Response("not-json", { status: 200 }),
    new Response('{"ok":false}', { status: 200 }),
    new Response("unavailable", { status: 503 }),
  ]) {
    assert.deepEqual(
      await probeHealthEndpoint("http://127.0.0.1:8787/health", async () => response),
      { reachable: true, ready: false },
    );
  }

  assert.deepEqual(
    await probeHealthEndpoint(
      "http://127.0.0.1:8787/health",
      async () =>
        new Response('{"ok":true,"data":{"status":"ready"}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
    { reachable: true, ready: true },
  );
});
