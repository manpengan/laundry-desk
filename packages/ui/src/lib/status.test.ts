import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStatus } from "./status.js";

describe("status dual encoding", () => {
  it("maps garment statuses to tone+shape", () => {
    const racked = resolveStatus("garment", "racked");
    assert.equal(racked.tone, "ok");
    assert.equal(racked.shape, "circle");
    assert.equal(racked.label, "待取");
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

describe("garment status coverage", () => {
  it("labels every FulfillmentGarmentStatusSchema value in Chinese", () => {
    // 取衣 once showed a raw "racked" badge because the catalog had drifted.
    for (const [status, label] of [
      ["received", "已收"],
      ["washing", "加工中"],
      ["ready", "已完成"],
      ["racked", "待取"],
      ["picked_up", "已取"],
      ["delivered", "已送达"],
      ["reworked", "返工"],
      ["lost", "丢损"],
    ] as const) {
      assert.equal(resolveStatus("garment", status).label, label);
    }
  });
});
