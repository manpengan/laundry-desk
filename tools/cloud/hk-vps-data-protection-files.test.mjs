import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  DATA_PROTECTION_PHOTO_MARKER,
  DATA_PROTECTION_PHOTO_MARKER_CONTENT,
  createDataProtectionManifest,
  createDataProtectionVerification,
} from "./hk-vps-data-protection-contract.mjs";
import {
  captureDataProtectionPhotos,
  ensureDataProtectionRoots,
  photoInventoryDigest,
  publishDataProtectionSet,
  verifyDataProtectionSet,
  writeDataProtectionJson,
} from "./hk-vps-data-protection-files.mjs";
import { sha256DataProtectionFile } from "./hk-vps-data-protection-hash.mjs";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("data-protection root checks are safe to repeat", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-cloud-data-roots-")));
  roots.push(root);
  const metadata = await lstat(root);
  const options = {
    root: join(root, "data"),
    setRoot: join(root, "data", "sets"),
    identity: Object.freeze({ uid: metadata.uid, gid: metadata.gid }),
  };
  await ensureDataProtectionRoots(options);
  await ensureDataProtectionRoots(options);
  assert.equal((await lstat(options.setRoot)).mode & 0o7777, 0o700);
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-cloud-data-files-")));
  roots.push(root);
  const photoRoot = join(root, "source-photos");
  const setRoot = join(root, "sets");
  const staging = join(root, "staging");
  await mkdir(photoRoot, { mode: 0o700 });
  await mkdir(setRoot, { mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  await writeFile(
    join(photoRoot, DATA_PROTECTION_PHOTO_MARKER),
    DATA_PROTECTION_PHOTO_MARKER_CONTENT,
    { mode: 0o600 },
  );
  const storageKey = "11111111-1111-4111-8111-111111111111.jpg";
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await writeFile(join(photoRoot, storageKey), bytes, { mode: 0o600 });
  const sourceMetadata = await lstat(photoRoot);
  const identity = Object.freeze({ uid: sourceMetadata.uid, gid: sourceMetadata.gid });
  const files = Object.freeze([
    Object.freeze({ storage_key: storageKey, bytes: bytes.byteLength, sha256: digest(bytes) }),
  ]);
  return { files, identity, photoRoot, root, setRoot, staging, storageKey };
}

async function completeSet(input) {
  const setId = "manual-20260812T010203Z-0123456789abcdef";
  const photos = await captureDataProtectionPhotos(input.staging, input.files, {
    photoRoot: input.photoRoot,
    sourceIdentity: input.identity,
  });
  const dumpPath = join(input.staging, "database.dump");
  await writeFile(dumpPath, "database-dump", { mode: 0o600 });
  const manifest = createDataProtectionManifest({
    set_id: setId,
    kind: "manual",
    code_sha: "1".repeat(40),
    created_at: "2026-08-12T01:02:03.000Z",
    migration: {
      head: "0051_customer_extended_profiles.sql",
      count: 51,
      ledger_sha256: "2".repeat(64),
      catalog_sha256: "3".repeat(64),
    },
    database: {
      file: "database.dump",
      bytes: (await lstat(dumpPath)).size,
      sha256: await sha256DataProtectionFile(dumpPath),
    },
    photos,
  });
  await writeDataProtectionJson(join(input.staging, "manifest.json"), manifest);
  const manifestSha256 = await sha256DataProtectionFile(join(input.staging, "manifest.json"));
  await writeDataProtectionJson(
    join(input.staging, "verification.json"),
    createDataProtectionVerification({
      set_id: setId,
      manifest_sha256: manifestSha256,
      migration_ledger_sha256: manifest.migration.ledger_sha256,
      catalog_sha256: manifest.migration.catalog_sha256,
      photo_inventory_sha256: manifest.photos.inventory_sha256,
      completed_at: "2026-08-12T01:03:03.000Z",
    }),
  );
  return { manifest, setId };
}

test("photo snapshot copies only the database inventory and binds every digest", async () => {
  const input = await fixture();
  await writeFile(
    join(input.photoRoot, "22222222-2222-4222-8222-222222222222.jpg"),
    Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    { mode: 0o600 },
  );
  const photos = await captureDataProtectionPhotos(input.staging, input.files, {
    photoRoot: input.photoRoot,
    sourceIdentity: input.identity,
  });
  assert.equal(photos.count, 1);
  assert.equal(photos.inventory_sha256, photoInventoryDigest(input.files));
  assert.deepEqual(
    await readFile(join(input.staging, "photos", input.storageKey)),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  );
});

test("a completed recovery set publishes atomically and revalidates all artifacts", async () => {
  const input = await fixture();
  const { setId } = await completeSet(input);
  const path = await publishDataProtectionSet(input.staging, setId, {
    setRoot: input.setRoot,
  });
  const verified = await verifyDataProtectionSet(path, { identity: input.identity });
  assert.equal(verified.manifest.set_id, setId);
  assert.equal(verified.verification?.manifest_sha256, verified.manifestSha256);
});

test("tampered, linked or extra recovery-set files fail closed", async () => {
  const input = await fixture();
  const { setId } = await completeSet(input);
  const path = await publishDataProtectionSet(input.staging, setId, {
    setRoot: input.setRoot,
  });
  await writeFile(join(path, "photos", input.storageKey), "tampered", { mode: 0o600 });
  await assert.rejects(() => verifyDataProtectionSet(path, { identity: input.identity }), {
    code: "CLOUD_DATA_PHOTO_SNAPSHOT_INVALID",
  });

  await chmod(join(path, "photos", input.storageKey), 0o644);
  await assert.rejects(() => verifyDataProtectionSet(path, { identity: input.identity }), {
    code: "CLOUD_DATA_PHOTO_SNAPSHOT_INVALID",
  });
});
