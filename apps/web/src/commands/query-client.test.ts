import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpQueryClient,
  createMockQueryClient,
  DEMO_CATALOG_ITEMS,
} from "./query-client.js";
import { unwrapCommandResult } from "../pages/order-form.js";

test("HTTP query client posts Bearer + CSRF to /v1/queries/:name", async () => {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          execution: "executed",
          result: { items: DEMO_CATALOG_ITEMS.slice(0, 1), total: 1 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const client = createHttpQueryClient({
    apiBaseUrl: "http://127.0.0.1:8787/",
    getAccessToken: () => "tok-query",
    readCsrf: () => "csrf-q",
    fetchImpl,
  });
  const result = await client.execute("catalog.items.list", { query: "", limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/queries\/catalog\.items\.list$/u);
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer tok-query");
  assert.equal(calls[0]!.headers.get("x-csrf-token"), "csrf-q");
  assert.equal(calls[0]!.body, JSON.stringify({ query: "", limit: 50 }));
  if (result.ok) {
    const payload = unwrapCommandResult<{ items: unknown[]; total: number }>(result.data);
    assert.equal(payload?.total, 1);
    assert.equal(payload?.items.length, 1);
  }
});

test("HTTP query client rejects missing token and CSRF without network", async () => {
  let fetches = 0;
  const fetchImpl: typeof fetch = async () => {
    fetches += 1;
    return new Response("{}", { status: 500 });
  };
  const noToken = createHttpQueryClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => null,
    readCsrf: () => "csrf",
    fetchImpl,
  });
  const a = await noToken.execute("catalog.items.list", { limit: 10 });
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.error.code, "AUTHENTICATION_FAILED");

  const noCsrf = createHttpQueryClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "tok",
    readCsrf: () => null,
    fetchImpl,
  });
  const b = await noCsrf.execute("catalog.items.list", { limit: 10 });
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.error.code, "CSRF_REJECTED");
  assert.equal(fetches, 0);
});

test("mock query client returns DEMO catalog with integer cents", async () => {
  const client = createMockQueryClient();
  const result = await client.execute("catalog.items.list", { query: "", limit: 50 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const payload = unwrapCommandResult<{
    items: readonly { unit_price_cents: number; code: string }[];
    total: number;
  }>(result.data);
  assert.ok(payload !== null);
  assert.equal(payload.total, DEMO_CATALOG_ITEMS.length);
  assert.ok(payload.items.length >= 1);
  for (const item of payload.items) {
    assert.ok(Number.isInteger(item.unit_price_cents));
    assert.ok(item.unit_price_cents >= 0);
  }
  assert.ok(payload.items.some((i) => i.code === "wash_shirt"));
});

test("mock query client filters by query and respects limit", async () => {
  const client = createMockQueryClient();
  const result = await client.execute("catalog.items.list", { query: "干洗", limit: 2 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const payload = unwrapCommandResult<{
    items: readonly { name: string; code: string }[];
    total: number;
  }>(result.data);
  assert.ok(payload !== null);
  assert.ok(payload.total >= 1);
  assert.ok(payload.items.length <= 2);
  assert.ok(payload.items.every((i) => i.name.includes("干洗") || i.code.startsWith("dry")));
});
