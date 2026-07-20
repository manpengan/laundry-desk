import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkShellHealth } from "./health.js";

test("checkShellHealth requires spa root and manifest", () => {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-health-"));
  const manifestPath = join(spaRoot, "manifest.json");
  assert.equal(checkShellHealth({ spaRoot, manifestPath }).ok, false);
  writeFileSync(manifestPath, "{}");
  assert.equal(checkShellHealth({ spaRoot, manifestPath }).ok, true);
});
