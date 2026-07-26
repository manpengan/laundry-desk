import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  activeBundleRootFromSpaRoot,
  bundleIdForManifest,
  isNormalizedSpaPath,
  isSpaManifest,
  loadCanonicalManifest,
  loadManifest,
  serializeCanonicalManifest,
  sha256Hex,
  verifySpaIntegrity,
  type SpaManifest,
} from "./integrity.js";

type FixtureFile = Readonly<{ body: string; mime: string }>;

const BASE_FILES: Readonly<Record<string, FixtureFile>> = {
  "index.html": { body: "<html>ok</html>", mime: "text/html; charset=utf-8" },
  "assets/app.js": { body: "console.log('ok')", mime: "text/javascript; charset=utf-8" },
};

function manifestFor(files: Readonly<Record<string, FixtureFile>>): SpaManifest {
  const entries = Object.fromEntries(
    Object.entries(files).map(([path, file]) => [
      path,
      {
        sha256: sha256Hex(file.body),
        mime: file.mime,
        bytes: Buffer.byteLength(file.body),
      },
    ]),
  );
  return { version: 1, entries };
}

function writeFixtureFiles(
  spaRoot: string,
  files: Readonly<Record<string, FixtureFile>> = BASE_FILES,
): void {
  for (const [relativePath, file] of Object.entries(files)) {
    const filePath = join(spaRoot, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.body);
  }
}

function makeSpa(
  files: Readonly<Record<string, FixtureFile>> = BASE_FILES,
): Readonly<{ spaRoot: string; manifest: SpaManifest }> {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-spa-"));
  writeFixtureFiles(spaRoot, files);
  const manifest = manifestFor(files);
  writeFileSync(join(spaRoot, "manifest.json"), JSON.stringify(manifest));
  return { spaRoot, manifest };
}

test("canonical manifest text and bundle id ignore input entry order", () => {
  const manifest = manifestFor(BASE_FILES);
  const reversedManifest: SpaManifest = {
    version: 1,
    entries: {
      "index.html": {
        bytes: manifest.entries["index.html"]?.bytes ?? -1,
        mime: manifest.entries["index.html"]?.mime ?? "",
        sha256: manifest.entries["index.html"]?.sha256 ?? "",
      },
      "assets/app.js": {
        bytes: manifest.entries["assets/app.js"]?.bytes ?? -1,
        mime: manifest.entries["assets/app.js"]?.mime ?? "",
        sha256: manifest.entries["assets/app.js"]?.sha256 ?? "",
      },
    },
  };
  const expectedManifest: SpaManifest = {
    version: 1,
    entries: {
      "assets/app.js": manifest.entries["assets/app.js"] as SpaManifest["entries"][string],
      "index.html": manifest.entries["index.html"] as SpaManifest["entries"][string],
    },
  };

  const canonical = serializeCanonicalManifest(reversedManifest);
  assert.equal(canonical, `${JSON.stringify(expectedManifest, null, 2)}\n`);
  assert.equal(serializeCanonicalManifest(manifest), canonical);

  const bundleId = bundleIdForManifest(manifest);
  assert.equal(bundleId, bundleIdForManifest(reversedManifest));
  assert.match(bundleId, /^[0-9a-f]{64}$/);
  assert.equal(bundleId, sha256Hex(canonical));
});

test("canonical manifest loader hashes the exact canonical bytes into a frozen result", () => {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  const manifest = manifestFor(BASE_FILES);
  const canonical = serializeCanonicalManifest(manifest);
  const manifestPath = join(spaRoot, "manifest.json");
  writeFileSync(manifestPath, canonical);

  const loaded = loadCanonicalManifest(manifestPath);
  assert.deepEqual(loaded.manifest, manifest);
  assert.equal(loaded.bundleId, sha256Hex(Buffer.from(canonical, "utf8")));
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.manifest), true);
  assert.equal(Object.isFrozen(loaded.manifest.entries), true);
});

test("canonical manifest loader rejects byte-valid JSON that is not canonical", () => {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  const manifest = manifestFor(BASE_FILES);
  const nonCanonicalTexts = [
    JSON.stringify(manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
    `${serializeCanonicalManifest(manifest)}\n`,
  ];

  for (const [index, text] of nonCanonicalTexts.entries()) {
    const manifestPath = join(spaRoot, `manifest-${index}.json`);
    writeFileSync(manifestPath, text);
    assert.throws(() => loadCanonicalManifest(manifestPath), /manifest is not canonical/i);
  }
});

test("canonical manifest loader rejects a symlinked manifest", () => {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  const realManifestPath = join(spaRoot, "real-manifest.json");
  writeFileSync(realManifestPath, serializeCanonicalManifest(manifestFor(BASE_FILES)));
  const manifestLink = join(spaRoot, "manifest.json");
  symlinkSync(realManifestPath, manifestLink);

  assert.throws(() => loadCanonicalManifest(manifestLink), /symbolic link/i);
});

test("active bundle root resolves exactly to bundles/<bundleId>", () => {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  const manifest = manifestFor(BASE_FILES);
  const bundleId = bundleIdForManifest(manifest);
  const expectedRoot = join(spaRoot, "bundles", bundleId);
  writeFixtureFiles(expectedRoot);

  const activeRoot = activeBundleRootFromSpaRoot(spaRoot, bundleId);
  assert.equal(activeRoot, expectedRoot);
  assert.deepEqual(verifySpaIntegrity(activeRoot, manifest), manifest);
});

test("active bundle root rejects every non-canonical bundle id", () => {
  const spaRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  for (const bundleId of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "../" + "a".repeat(64),
    `${"a".repeat(63)}/`,
  ]) {
    assert.throws(() => activeBundleRootFromSpaRoot(spaRoot, bundleId), /bundle id/i, bundleId);
  }
});

test("active bundle root fails closed when a managed directory is missing", () => {
  const bundleId = "a".repeat(64);

  const missingSpaParent = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  assert.throws(
    () => activeBundleRootFromSpaRoot(join(missingSpaParent, "missing"), bundleId),
    /missing/i,
  );

  const missingBundlesRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  assert.throws(() => activeBundleRootFromSpaRoot(missingBundlesRoot, bundleId), /missing/i);

  const missingActiveRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  mkdirSync(join(missingActiveRoot, "bundles"));
  assert.throws(() => activeBundleRootFromSpaRoot(missingActiveRoot, bundleId), /missing/i);
});

test("active bundle root rejects symlinks anywhere in its managed directory chain", () => {
  const bundleId = "a".repeat(64);

  const spaLinkParent = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  const realSpaRoot = join(spaLinkParent, "real-spa");
  mkdirSync(join(realSpaRoot, "bundles", bundleId), { recursive: true });
  const spaRootLink = join(spaLinkParent, "spa-link");
  symlinkSync(realSpaRoot, spaRootLink, "dir");
  assert.throws(() => activeBundleRootFromSpaRoot(spaRootLink, bundleId), /symbolic link/i);

  const bundlesLinkSpaRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  const realBundlesRoot = mkdtempSync(join(tmpdir(), "edge-versioned-bundles-"));
  mkdirSync(join(realBundlesRoot, bundleId));
  symlinkSync(realBundlesRoot, join(bundlesLinkSpaRoot, "bundles"), "dir");
  assert.throws(() => activeBundleRootFromSpaRoot(bundlesLinkSpaRoot, bundleId), /symbolic link/i);

  const activeLinkSpaRoot = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  mkdirSync(join(activeLinkSpaRoot, "bundles"));
  const realActiveRoot = mkdtempSync(join(tmpdir(), "edge-versioned-active-"));
  symlinkSync(realActiveRoot, join(activeLinkSpaRoot, "bundles", bundleId), "dir");
  assert.throws(() => activeBundleRootFromSpaRoot(activeLinkSpaRoot, bundleId), /symbolic link/i);
});

test("loadManifest accepts only the exact v1 shape and deep-freezes it", () => {
  const { spaRoot } = makeSpa();
  const manifest = loadManifest(join(spaRoot, "manifest.json"));

  assert.equal(isSpaManifest(manifest), true);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.entries), true);
  assert.equal(Object.isFrozen(manifest.entries["index.html"]), true);
  assert.throws(() => {
    (manifest.entries as Record<string, unknown>)["extra.js"] = {};
  }, TypeError);
});

test("isNormalizedSpaPath rejects leading and standalone dot segments", () => {
  for (const path of [".", "..", "../outside.js", "./index.html", "assets/../index.html"]) {
    assert.equal(isNormalizedSpaPath(path), false, path);
  }
  assert.equal(isNormalizedSpaPath("assets/app.js"), true);
});

test("isSpaManifest rejects extra fields, invalid metadata, and non-normalized keys", () => {
  const valid = manifestFor(BASE_FILES);
  const indexEntry = valid.entries["index.html"];
  assert.ok(indexEntry);

  const invalid: readonly unknown[] = [
    { ...valid, version: 2 },
    { ...valid, note: "not allowed" },
    { version: 1, entries: { "index.html": { ...indexEntry, note: "not allowed" } } },
    { version: 1, entries: { "index.html": { ...indexEntry, sha256: "A".repeat(64) } } },
    { version: 1, entries: { "index.html": { ...indexEntry, bytes: -1 } } },
    { version: 1, entries: { "index.html": { ...indexEntry, bytes: 1.5 } } },
    { version: 1, entries: { "./index.html": indexEntry } },
    { version: 1, entries: { "/index.html": indexEntry } },
    { version: 1, entries: { "assets//app.js": indexEntry } },
    { version: 1, entries: { "assets/../index.html": indexEntry } },
    { version: 1, entries: { "assets\\app.js": indexEntry } },
    { version: 1, entries: { "manifest.json": indexEntry } },
    {
      version: 1,
      entries: {
        "asset.bin": {
          ...indexEntry,
          mime: "application/octet-stream",
        },
      },
    },
  ];

  for (const candidate of invalid) {
    assert.equal(isSpaManifest(candidate), false);
  }
});

test("verifySpaIntegrity accepts a complete matching regular-file tree", () => {
  const { spaRoot, manifest } = makeSpa();

  const verified = verifySpaIntegrity(spaRoot, manifest);
  assert.deepEqual(verified, manifest);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.entries), true);
  assert.equal(Object.isFrozen(verified.entries["index.html"]), true);
});

test("verifySpaIntegrity rejects changed, missing, and extra files", () => {
  const changed = makeSpa();
  writeFileSync(join(changed.spaRoot, "index.html"), "tampered");
  assert.throws(
    () => verifySpaIntegrity(changed.spaRoot, changed.manifest),
    /integrity.*index\.html/i,
  );

  const missing = makeSpa();
  rmSync(join(missing.spaRoot, "assets/app.js"));
  assert.throws(
    () => verifySpaIntegrity(missing.spaRoot, missing.manifest),
    /missing.*assets\/app\.js/i,
  );

  const extra = makeSpa();
  writeFileSync(join(extra.spaRoot, "extra.css"), "body{}");
  assert.throws(() => verifySpaIntegrity(extra.spaRoot, extra.manifest), /extra.*extra\.css/i);
});

test("verifySpaIntegrity rejects file and directory symlinks", () => {
  const fileLink = makeSpa();
  rmSync(join(fileLink.spaRoot, "index.html"));
  symlinkSync(join(fileLink.spaRoot, "assets/app.js"), join(fileLink.spaRoot, "index.html"));
  assert.throws(() => verifySpaIntegrity(fileLink.spaRoot, fileLink.manifest), /symlink/i);

  const directoryLink = makeSpa();
  const external = mkdtempSync(join(tmpdir(), "edge-spa-external-"));
  writeFileSync(
    join(external, "app.js"),
    readFileSync(join(directoryLink.spaRoot, "assets/app.js")),
  );
  rmSync(join(directoryLink.spaRoot, "assets"), { recursive: true });
  symlinkSync(external, join(directoryLink.spaRoot, "assets"), "dir");
  assert.throws(
    () => verifySpaIntegrity(directoryLink.spaRoot, directoryLink.manifest),
    /symlink/i,
  );
});

test("verifySpaIntegrity fails closed for missing and symlinked active roots", () => {
  const manifest = manifestFor(BASE_FILES);
  const missingParent = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  assert.throws(
    () => verifySpaIntegrity(join(missingParent, "missing-active"), manifest),
    /integrity root is missing/i,
  );

  const symlinkParent = mkdtempSync(join(tmpdir(), "edge-versioned-spa-"));
  const realActiveRoot = mkdtempSync(join(tmpdir(), "edge-versioned-active-"));
  writeFixtureFiles(realActiveRoot);
  const activeRootLink = join(symlinkParent, "active-link");
  symlinkSync(realActiveRoot, activeRootLink, "dir");
  assert.throws(() => verifySpaIntegrity(activeRootLink, manifest), /symlink root/i);
});

test("verifySpaIntegrity rejects an unknown-MIME asset even when it is listed", () => {
  const files = {
    ...BASE_FILES,
    "asset.bin": { body: "opaque", mime: "application/octet-stream" },
  };
  const { spaRoot } = makeSpa(files);
  const unchecked = JSON.parse(readFileSync(join(spaRoot, "manifest.json"), "utf8")) as SpaManifest;

  assert.throws(() => verifySpaIntegrity(spaRoot, unchecked), /unknown MIME.*asset\.bin/i);
});
