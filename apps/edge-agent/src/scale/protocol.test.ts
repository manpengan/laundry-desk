import assert from "node:assert/strict";
import test from "node:test";
import { parseScaleCapture, parseScaleFrame } from "./protocol.js";
test("stable standard frames preserve exact integer grams and gross/net meaning", () => {
  assert.deepEqual(parseScaleFrame("ST,+00012.40 kg\r\n"), { grams: 12400, basis: "weight" });
  assert.deepEqual(parseScaleFrame("ST,GS,+0001.234kg\r\n"), { grams: 1234, basis: "gross" });
  assert.deepEqual(parseScaleFrame("ST,NT,+0000012 g\r\n"), { grams: 12, basis: "net" });
  assert.equal(parseScaleFrame("ST,+0.001kg\r\n")?.grams, 1);
});
test("unstable, overload, tare, negative, unsupported units, subgrams and unbounded frames reject", () => {
  for (const frame of [
    "US,+1kg\r\n",
    "OL,+99999kg\r\n",
    "ST,TR,+001kg\r\n",
    "ST,-1kg\r\n",
    "ST,+0kg\r\n",
    "ST,+1001kg\r\n",
    "ST,+1lb\r\n",
    "ST,+0.1g\r\n",
    "ST,+0.0001kg\r\n",
    "ST,+1kg\n",
    "ST,+1e3kg\r\n",
    " ".repeat(100),
  ]) {
    assert.equal(parseScaleFrame(frame), null, frame);
  }
  assert.equal(parseScaleCapture("ST,+1kg\r\nUS,+2kg\r\n"), null);
  assert.equal(parseScaleCapture("ST,+1kg\r\nST,+2"), null);
  assert.equal(parseScaleCapture("ST,+1kg\r\n".repeat(500)), null);
  assert.deepEqual(parseScaleCapture("partial\r\nST,+1kg\r\n"), { grams: 1000, basis: "weight" });
});
