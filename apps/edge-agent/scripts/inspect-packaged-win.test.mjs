import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectPackagedWindowsSoftware } from "./inspect-packaged-win.mjs";

const APP = "laundry-desk V2.exe";
const INSTALLER = "laundry-desk-v2-0.1.0-windows-x64-development-only.exe";
const HELPER = "laundry-windows-helper.exe";

function x64PeFixture() {
  const bytes = Buffer.alloc(256);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-win-inspection-")));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const releaseRoot = join(root, "release");
  const resources = join(releaseRoot, "win-unpacked", "resources");
  const spa = join(resources, "spa");
  const helperRoot = join(resources, "windows-helper");
  await Promise.all([
    mkdir(join(spa, "bundles"), { recursive: true }),
    mkdir(join(resources, "update"), { recursive: true }),
    mkdir(helperRoot, { recursive: true }),
  ]);
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
  const bundle = createHash("sha256").update(manifest).digest("hex");
  await mkdir(join(spa, "bundles", bundle));
  const helper = Buffer.from("fixture helper\n");
  const helperDigest = createHash("sha256").update(helper).digest("hex");
  await Promise.all([
    writeFile(join(releaseRoot, "win-unpacked", APP), x64PeFixture()),
    writeFile(join(releaseRoot, INSTALLER), "fixture installer\n"),
    writeFile(join(releaseRoot, `${INSTALLER}.blockmap`), "fixture blockmap\n"),
    writeFile(join(resources, "app.asar"), "fixture asar\n"),
    writeFile(
      join(resources, "update", "update-config.json"),
      '{"schema_version":1,"enabled":false}\n',
    ),
    writeFile(join(helperRoot, HELPER), helper),
    writeFile(join(helperRoot, `${HELPER}.sha256`), `${helperDigest}\n`),
    writeFile(join(spa, "manifest.json"), manifest),
    writeFile(join(spa, "bundles", bundle, "index.html"), html),
  ]);
  return { bundle, helperDigest, helperRoot, releaseRoot };
}

test("inspects exact x64 unsigned NSIS, helper and SPA evidence", async (t) => {
  const setup = await fixture(t);

  const evidence = await inspectPackagedWindowsSoftware({
    platform: "win32",
    releaseRoot: setup.releaseRoot,
    signatureStatus: async () => "NotSigned",
  });

  assert.equal(evidence.app_id, "com.laundry-desk.v2");
  assert.equal(evidence.architecture, "x64");
  assert.equal(evidence.assurance, "software_only");
  assert.equal(evidence.helper_sha256, setup.helperDigest);
  assert.equal(evidence.spa_bundle, setup.bundle);
  assert.match(evidence.app_sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.installer_sha256, /^[0-9a-f]{64}$/u);
});

test("rejects helper tampering and a signed development-only artifact", async (t) => {
  const tampered = await fixture(t);
  await writeFile(join(tampered.helperRoot, HELPER), "tampered\n");
  await assert.rejects(
    () =>
      inspectPackagedWindowsSoftware({
        platform: "win32",
        releaseRoot: tampered.releaseRoot,
        signatureStatus: async () => "NotSigned",
      }),
    /helper digest does not match/u,
  );

  const signed = await fixture(t);
  await assert.rejects(
    () =>
      inspectPackagedWindowsSoftware({
        platform: "win32",
        releaseRoot: signed.releaseRoot,
        signatureStatus: async () => "Valid",
      }),
    /explicitly unsigned/u,
  );
});
