import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  DATA_PROTECTION_PHOTO_MARKER,
  DATA_PROTECTION_PHOTO_MARKER_CONTENT,
} from "./hk-vps-data-protection-contract.mjs";
import {
  cleanupDataProtectionRecoveryPath,
  findDataProtectionCodeTree,
  prepareDataProtectionCodeRestore,
  prepareDataProtectionPhotoRestore,
  switchDataProtectionCode,
  switchDataProtectionPhotos,
} from "./hk-vps-data-protection-recovery-files.mjs";

const roots = [];
after(
  async () => await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true }))),
);
const OPERATION = "1".repeat(32);
const SOURCE_SHA = "2".repeat(40);
const TARGET_SHA = "3".repeat(40);
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "laundry-data-recovery-files-")));
  roots.push(path);
  const metadata = await lstat(path);
  return { path, identity: { uid: metadata.uid, gid: metadata.gid } };
}

async function codeFixture() {
  const fixture = await root();
  const live = join(fixture.path, "laundry-desk");
  const retained = join(fixture.path, `laundry-desk.failed-${TARGET_SHA}`);
  for (const [path, sha] of [
    [live, SOURCE_SHA],
    [retained, TARGET_SHA],
  ]) {
    await mkdir(path, { mode: 0o755 });
    await writeFile(join(path, ".laundry-release.json"), `${sha}\n`, { mode: 0o644 });
    await writeFile(join(path, "server.js"), sha, { mode: 0o644 });
  }
  const readReleaseMarker = async (path) => ({
    git_sha: (await readFile(join(path, ".laundry-release.json"), "utf8")).trim(),
  });
  return { ...fixture, live, retained, readReleaseMarker };
}

test("recovery locates one retained code authority, copies it and switches atomically", async () => {
  const fixture = await codeFixture();
  const selected = await findDataProtectionCodeTree(TARGET_SHA, {
    root: fixture.path,
    identity: fixture.identity,
    readReleaseMarker: fixture.readReleaseMarker,
  });
  assert.equal(selected, fixture.retained);
  const staging = await prepareDataProtectionCodeRestore(selected, TARGET_SHA, OPERATION, {
    root: fixture.path,
    identity: fixture.identity,
    readReleaseMarker: fixture.readReleaseMarker,
    runCloudCommand: async (_file, arguments_) => {
      await cp(arguments_.at(-2).slice(0, -2), arguments_.at(-1), { recursive: true });
    },
  });
  const rollback = await switchDataProtectionCode(
    staging,
    SOURCE_SHA,
    new Date("2026-08-12T01:02:03.000Z"),
    {
      root: fixture.path,
      liveRoot: fixture.live,
      readReleaseMarker: fixture.readReleaseMarker,
    },
  );
  assert.equal((await fixture.readReleaseMarker(fixture.live)).git_sha, TARGET_SHA);
  assert.equal((await fixture.readReleaseMarker(rollback)).git_sha, SOURCE_SHA);
});

test("photo recovery copies only manifest files, changes ownership and keeps a rollback path", async () => {
  const fixture = await root();
  const photoRoot = join(fixture.path, "photos");
  const setPath = join(fixture.path, "set");
  const snapshot = join(setPath, "photos");
  const storageKey = "11111111-1111-4111-8111-111111111111.jpg";
  const content = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  for (const path of [photoRoot, setPath, snapshot]) await mkdir(path, { mode: 0o700 });
  for (const path of [photoRoot, snapshot]) {
    await writeFile(
      join(path, DATA_PROTECTION_PHOTO_MARKER),
      DATA_PROTECTION_PHOTO_MARKER_CONTENT,
      {
        mode: 0o600,
      },
    );
  }
  await writeFile(join(photoRoot, "old.jpg"), "old", { mode: 0o600 });
  await writeFile(join(snapshot, storageKey), content, { mode: 0o600 });
  const verified = {
    setPath,
    manifest: {
      photos: {
        directory: "photos",
        files: [{ storage_key: storageKey, bytes: content.length, sha256: digest(content) }],
      },
    },
  };
  const staging = await prepareDataProtectionPhotoRestore(verified, OPERATION, fixture.identity, {
    photoRoot,
    sourceIdentity: fixture.identity,
  });
  const previous = await switchDataProtectionPhotos(staging, OPERATION, { photoRoot });
  assert.deepEqual(await readFile(join(photoRoot, storageKey)), content);
  assert.equal(await readFile(join(previous, "old.jpg"), "utf8"), "old");
  await cleanupDataProtectionRecoveryPath(previous, OPERATION, { photoRoot });
  await assert.rejects(() => lstat(previous), { code: "ENOENT" });
});

test("ambiguous retained code and arbitrary cleanup targets fail closed", async () => {
  const fixture = await codeFixture();
  const duplicate = join(fixture.path, `laundry-desk.next-${TARGET_SHA}`);
  await cp(fixture.retained, duplicate, { recursive: true });
  await assert.rejects(
    () =>
      findDataProtectionCodeTree(TARGET_SHA, {
        root: fixture.path,
        identity: fixture.identity,
        readReleaseMarker: fixture.readReleaseMarker,
      }),
    { code: "CLOUD_DATA_CODE_TREE_AMBIGUOUS" },
  );
  await assert.rejects(
    () => cleanupDataProtectionRecoveryPath(fixture.path, OPERATION, { codeRoot: fixture.path }),
    { code: "CLOUD_DATA_RECOVERY_PATH_INVALID" },
  );
});

test("code preparation cleanup failure is stable and keeps its deterministic path", async () => {
  const fixture = await codeFixture();
  const staging = join(fixture.path, `laundry-desk.restore-${OPERATION}`);
  await assert.rejects(
    () =>
      prepareDataProtectionCodeRestore(fixture.retained, TARGET_SHA, OPERATION, {
        root: fixture.path,
        identity: fixture.identity,
        runCloudCommand: async () => {
          throw new Error("copy failed");
        },
        rm: async () => {
          throw new Error("cleanup failed");
        },
      }),
    { code: "CLOUD_DATA_CODE_STAGING_CLEANUP_FAILED" },
  );
  assert.equal((await lstat(staging)).isDirectory(), true);
});

test("photo preparation attempts both cleanup paths and reports cleanup failure", async () => {
  const fixture = await root();
  const photoRoot = join(fixture.path, "photos");
  const cleanupPaths = [];
  await assert.rejects(
    () =>
      prepareDataProtectionPhotoRestore(
        {
          setPath: join(fixture.path, "set"),
          manifest: { photos: { directory: "photos", files: [] } },
        },
        OPERATION,
        fixture.identity,
        {
          photoRoot,
          capturePhotos: async () => {
            throw new Error("capture failed");
          },
          rm: async (path) => {
            cleanupPaths.push(path);
            throw new Error("cleanup failed");
          },
        },
      ),
    { code: "CLOUD_DATA_PHOTO_STAGING_CLEANUP_FAILED" },
  );
  assert.deepEqual(cleanupPaths, [
    join(fixture.path, `.photo-restore-${OPERATION}.tmp`),
    `${photoRoot}.restore-${OPERATION}`,
  ]);
});
