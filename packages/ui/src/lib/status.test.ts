import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStatus } from "./status.js";

describe("status dual encoding", () => {
  it("maps garment statuses to tone+shape", () => {
    const ready = resolveStatus("garment", "ready");
    assert.equal(ready.tone, "ok");
    assert.equal(ready.shape, "circle");
    assert.equal(ready.label, "待取");
  });

  it("maps danger states to square shape (not color-only)", () => {
    const failed = resolveStatus("print", "failed");
    assert.equal(failed.tone, "danger");
    assert.equal(failed.shape, "square");
  });

  it("maps offline sync to warn+triangle", () => {
    const offline = resolveStatus("sync", "offline");
    assert.equal(offline.tone, "warn");
    assert.equal(offline.shape, "triangle");
  });

  it("falls back for unknown status without throw", () => {
    const u = resolveStatus("order", "weird");
    assert.equal(u.tone, "neutral");
    assert.equal(u.label, "weird");
  });
});

describe("order status coverage", () => {
  it("labels every OrderStatusSchema value", () => {
    // A missing entry falls back to the raw status, which would leak English
    // into the UI. draft and cancelled were both missing at one point.
    for (const [status, label] of [
      ["draft", "挂单"],
      ["open", "进行中"],
      ["closed", "已结"],
      ["cancelled", "已撤销"],
    ] as const) {
      assert.equal(resolveStatus("order", status).label, label);
    }
  });
});
