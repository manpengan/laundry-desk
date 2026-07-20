import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppProtocolHandler } from "./protocol.js";

test("app protocol serves index and rejects missing paths", async () => {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-proto-"));
  writeFileSync(join(spaRoot, "index.html"), "<html>hi</html>");
  const handle = createAppProtocolHandler(spaRoot);

  const ok = handle(new Request("app://local/index.html"));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await ok.text(), "<html>hi</html>");

  const missing = handle(new Request("app://local/nope.js"));
  assert.equal(missing.status, 404);

  const escape = handle(new Request("app://local/../secret"));
  assert.equal(escape.status, 404);
});
