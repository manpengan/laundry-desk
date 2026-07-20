import assert from "node:assert/strict";
import test from "node:test";
import { mimeFor } from "./mime.js";

test("mimeFor maps common SPA extensions", () => {
  assert.equal(mimeFor("x.html"), "text/html; charset=utf-8");
  assert.equal(mimeFor("x.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeFor("x.css"), "text/css; charset=utf-8");
  assert.equal(mimeFor("x.json"), "application/json; charset=utf-8");
  assert.equal(mimeFor("x.bin"), "application/octet-stream");
});
