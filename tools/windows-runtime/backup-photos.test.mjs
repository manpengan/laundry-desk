import assert from "node:assert/strict";
import test from "node:test";
import { link, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backupFixture } from "./backup-test-fixture.mjs";
import { digest } from "./companion-contract.mjs";
import { createBackup, readBackup } from "./backup-files.mjs";
import { databaseTools } from "./backup-database.mjs";
import { inspectLivePhotos, restorePhotos, verifyPhotoReferences } from "./backup-photo-files.mjs";
import { PHOTO_MARKER, PHOTO_MARKER_CONTENT, requirePhotoIndex } from "./backup-photo-contract.mjs";

const keyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
const keyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
const photoA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const photoB = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const row = (key, bytes) => ({ key, size: bytes.length, sha256: digest(bytes) });
const make = (context) => createBackup(context, (file) => file.writeFile("synthetic-dump"));

async function photos(context) {
  const root = join(context.root, "photos");
  await context.io.directory(root);
  await context.io.write(join(root, PHOTO_MARKER), PHOTO_MARKER_CONTENT);
  await context.io.write(join(root, keyA), photoA);
  return root;
}

test("database and photos are one verified v2 backup; restoring bytes retains pre-restore files", async (t) => {
  const context = await backupFixture(t);
  const live = await photos(context);
  const backup = await make(context);
  assert.equal(backup.manifest.version, 2);
  assert.equal(backup.manifest.photos.count, 1);
  assert.equal(backup.manifest.photos.total_bytes, photoA.length);
  assert.deepEqual(backup.photos, [row(keyA, photoA)]);
  await unlink(join(live, keyA));
  await context.io.write(join(live, keyB), photoB);
  await restorePhotos(context, backup);
  assert.deepEqual(await readFile(join(live, keyA)), photoA);
  assert.deepEqual(await readFile(join(live, keyB)), photoB);
  await restorePhotos(context, backup); // repeated recovery is idempotent
  assert.equal((await readdir(live)).length, 3);
  await verifyPhotoReferences(context, backup.photos);
});

test("delivery evidence uses a separate marked live store and flat bound archive keys", async (t) => {
  const context = await backupFixture(t);
  const live = await photos(context);
  const delivery = join(live, "delivery-evidence");
  await context.io.directory(delivery);
  await context.io.write(join(delivery, PHOTO_MARKER), PHOTO_MARKER_CONTENT);
  await context.io.write(join(delivery, keyB), photoB);
  const backup = await make(context);
  assert.deepEqual(backup.photos, [row(keyA, photoA), row(`delivery-${keyB}`, photoB)]);
  await unlink(join(delivery, keyB));
  await restorePhotos(context, backup);
  assert.deepEqual(await readFile(join(delivery, keyB)), photoB);
  await verifyPhotoReferences(context, [row(`delivery-${keyB}`, photoB)]);
  await context.io.write(join(delivery, "unsafe.txt"), "unexpected");
  await assert.rejects(inspectLivePhotos(context), /PHOTO_FILE_SET_INVALID/);
});

test("tampered, missing and additional photo bytes invalidate the entire backup", async (t) => {
  const context = await backupFixture(t);
  await photos(context);
  const backup = await make(context);
  const base = join(context.root, "backups", backup.id, "photos");
  await writeFile(join(base, keyA), Buffer.alloc(photoA.length));
  await assert.rejects(readBackup(context, backup.id), /DUMP_MISMATCH/u);
  await writeFile(join(base, keyA), photoA);
  await context.io.write(join(base, keyB), photoB);
  await assert.rejects(readBackup(context, backup.id), /PHOTO_FILE_SET_INVALID/u);
  await unlink(join(base, keyB));
  await unlink(join(base, keyA));
  await assert.rejects(readBackup(context, backup.id), /PHOTO_FILE_SET_INVALID/u);
});

test("restore refuses UUID collisions and never overwrites current photo bytes", async (t) => {
  const context = await backupFixture(t);
  const live = await photos(context);
  const backup = await make(context);
  const changed = Buffer.alloc(photoA.length, 1);
  await writeFile(join(live, keyA), changed);
  await assert.rejects(restorePhotos(context, backup), /PHOTO_COLLISION/u);
  assert.deepEqual(await readFile(join(live, keyA)), changed);
  assert.deepEqual(
    await readFile(join(context.root, "backups", backup.id, "photos", keyA)),
    photoA,
  );
});

test("hardlinks, unowned roots and unexpected live files are not silently archived", async (t) => {
  const context = await backupFixture(t);
  const live = await photos(context);
  const outside = join(context.root, "alias");
  await link(join(live, keyA), outside);
  await assert.rejects(make(context), /PRIVATE_FILE_INVALID/u);
  await unlink(outside);
  await context.io.write(join(live, "secret.txt"), "do not package");
  await assert.rejects(inspectLivePhotos(context), /PHOTO_FILE_SET_INVALID/u);
  await unlink(join(live, "secret.txt"));
  await context.io.write(join(live, PHOTO_MARKER), "unowned");
  await assert.rejects(inspectLivePhotos(context), /PHOTO_ROOT_UNOWNED/u);
});

test("photo indexes reject aliases, malformed sizes, duplicate keys and null legacy hashes", () => {
  for (const value of [
    [{ ...row(keyA, photoA), key: "../outside.png" }],
    [{ ...row(keyA, photoA), size: -1 }],
    [{ ...row(keyA, photoA), sha256: null }],
    [row(keyA, photoA), row(keyA, photoA)],
    [{ ...row(keyA, photoA), private_key: "not allowed" }],
  ])
    assert.throws(() => requirePhotoIndex(value), /PHOTO_.*INVALID/u);
});

test("legacy database-only backups remain readable with an empty photo set", async (t) => {
  const context = await backupFixture(t);
  const backup = await make(context);
  const base = join(context.root, "backups", backup.id);
  const { rmdir } = await import("node:fs/promises");
  await rmdir(join(base, "photos"));
  await unlink(join(base, "photos.json"));
  await context.io.write(
    join(base, "backup.json"),
    JSON.stringify({
      ...backup.manifest,
      version: 1,
      photos: "disabled_empty",
    }),
  );
  const legacy = await readBackup(context, backup.id);
  assert.deepEqual(legacy.photos, []);
  await assert.rejects(
    verifyPhotoReferences(context, [row(keyA, photoA)], legacy.photos),
    /REFERENCE_MISMATCH/u,
  );
});

test("native database validation binds every photo row to archived or live bytes", async (t) => {
  const context = await backupFixture(t);
  await photos(context);
  let rows = [row(keyA, photoA)];
  const database = databaseTools(
    { ...context, payload: "test", env: {} },
    {
      kit: async () => {},
      run: async (_file, args) => {
        const sql = args.at(-1);
        if (sql.includes("to_regclass")) return "OK";
        if (sql.includes("count(*)")) return String(rows.length);
        if (sql.includes("json_agg")) return JSON.stringify(rows);
        assert.fail(`unexpected SQL: ${sql}`);
      },
    },
  );
  await database.verify();
  rows = [row(keyB, photoB)];
  await assert.rejects(database.verify(), /PHOTO_REFERENCE_MISMATCH/u);
  rows = [{ ...row(keyA, photoA), sha256: "f".repeat(64) }];
  await assert.rejects(database.verify(), /PHOTO_REFERENCE_MISMATCH/u);
});
