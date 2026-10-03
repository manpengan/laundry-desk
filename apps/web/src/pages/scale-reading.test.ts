import assert from "node:assert/strict";
import test from "node:test";
import type { ScaleReading } from "@laundry/contracts";
import { appendScaleReading } from "./scale-reading.js";
const reading: ScaleReading = {
  grams: 1250,
  basis: "net",
  port: "COM7",
  captured_at: 1000,
  protocol: "and-standard-ascii-v1",
};
test("confirmed weighing appends bounded order note without replacing operator text", () => {
  assert.equal(
    appendScaleReading("原有注意事项", reading, 2000),
    "原有注意事项\n称重记录：净重 1250 克（COM7，1970-01-01T00:00:01.000Z）",
  );
  assert.equal(appendScaleReading("", reading, 31001), null);
  assert.equal(appendScaleReading("", reading, 999), null);
  assert.equal(appendScaleReading("长".repeat(500), reading, 2000), null);
});
