import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import afterPack, { planPackagedSpaPrune, prunePackagedSpa } from "./prune-packaged-spa.mjs";

const PRODUCT_NAME = "laundry-desk V2";
const INACTIVE_BUNDLE = "f".repeat(64);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function createFixture(platform = "darwin") {
  const rootPath = await mkdtemp(join(tmpdir(), "laundry-packaged-spa-"));
  const appOutDir = join(rootPath, platform === "darwin" ? "mac-arm64" : "win-unpacked");
  const spaPath =
    platform === "darwin"
      ? join(appOutDir, `${PRODUCT_NAME}.app`, "Contents", "Resources", "spa")
      : join(appOutDir, "resources", "spa");
  const manifest = '{"version":1,"entries":{}}\n';
  const activeBundle = sha256(manifest);
  await mkdir(join(spaPath, "bundles", activeBundle), { recursive: true });
  await mkdir(join(spaPath, "bundles", INACTIVE_BUNDLE), { recursive: true });
  await writeFile(join(spaPath, "manifest.json"), manifest);
  await writeFile(join(spaPath, "bundles", activeBundle, "index.html"), "active\n");
  await writeFile(join(spaPath, "bundles", INACTIVE_BUNDLE, "index.html"), "inactive\n");
  if (platform === "win32") {
    await writeFile(join(appOutDir, `${PRODUCT_NAME}.exe`), "windows executable fixture\n");
  }

  return Object.freeze({
    rootPath,
    appOutDir,
    spaPath,
    activeBundle,
    context: Object.freeze({
      appOutDir,
      electronPlatformName: platform,
      packager: Object.freeze({
        appInfo: Object.freeze({ productFilename: PRODUCT_NAME }),
      }),
    }),
  });
}

test("afterPack retains only the bundle selected by the packaged manifest", async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await rm(fixture.rootPath, { force: true, recursive: true });
  });
  const sourceHistory = join(fixture.rootPath, "source-history", INACTIVE_BUNDLE);
  await mkdir(sourceHistory, { recursive: true });
  await writeFile(join(sourceHistory, "index.html"), "source history\n");

  await afterPack(fixture.context);

  assert.deepEqual(await readdir(join(fixture.spaPath, "bundles")), [fixture.activeBundle]);
  assert.equal(
    await readFile(join(fixture.spaPath, "bundles", fixture.activeBundle, "index.html"), "utf8"),
    "active\n",
  );
  assert.equal(await readFile(join(sourceHistory, "index.html"), "utf8"), "source history\n");
});

test("afterPack applies the same retention contract to a Windows package", async (t) => {
  const fixture = await createFixture("win32");
  t.after(async () => {
    await rm(fixture.rootPath, { force: true, recursive: true });
  });

  await afterPack(fixture.context);

  assert.deepEqual(await readdir(join(fixture.spaPath, "bundles")), [fixture.activeBundle]);
});

test("retention planning is deterministic and never removes a bundle", async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await rm(fixture.rootPath, { force: true, recursive: true });
  });

  const plan = await planPackagedSpaPrune(fixture.context);

  assert.deepEqual(plan, {
    active_bundle: fixture.activeBundle,
    active_bundle_bytes: 7,
    bundle_count: 2,
    inactive_bundle_bytes: 9,
    inactive_bundles: [INACTIVE_BUNDLE],
    packaged_retained_bundles: [fixture.activeBundle],
  });
  assert.deepEqual((await readdir(join(fixture.spaPath, "bundles"))).sort(), [
    fixture.activeBundle,
    INACTIVE_BUNDLE,
  ]);
});

test("pruning is idempotent for an already minimal packaged snapshot", async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await rm(fixture.rootPath, { force: true, recursive: true });
  });

  await prunePackagedSpa(fixture.context);
  await prunePackagedSpa(fixture.context);

  assert.deepEqual(await readdir(join(fixture.spaPath, "bundles")), [fixture.activeBundle]);
});

test("invalid bundle entries fail before any history is removed", async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await rm(fixture.rootPath, { force: true, recursive: true });
  });
  await mkdir(join(fixture.spaPath, "bundles", "not-a-sha256"));

  await assert.rejects(() => prunePackagedSpa(fixture.context), /invalid bundle entry/u);

  assert.deepEqual((await readdir(join(fixture.spaPath, "bundles"))).sort(), [
    fixture.activeBundle,
    INACTIVE_BUNDLE,
    "not-a-sha256",
  ]);
});

test("symbolic-link bundle entries are rejected without following or deleting them", async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await rm(fixture.rootPath, { force: true, recursive: true });
  });
  const linkedBundle = "e".repeat(64);
  await symlink(fixture.activeBundle, join(fixture.spaPath, "bundles", linkedBundle));

  await assert.rejects(() => prunePackagedSpa(fixture.context), /real directory/u);

  assert.deepEqual((await readdir(join(fixture.spaPath, "bundles"))).sort(), [
    fixture.activeBundle,
    linkedBundle,
    INACTIVE_BUNDLE,
  ]);
});

test("missing active bundle and unsupported desktop contexts fail closed", async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await rm(fixture.rootPath, { force: true, recursive: true });
  });
  await rm(join(fixture.spaPath, "bundles", fixture.activeBundle), { recursive: true });

  await assert.rejects(() => prunePackagedSpa(fixture.context), /active bundle is missing/u);
  await assert.rejects(
    () =>
      prunePackagedSpa({
        ...fixture.context,
        electronPlatformName: "linux",
      }),
    /supported desktop package/u,
  );
});
