import assert from "node:assert/strict";
import test from "node:test";
import { connectionTone, createMockConnection, formatConnectionStrip } from "./connection.js";

test("formatConnectionStrip shows mode and pending count", () => {
  assert.equal(formatConnectionStrip(createMockConnection()), "在线 · 0 笔待同步");
  assert.equal(
    formatConnectionStrip(createMockConnection({ mode: "offline", pendingSyncCount: 3 })),
    "离线 · 3 笔待同步",
  );
});

test("connectionTone maps modes for top-bar styling", () => {
  assert.equal(connectionTone(createMockConnection()), "ok");
  assert.equal(connectionTone(createMockConnection({ mode: "offline" })), "danger");
  assert.equal(
    connectionTone(createMockConnection({ mode: "online", pendingSyncCount: 2 })),
    "warn",
  );
});
