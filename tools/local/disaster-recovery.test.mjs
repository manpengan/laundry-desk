import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  createDisasterRecoveryBackup,
  restorePhotoSnapshot,
  verifyDisasterRecoveryBackup,
} from "./disaster-recovery.mjs";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "laundry-dr-"));
  roots.push(root);
  const backupDirectory = join(root, "backups");
  const photos = join(root, "photos");
  await mkdir(backupDirectory, { mode: 0o700 });
  await mkdir(photos, { mode: 0o700 });
  await writeFile(join(photos, ".laundry-photo-store-v1"), "laundry-desk-photo-store:v1\n", {
    mode: 0o600,
  });
  const photoName = "11111111-1111-4111-8111-111111111111.jpg";
  await writeFile(join(photos, photoName), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
    mode: 0o600,
  });
  const deliveryDirectory = join(photos, "delivery-evidence");
  const deliveryPhotoName = "22222222-2222-4222-8222-222222222222.png";
  await mkdir(deliveryDirectory, { mode: 0o700 });
  await writeFile(
    join(deliveryDirectory, ".laundry-photo-store-v1"),
    "laundry-desk-photo-store:v1\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(deliveryDirectory, deliveryPhotoName),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    { mode: 0o600 },
  );
  const context = Object.freeze({
    project: "laundry-ci-test",
    config: Object.freeze({ instanceId: "0123456789abcdefghijklmn" }),
    env: Object.freeze({ PATH: "/bin" }),
    backupDirectory,
  });
  const dependencies = Object.freeze({
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    now: () => new Date("2026-07-30T01:02:03.000Z"),
    stream: async (_command, options) => {
      writeSync(options.outputFd, Buffer.from("database-dump"));
    },
    run: async (command) => {
      assert.equal(command.args.at(-2), "server:/var/lib/laundry/photos/.");
      const destination = command.args.at(-1);
      await copyFile(
        join(photos, ".laundry-photo-store-v1"),
        join(destination, ".laundry-photo-store-v1"),
      );
      await copyFile(join(photos, photoName), join(destination, photoName));
      const deliveryDestination = join(destination, "delivery-evidence");
      await mkdir(deliveryDestination, { mode: 0o700 });
      await copyFile(
        join(deliveryDirectory, ".laundry-photo-store-v1"),
        join(deliveryDestination, ".laundry-photo-store-v1"),
      );
      await copyFile(
        join(deliveryDirectory, deliveryPhotoName),
        join(deliveryDestination, deliveryPhotoName),
      );
    },
  });
  return { photos, photoName, deliveryPhotoName, context, dependencies };
}

test("disaster recovery set binds the database dump and every private photo", async () => {
  const { context, dependencies } = await fixture();
  const backup = await createDisasterRecoveryBackup(
    context,
    { cwd: "/workspace", kind: "backup" },
    dependencies,
  );
  assert.equal(backup.photo_files, 2);
  const verified = await verifyDisasterRecoveryBackup(context, backup.path, backup.sha256);
  assert.equal(verified.database_sha256, backup.database_sha256);
  assert.equal(verified.photo_files, 2);

  const snapshotPhoto = join(verified.snapshotPath, "11111111-1111-4111-8111-111111111111.jpg");
  await writeFile(snapshotPhoto, Buffer.from([0xff, 0xd8, 0xff, 0x00]), { mode: 0o600 });
  await assert.rejects(
    () => verifyDisasterRecoveryBackup(context, backup.path, backup.sha256),
    /LOCAL_RESTORE_PHOTOS_INVALID/u,
  );
});

test("photo snapshot exports through the stopped container when the bind mount is unreadable", async () => {
  const { photos, photoName, context, dependencies } = await fixture();
  const exported = Object.freeze({
    ...dependencies,
    run: async (command) => {
      assert.equal(command.file, "docker");
      assert.equal(command.args.at(-3), "cp");
      assert.equal(command.args.at(-2), "server:/var/lib/laundry/photos/.");
      const destination = command.args.at(-1);
      await writeFile(
        join(destination, ".laundry-photo-store-v1"),
        "laundry-desk-photo-store:v1\n",
        { mode: 0o600 },
      );
      await writeFile(join(destination, photoName), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        mode: 0o600,
      });
    },
  });
  await chmod(photos, 0o000);
  try {
    const backup = await createDisasterRecoveryBackup(
      context,
      { cwd: "/workspace", kind: "backup" },
      exported,
    );
    assert.equal(backup.photo_files, 1);
  } finally {
    await chmod(photos, 0o700);
  }
});

test("photo restore swaps only the owned private photo directory", async () => {
  const { photos, photoName, deliveryPhotoName, context, dependencies } = await fixture();
  const backup = await createDisasterRecoveryBackup(
    context,
    { cwd: "/workspace", kind: "backup" },
    dependencies,
  );
  const source = await verifyDisasterRecoveryBackup(context, backup.path, backup.sha256);
  await writeFile(join(photos, photoName), Buffer.from([0xff, 0xd8, 0xff, 0x01]), {
    mode: 0o600,
  });
  await writeFile(
    join(photos, "delivery-evidence", deliveryPhotoName),
    Buffer.from([0x89, 0x50, 0x4e, 0x00]),
    { mode: 0o600 },
  );
  await restorePhotoSnapshot(context, source);
  assert.deepEqual(await readFile(join(photos, photoName)), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.deepEqual(
    await readFile(join(photos, "delivery-evidence", deliveryPhotoName)),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
});

test("bundle verification rejects a checksum-confirmed photo snapshot path escape", async () => {
  const { context, dependencies } = await fixture();
  const backup = await createDisasterRecoveryBackup(
    context,
    { cwd: "/workspace", kind: "backup" },
    dependencies,
  );
  const manifestPath = `${backup.path}.bundle.json`;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const escapedManifest = {
    ...manifest,
    photos: {
      ...manifest.photos,
      directory: "laundry-v2-backup-x/../../outside.dump.photos",
    },
  };
  const encoded = `${JSON.stringify(escapedManifest, null, 2)}\n`;
  await writeFile(manifestPath, encoded, { mode: 0o600 });
  const tamperedSha256 = createHash("sha256").update(encoded).digest("hex");

  await assert.rejects(
    () => verifyDisasterRecoveryBackup(context, backup.path, tamperedSha256),
    /LOCAL_RESTORE_BUNDLE_INVALID/u,
  );
});
