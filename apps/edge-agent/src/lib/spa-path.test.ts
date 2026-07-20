import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveSpaPath } from "./spa-path.js";

const root = join("/tmp", "spa-root-fixture");

test("resolveSpaPath maps root and nested paths", () => {
  assert.equal(resolveSpaPath(root, "/"), join(root, "index.html"));
  assert.equal(resolveSpaPath(root, ""), join(root, "index.html"));
  assert.equal(resolveSpaPath(root, "/app.js"), join(root, "app.js"));
  assert.equal(resolveSpaPath(root, "css/app.css"), join(root, "css/app.css"));
});

test("resolveSpaPath rejects traversal and null bytes", () => {
  assert.equal(resolveSpaPath(root, "/../secret"), null);
  assert.equal(resolveSpaPath(root, "/../../etc/passwd"), null);
  assert.equal(resolveSpaPath(root, "/foo/../../etc/passwd"), null);
  assert.equal(resolveSpaPath(root, "/ok\0/evil"), null);
});
