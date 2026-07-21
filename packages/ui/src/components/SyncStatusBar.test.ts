import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { formatSyncLabel, SyncStatusBar } from "./SyncStatusBar.js";

test("formatSyncLabel covers modes and pending", () => {
  assert.equal(formatSyncLabel("online", 0), "在线 · 0 笔待同步");
  assert.equal(formatSyncLabel("offline", 2), "离线 · 2 笔待同步");
  assert.equal(formatSyncLabel("degraded", 1), "降级 · 1 笔待同步");
});

test("SyncStatusBar SSR marks mode and pending", () => {
  const html = renderToStaticMarkup(
    createElement(SyncStatusBar, { mode: "offline", pendingSyncCount: 3 }),
  );
  assert.match(html, /data-mode="offline"/);
  assert.match(html, /data-pending="3"/);
  assert.match(html, /离线/);
});
