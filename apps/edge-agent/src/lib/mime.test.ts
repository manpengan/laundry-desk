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

test("mimeFor covers the deterministic Vite asset whitelist", () => {
  const expected = {
    "x.mjs": "text/javascript; charset=utf-8",
    "x.jpg": "image/jpeg",
    "x.jpeg": "image/jpeg",
    "x.gif": "image/gif",
    "x.webp": "image/webp",
    "x.avif": "image/avif",
    "x.ico": "image/x-icon",
    "x.woff": "font/woff",
    "x.ttf": "font/ttf",
  } as const;

  for (const [path, mime] of Object.entries(expected)) {
    assert.equal(mimeFor(path), mime);
  }
});
