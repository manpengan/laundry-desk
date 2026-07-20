import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isSpaManifest, loadManifest, sha256Hex, verifySpaIntegrity } from "./integrity.js";

function makeSpa(indexBody: string): { spaRoot: string; hash: string } {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-spa-"));
  const hash = sha256Hex(indexBody);
  writeFileSync(join(spaRoot, "index.html"), indexBody);
  writeFileSync(
    join(spaRoot, "manifest.json"),
    JSON.stringify({ version: "test", indexSha256: hash }),
  );
  return { spaRoot, hash };
}

test("isSpaManifest requires version and indexSha256 strings", () => {
  assert.equal(isSpaManifest({ version: "1", indexSha256: "abc" }), true);
  assert.equal(isSpaManifest({ version: 1, indexSha256: "abc" }), false);
  assert.equal(isSpaManifest(null), false);
});

test("verifySpaIntegrity accepts matching hash", () => {
  const { spaRoot, hash } = makeSpa("<html>ok</html>");
  const manifest = loadManifest(join(spaRoot, "manifest.json"));
  assert.equal(verifySpaIntegrity(spaRoot, manifest), hash);
});

test("verifySpaIntegrity rejects tampered index", () => {
  const { spaRoot } = makeSpa("<html>ok</html>");
  writeFileSync(join(spaRoot, "index.html"), "<html>tampered</html>");
  const manifest = loadManifest(join(spaRoot, "manifest.json"));
  assert.throws(() => verifySpaIntegrity(spaRoot, manifest), /integrity failed/);
});
