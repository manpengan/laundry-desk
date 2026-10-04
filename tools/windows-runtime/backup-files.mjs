import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { digest, fail } from "./companion-contract.mjs";
import { requireRealDirectory } from "./companion-files.mjs";
import { exists } from "./lifecycle-storage.mjs";
import { readPhotoSnapshot, snapshotPhotos } from "./backup-photo-files.mjs";
import {
  BACKUP_ID,
  MAX_BACKUPS,
  MAX_DUMP_BYTES,
  requireBackup,
  requireMaintenance,
} from "./backup-contract.mjs";

export async function readMaintenance(io, root) {
  const path = join(root, "maintenance.json");
  if (!(await exists(path))) return null;
  try {
    return requireMaintenance(JSON.parse(await io.read(path)));
  } catch {
    fail("MAINTENANCE_STATE_INVALID");
  }
}

export async function backupSpace(root, databaseBytes = 0) {
  const space = await statfs(root, { bigint: true });
  const available = space.bavail * space.bsize;
  if (
    !Number.isSafeInteger(databaseBytes) ||
    databaseBytes < 0 ||
    databaseBytes > 4 * MAX_DUMP_BYTES ||
    available < BigInt(2 * MAX_DUMP_BYTES + 2 * databaseBytes)
  )
    fail("BACKUP_SPACE_INSUFFICIENT");
}

export async function backupDirectories(root, io, platform, create = false) {
  const base = join(root, "backups");
  if (!(await exists(base))) {
    if (!create) return [];
    await io.directory(base);
  }
  await requireRealDirectory(base);
  await platform.inspectPrivateDirectory(base);
  const names = await readdir(base);
  if (names.length > MAX_BACKUPS || names.some((name) => !BACKUP_ID.test(name)))
    fail("BACKUP_SET_INVALID");
  for (const name of names) {
    await requireRealDirectory(join(base, name));
    await platform.inspectPrivateDirectory(join(base, name));
  }
  return names.sort();
}

function sameFile(before, after) {
  return (
    after.isFile() &&
    after.nlink === 1 &&
    before.ino === after.ino &&
    before.dev === after.dev &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function hashHandle(file) {
  const info = await file.stat();
  if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_DUMP_BYTES)
    fail("BACKUP_DUMP_INVALID");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(128 * 1024);
  let position = 0;
  while (position < info.size) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, info.size - position),
      position,
    );
    if (!bytesRead) fail("BACKUP_DUMP_CHANGED");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (!sameFile(info, await file.stat())) fail("BACKUP_DUMP_CHANGED");
  return { size: info.size, sha256: hash.digest("hex") };
}

export async function withBackupDump(path, platform, expected, action = async () => {}) {
  await requireRealDirectory(join(path, ".."));
  await platform.inspectPrivateFile(path);
  const before = await lstat(path);
  const file = await open(path, "r");
  try {
    if (!sameFile(before, await file.stat())) fail("BACKUP_DUMP_CHANGED");
    const metadata = await hashHandle(file);
    if (expected && JSON.stringify(metadata) !== JSON.stringify(expected))
      fail("BACKUP_DUMP_MISMATCH");
    const result = await action(file);
    if (!sameFile(before, await lstat(path)) || !sameFile(before, await file.stat()))
      fail("BACKUP_DUMP_CHANGED");
    await platform.inspectPrivateFile(path);
    if (JSON.stringify(await hashHandle(file)) !== JSON.stringify(metadata))
      fail("BACKUP_DUMP_CHANGED");
    return { metadata, result };
  } finally {
    await file.close();
  }
}

export async function readBackup(context, id, confirmation) {
  if (!BACKUP_ID.test(id)) fail("ARGS_INVALID");
  const { root, io, platform, instance, entry, postgresVersion } = context;
  await backupDirectories(root, io, platform);
  const directory = join(root, "backups", id);
  await requireRealDirectory(directory);
  await platform.inspectPrivateDirectory(directory);
  const bytes = await io.read(join(directory, "backup.json"));
  const hash = digest(bytes);
  if (confirmation !== undefined && hash !== confirmation) fail("BACKUP_CONFIRMATION_MISMATCH");
  let manifest;
  try {
    manifest = requireBackup(JSON.parse(bytes));
  } catch {
    fail("BACKUP_INVALID");
  }
  const names = (await readdir(directory)).sort();
  const expected =
    manifest.version === 1
      ? ["backup.json", "database.dump"]
      : ["backup.json", "database.dump", "photos", "photos.json"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail("BACKUP_FILE_SET_INVALID");
  if (manifest.id !== id || manifest.instance_sha256 !== instance) fail("BACKUP_INSTANCE_MISMATCH");
  if (
    manifest.release.migrations !== entry.migrations ||
    manifest.release.migrationHead !== entry.migrationHead ||
    manifest.postgres_version !== postgresVersion
  )
    fail("BACKUP_VERSION_MISMATCH");
  const path = join(directory, "database.dump");
  await withBackupDump(path, platform, manifest.database);
  const photos =
    manifest.version === 1 ? [] : await readPhotoSnapshot(context, directory, manifest.photos);
  return { manifest, path, digest: hash, id, photos };
}

export async function createBackup(context, dump) {
  const { root, io, platform, entry, instance, postgresVersion } = context;
  const names = await backupDirectories(root, io, platform, true);
  if (names.length >= MAX_BACKUPS) fail("BACKUP_RETENTION_FULL");
  await backupSpace(root);
  const id = `b_${randomUUID().replaceAll("-", "")}`;
  const directory = join(root, "backups", id);
  if (await exists(directory)) fail("BACKUP_ID_CONFLICT");
  await io.directory(directory);
  const path = join(directory, "database.dump");
  const file = await open(path, "wx", 0o600);
  try {
    await platform.securePrivateFile(path);
    await platform.inspectPrivateFile(path);
    await dump(file);
    const info = await file.stat();
    const linked = await lstat(path);
    if (!sameFile(info, linked) || info.size < 1 || info.size > MAX_DUMP_BYTES)
      fail("BACKUP_DUMP_INVALID");
    await file.sync();
  } finally {
    await file.close();
  }
  await platform.flushDirectoryDurably(directory);
  const { metadata } = await withBackupDump(path, platform);
  const manifest = requireBackup({
    schema: "laundry.windows.backup",
    version: 2,
    assurance: "development_only",
    id,
    instance_sha256: instance,
    created_at: new Date().toISOString(),
    release: entry,
    postgres_version: postgresVersion,
    photos: await snapshotPhotos(context, directory),
    database: metadata,
  });
  await io.write(join(directory, "backup.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return readBackup(context, id);
}

export async function listBackups(context) {
  const names = await backupDirectories(context.root, context.io, context.platform);
  const backups = [];
  for (const id of names) {
    if (!(await exists(join(context.root, "backups", id, "backup.json")))) {
      backups.push({ backup_id: id, status: "incomplete" });
      continue;
    }
    const backup = await readBackup(context, id);
    backups.push(backupSummary(backup));
  }
  return backups;
}

export function backupSummary(backup) {
  return {
    backup_id: backup.id,
    manifest_sha256: backup.digest,
    status: "verified",
    created_at: backup.manifest.created_at,
    migration_head: backup.manifest.release.migrationHead,
    database_bytes: backup.manifest.database.size,
    photo_count: backup.manifest.version === 1 ? 0 : backup.manifest.photos.count,
    photo_bytes: backup.manifest.version === 1 ? 0 : backup.manifest.photos.total_bytes,
  };
}
