import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectPackagedMacSoftware } from "./inspect-packaged-mac.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-package-inspection-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const releaseRoot = join(root, "release");
  const appPath = join(releaseRoot, "mac-arm64", "laundry-desk V2.app");
  const contentsPath = join(appPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  const spaPath = join(resourcesPath, "spa");
  await mkdir(join(contentsPath, "MacOS"), { recursive: true });
  await mkdir(join(resourcesPath, "update"), { recursive: true });
  await mkdir(join(spaPath, "bundles"), { recursive: true });
  await writeFile(join(contentsPath, "Info.plist"), "fixture\n");
  await writeFile(join(contentsPath, "MacOS", "laundry-desk V2"), Buffer.from("cffaedfe", "hex"), {
    mode: 0o755,
  });
  await writeFile(join(resourcesPath, "app.asar"), "fixture asar\n");
  await writeFile(
    join(resourcesPath, "update", "update-config.json"),
    '{"schema_version":1,"enabled":false}\n',
  );
  const html = Buffer.from("<!doctype html>\n");
  const manifest = `${JSON.stringify(
    {
      version: 1,
      entries: {
        "index.html": {
          sha256: createHash("sha256").update(html).digest("hex"),
          mime: "text/html; charset=utf-8",
          bytes: html.byteLength,
        },
      },
    },
    null,
    2,
  )}\n`;
  const bundleId = createHash("sha256").update(manifest).digest("hex");
  const bundlePath = join(spaPath, "bundles", bundleId);
  await mkdir(bundlePath);
  await writeFile(join(bundlePath, "index.html"), html);
  await writeFile(join(spaPath, "manifest.json"), manifest);
  const run = async (file, args) => {
    if (file === "/usr/bin/lipo") return { stderr: "", stdout: "arm64\n" };
    const key = args[1];
    const values = {
      "Print :CFBundleIdentifier": "com.laundry-desk.v2\n",
      "Print :CFBundleExecutable": "laundry-desk V2\n",
      "Print :CFBundleShortVersionString": "0.1.0\n",
    };
    return { stderr: "", stdout: values[key] ?? "" };
  };
  return { appPath, bundleId, releaseRoot, resourcesPath, run, spaPath };
}

test("inspects one complete unsigned package and emits software-only evidence", async (t) => {
  const setup = await fixture(t);
  const evidence = await inspectPackagedMacSoftware({
    platform: "darwin",
    releaseRoot: setup.releaseRoot,
    run: setup.run,
  });

  assert.deepEqual(evidence, {
    app_sha256: evidence.app_sha256,
    architecture: "arm64",
    assurance: "software_only",
    bundle_identifier: "com.laundry-desk.v2",
    spa_bundle: setup.bundleId,
    spa_entry_count: 1,
    version: "0.1.0",
  });
  assert.match(evidence.app_sha256, /^[0-9a-f]{64}$/u);
});

test("rejects retained SPA history and any update key material", async (t) => {
  const history = await fixture(t);
  await mkdir(join(history.spaPath, "bundles", "f".repeat(64)));
  await assert.rejects(
    () =>
      inspectPackagedMacSoftware({
        platform: "darwin",
        releaseRoot: history.releaseRoot,
        run: history.run,
      }),
    /exactly its active bundle/u,
  );

  const key = await fixture(t);
  await writeFile(join(key.resourcesPath, "update", "private.pem"), "not a real key\n");
  await assert.rejects(
    () =>
      inspectPackagedMacSoftware({
        platform: "darwin",
        releaseRoot: key.releaseRoot,
        run: key.run,
      }),
    /only its disabled configuration/u,
  );
});

test("rejects non-Darwin execution and symlinked package output", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    () =>
      inspectPackagedMacSoftware({
        platform: "linux",
        releaseRoot: setup.releaseRoot,
        run: setup.run,
      }),
    /requires Darwin/u,
  );

  const escapedSpa = await fixture(t);
  const externalSpa = join(escapedSpa.releaseRoot, "..", "external-spa");
  await rm(escapedSpa.spaPath, { recursive: true });
  await mkdir(externalSpa);
  await symlink(externalSpa, escapedSpa.spaPath);
  await assert.rejects(
    () =>
      inspectPackagedMacSoftware({
        platform: "darwin",
        releaseRoot: escapedSpa.releaseRoot,
        run: escapedSpa.run,
      }),
    /SPA directory must be a real directory/u,
  );

  const linkedRelease = join(setup.releaseRoot, "mac-linked");
  await symlink(join(setup.releaseRoot, "mac-arm64"), linkedRelease);
  await assert.rejects(
    () =>
      inspectPackagedMacSoftware({
        platform: "darwin",
        releaseRoot: setup.releaseRoot,
        run: setup.run,
      }),
    /real directory/u,
  );
});
