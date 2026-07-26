import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Hex, type SpaManifest } from "./lib/integrity.js";
import { createAppProtocolHandler } from "./protocol.js";

const CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'none'";

function makeSpa(): Readonly<{ spaRoot: string; manifest: SpaManifest }> {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-proto-"));
  const index = "<html>hi</html>";
  const script = "console.log('hi')";
  mkdirSync(join(spaRoot, "assets"));
  writeFileSync(join(spaRoot, "index.html"), index);
  writeFileSync(join(spaRoot, "assets/app.js"), script);
  const manifest: SpaManifest = {
    version: 1,
    entries: {
      "index.html": {
        sha256: sha256Hex(index),
        mime: "text/html; charset=utf-8",
        bytes: Buffer.byteLength(index),
      },
      "assets/app.js": {
        sha256: sha256Hex(script),
        mime: "text/javascript; charset=utf-8",
        bytes: Buffer.byteLength(script),
      },
    },
  };
  return { spaRoot, manifest };
}

test("app protocol maps root and serves only verified manifest keys with exact CSP", async () => {
  const { spaRoot, manifest } = makeSpa();
  const handle = createAppProtocolHandler(spaRoot, manifest);
  writeFileSync(join(spaRoot, "unlisted.css"), "body{}");

  const root = handle(new Request("app://local/"));
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(root.headers.get("content-security-policy"), CSP);
  assert.equal(await root.text(), "<html>hi</html>");

  const script = handle(new Request("app://local/assets/app.js"));
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");

  for (const path of ["/manifest.json", "/unlisted.css", "/missing.js", "/orders/42"]) {
    assert.equal(handle(new Request(`app://local${path}`)).status, 404);
  }
});

test("app protocol rejects every authority other than exact app://local", () => {
  const { spaRoot, manifest } = makeSpa();
  const handle = createAppProtocolHandler(spaRoot, manifest);

  for (const url of [
    "app://evil/index.html",
    "http://local/index.html",
    "app://local:8443/index.html",
  ]) {
    assert.equal(handle(new Request(url)).status, 400);
  }
  assert.equal(
    handle({ method: "GET", url: "app://user@local/index.html" } as Request).status,
    400,
  );
});

test("app protocol never emits unsafe CSP directives", () => {
  const { spaRoot, manifest } = makeSpa();
  const handle = createAppProtocolHandler(spaRoot, manifest);
  const response = handle(new Request("app://local/index.html"));
  const csp = response.headers.get("content-security-policy") ?? "";

  assert.equal(csp, CSP);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});
