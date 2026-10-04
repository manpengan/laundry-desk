import { readdir, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { digest, exactKeys, fail } from "./companion-contract.mjs";
import { requireRealDirectory } from "./companion-files.mjs";
import { BACKUP_ID, requireBackup } from "./backup-contract.mjs";
import { MAX_PHOTO_INDEX_BYTES, requirePhotoIndex } from "./backup-photo-contract.mjs";
import { withBackupDump } from "./backup-files.mjs";
import { exists } from "./lifecycle-storage.mjs";

async function removeFile(context, path, expected) {
  if (!(await exists(path))) return;
  if (expected) await withBackupDump(path, context.platform, expected);
  else await context.platform.inspectPrivateFile(path);
  await unlink(path);
}

export async function resumePruning(context, protectedIds = new Set()) {
  const path = join(context.root, "backup-prune.json");
  if (!(await exists(path))) return;
  const record = JSON.parse(await context.io.read(path));
  if (exactKeys(record, ["version", "phase"]) && record.version === 1 && record.phase === "idle")
    return;
  if (
    !exactKeys(record, ["version", "id", "manifest_sha256"]) ||
    record.version !== 1 ||
    typeof record.id !== "string" ||
    !BACKUP_ID.test(record.id) ||
    typeof record.manifest_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.manifest_sha256) ||
    protectedIds.has(record.id)
  )
    fail("BACKUP_PRUNE_INVALID");
  const directory = join(context.root, "backups", record.id);
  if (await exists(directory)) {
    await requireRealDirectory(directory);
    await context.platform.inspectPrivateDirectory(directory);
    const manifestPath = join(directory, "backup.json");
    if (await exists(manifestPath)) {
      const text = await context.io.read(manifestPath);
      if (digest(text) !== record.manifest_sha256) fail("BACKUP_PRUNE_CHANGED");
      const manifest = requireBackup(JSON.parse(text));
      if (manifest.id !== record.id || manifest.instance_sha256 !== context.instance)
        fail("BACKUP_PRUNE_CHANGED");
      if (
        (await readdir(directory)).some(
          (name) =>
            !(
              manifest.version === 2
                ? ["backup.json", "database.dump", "photos.json", "photos"]
                : ["backup.json", "database.dump"]
            ).includes(name),
        )
      )
        fail("BACKUP_PRUNE_CHANGED");
      const photos = join(directory, "photos");
      if (await exists(photos)) {
        if (manifest.version !== 2) fail("BACKUP_PRUNE_CHANGED");
        await requireRealDirectory(photos);
        await context.platform.inspectPrivateDirectory(photos);
        const index = await withBackupDump(
          join(directory, "photos.json"),
          context.platform,
          manifest.photos.index,
          async (file) => {
            if ((await file.stat()).size > MAX_PHOTO_INDEX_BYTES) fail("BACKUP_PRUNE_CHANGED");
            return requirePhotoIndex(JSON.parse(await file.readFile("utf8")));
          },
        );
        const expected = new Map(index.result.map((photo) => [photo.key, photo]));
        for (const name of await readdir(photos)) {
          const photo = expected.get(name);
          if (!photo) fail("BACKUP_PRUNE_CHANGED");
          await removeFile(context, join(photos, name), { size: photo.size, sha256: photo.sha256 });
        }
        await rmdir(photos);
      }
      await removeFile(
        context,
        join(directory, "photos.json"),
        manifest.version === 2 ? manifest.photos.index : undefined,
      );
      await removeFile(context, join(directory, "database.dump"), manifest.database);
      await removeFile(context, manifestPath);
    }
    if ((await readdir(directory)).length !== 0) fail("BACKUP_PRUNE_CHANGED");
    await rmdir(directory);
    await context.platform.flushDirectoryDurably(join(context.root, "backups"));
  }
  await context.io.write(path, JSON.stringify({ version: 1, phase: "idle" }));
}

export async function deleteVerifiedBackup(context, backup, protectedIds) {
  await context.io.write(
    join(context.root, "backup-prune.json"),
    JSON.stringify({
      version: 1,
      id: backup.id,
      manifest_sha256: backup.digest,
    }),
  );
  await resumePruning(context, protectedIds);
}
