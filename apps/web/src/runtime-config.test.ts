import assert from "node:assert/strict";
import test from "node:test";

import { resolveHostApiBaseUrl } from "./runtime-config.js";

test("production host fails closed when apiBaseUrl is absent", () => {
  assert.throws(
    () => resolveHostApiBaseUrl(undefined, false),
    /VITE_API_BASE_URL/u,
  );
  assert.throws(() => resolveHostApiBaseUrl("   ", false), /VITE_API_BASE_URL/u);
});

test("development host falls back only to the real local API", () => {
  assert.equal(resolveHostApiBaseUrl(undefined, true), "http://127.0.0.1:8787");
});

test("host API URL trims its trailing slash and rejects unsafe schemes", () => {
  assert.equal(
    resolveHostApiBaseUrl(" https://api.example.test/ ", false),
    "https://api.example.test",
  );
  assert.throws(() => resolveHostApiBaseUrl("file:///tmp/api", false), /http/u);
});
