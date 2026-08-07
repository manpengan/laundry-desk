import assert from "node:assert/strict";
import test from "node:test";

import { resolveBrowserApiBaseUrl } from "./browser-api-base.js";

test("LAN HTTPS uses same-origin while Vite and desktop retain loopback", () => {
  assert.equal(
    resolveBrowserApiBaseUrl(undefined, {
      protocol: "https:",
      origin: "https://192.168.50.12:8443",
    }),
    "https://192.168.50.12:8443",
  );
  assert.equal(
    resolveBrowserApiBaseUrl(undefined, {
      protocol: "http:",
      origin: "http://127.0.0.1:5173",
    }),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    resolveBrowserApiBaseUrl(undefined, { protocol: "app:", origin: "null" }),
    "http://127.0.0.1:8787",
  );
});

test("LAN HTTPS ignores build-time API overrides and always remains same-origin", () => {
  const location = { protocol: "https:", origin: "https://192.168.50.12:8443" };
  assert.equal(resolveBrowserApiBaseUrl("", location), location.origin);
  assert.equal(resolveBrowserApiBaseUrl("https://configured.invalid", location), location.origin);
});

test("local non-HTTPS surfaces may use an explicit build-time API base", () => {
  const location = { protocol: "http:", origin: "http://127.0.0.1:5173" };
  assert.equal(resolveBrowserApiBaseUrl("", location), "");
  assert.equal(
    resolveBrowserApiBaseUrl("http://127.0.0.1:9876", location),
    "http://127.0.0.1:9876",
  );
});
