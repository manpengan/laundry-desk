import assert from "node:assert/strict";
import test from "node:test";

import { requirePrivateLanHttpsOrigin } from "./lan-origin.js";

test("accepts only an explicit high-port RFC1918 HTTPS origin", () => {
  assert.equal(
    requirePrivateLanHttpsOrigin("https://192.168.50.12:8443"),
    "https://192.168.50.12:8443",
  );
  assert.equal(requirePrivateLanHttpsOrigin("https://10.0.0.8:1024"), "https://10.0.0.8:1024");
  assert.equal(
    requirePrivateLanHttpsOrigin("https://172.31.255.254:65535"),
    "https://172.31.255.254:65535",
  );
});

test("rejects public, loopback, default-port, and non-canonical targets", () => {
  for (const value of [
    "https://203.0.113.7:8443",
    "https://127.0.0.1:8443",
    "https://192.168.1.8",
    "https://192.168.1.8:443",
    "http://192.168.1.8:8443",
    "https://192.168.1.8:8443/path",
    "https://user@192.168.1.8:8443",
    " https://192.168.1.8:8443",
  ]) {
    assert.throws(() => requirePrivateLanHttpsOrigin(value), /exact private HTTPS origin/u);
  }
});
