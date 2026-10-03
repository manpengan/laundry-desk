import { randomUUID } from "node:crypto";
import { open, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { digest, fail } from "./companion-contract.mjs";
import { requireRealDirectory } from "./companion-files.mjs";
import { exists } from "./lifecycle-storage.mjs";
import { withBackupDump } from "./backup-files.mjs";
import {
  PHOTO_KEY,
  PHOTO_MARKER,
  PHOTO_MARKER_CONTENT,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  MAX_PHOTO_INDEX_BYTES,
  requirePhotoEntry,
  requirePhotoIndex,
  requirePhotoManifest,
} from "./backup-photo-contract.mjs";

const STAGING = /^\.[0-9a-f-]{36}\.(?:jpg|png|webp)\.[0-9a-f-]{36}\.staging$/u;

async function photoDirectory(context, directory, create = false) {
  const { io, platform } = context;
  if (!(await exists(directory))) {
    if (!create) return false;
    await io.directory(directory);
    await io.write(join(directory, PHOTO_MARKER), PHOTO_MARKER_CONTENT);
  }
  await requireRealDirectory(directory);
  await platform.inspectPrivateDirectory(directory);
  if ((await io.read(join(directory, PHOTO_MARKER))) !== PHOTO_MARKER_CONTENT)
    fail("BACKUP_PHOTO_ROOT_UNOWNED");
  return true;
}

async function readPhoto(path, platform, expected) {
  const result = await withBackupDump(
    path,
    platform,
    expected && {
      size: expected.size,
      sha256: expected.sha256,
    },
    async (file) => {
      if ((await file.stat()).size > MAX_PHOTO_BYTES) fail("BACKUP_PHOTO_SIZE_INVALID");
      return file.readFile();
    },
  );
  return result;
}

export async function inspectLivePhotos(context) {
  const directory = join(context.root, "photos");
  if (!(await photoDirectory(context, directory))) return [];
  const names = (await readdir(directory)).filter((name) => name !== PHOTO_MARKER);
  if (
    names.length > MAX_PHOTOS * 2 ||
    names.some((name) => !PHOTO_KEY.test(name) && !STAGING.test(name))
  )
    fail("BACKUP_PHOTO_FILE_SET_INVALID");
  const entries = [];
  for (const key of names.filter((name) => PHOTO_KEY.test(name)).sort()) {
    const { metadata } = await readPhoto(join(directory, key), context.platform);
    entries.push({ key, ...metadata });
  }
  return requirePhotoIndex(entries);
}

// DB references are checked separately: orphan files may safely remain, but no
// restored or backed-up row may point at absent/different bytes.
export async function verifyPhotoReferences(context, rows, expected) {
  const available = expected ?? (await inspectLivePhotos(context));
  const indexed = new Map(available.map((entry) => [entry.key, entry]));
  for (const row of rows) {
    requirePhotoEntry(row);
    const entry = indexed.get(row.key);
    if (!entry || entry.size !== row.size || entry.sha256 !== row.sha256)
      fail("BACKUP_PHOTO_REFERENCE_MISMATCH");
  }
}

async function copyPhoto(context, source, directory, entry) {
  const final = join(directory, entry.key);
  if (await exists(final)) {
    await readPhoto(final, context.platform, entry);
    return;
  }
  const temporary = join(directory, `.${entry.key}.${randomUUID()}.staging`);
  const { result: bytes } = await readPhoto(source, context.platform, entry);
  const file = await open(temporary, "wx", 0o600);
  try {
    await context.platform.securePrivateFile(temporary);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await context.platform.inspectPrivateFile(temporary);
  await context.platform.publishFileNoReplace(temporary, final);
  await context.platform.inspectPrivateFile(final);
  await context.platform.flushDirectoryDurably(directory);
  await readPhoto(final, context.platform, entry);
}

export async function snapshotPhotos(context, directory) {
  const entries = await inspectLivePhotos(context);
  const bytesRequired = entries.reduce((sum, entry) => sum + entry.size, 0);
  const space = await statfs(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(bytesRequired + MAX_PHOTO_INDEX_BYTES))
    fail("BACKUP_SPACE_INSUFFICIENT");
  const destination = join(directory, "photos");
  await context.io.directory(destination);
  for (const entry of entries)
    await copyPhoto(context, join(context.root, "photos", entry.key), destination, entry);
  const bytes = Buffer.from(JSON.stringify(entries));
  if (bytes.length > MAX_PHOTO_INDEX_BYTES) fail("BACKUP_PHOTO_INDEX_INVALID");
  // The normal state reader is intentionally 64 KiB. Photo indexes use a
  // separately bounded held-handle reader and never widen state-file limits.
  await context.io.write(join(directory, "photos.json"), bytes);
  return requirePhotoManifest({
    index: { size: bytes.length, sha256: digest(bytes) },
    count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  });
}

export async function readPhotoSnapshot(context, directory, manifest) {
  requirePhotoManifest(manifest);
  const { result: text } = await withBackupDump(
    join(directory, "photos.json"),
    context.platform,
    manifest.index,
    async (file) => {
      if ((await file.stat()).size > MAX_PHOTO_INDEX_BYTES) fail("BACKUP_PHOTO_INDEX_INVALID");
      return file.readFile("utf8");
    },
  );
  let entries;
  try {
    entries = requirePhotoIndex(JSON.parse(text));
  } catch {
    fail("BACKUP_PHOTO_INDEX_INVALID");
  }
  if (
    entries.length !== manifest.count ||
    entries.reduce((sum, entry) => sum + entry.size, 0) !== manifest.total_bytes
  )
    fail("BACKUP_PHOTO_INDEX_MISMATCH");
  const base = join(directory, "photos");
  await requireRealDirectory(base);
  await context.platform.inspectPrivateDirectory(base);
  if (
    JSON.stringify((await readdir(base)).sort()) !==
    JSON.stringify(entries.map((entry) => entry.key).sort())
  )
    fail("BACKUP_PHOTO_FILE_SET_INVALID");
  for (const entry of entries) await readPhoto(join(base, entry.key), context.platform, entry);
  return entries;
}

export async function restorePhotos(context, backup) {
  if (backup.manifest.version === 1) return;
  const directory = join(context.root, "backups", backup.id);
  const entries = await readPhotoSnapshot(context, directory, backup.manifest.photos);
  const destination = join(context.root, "photos");
  await photoDirectory(context, destination, true);
  const existing = await inspectLivePhotos(context);
  const available = new Map(existing.map((entry) => [entry.key, entry]));
  const added = entries.filter((entry) => !available.has(entry.key));
  requirePhotoIndex([...existing, ...added]);
  for (const entry of entries) {
    const current = available.get(entry.key);
    if (current && (current.sha256 !== entry.sha256 || current.size !== entry.size))
      fail("BACKUP_PHOTO_COLLISION");
  }
  const space = await statfs(destination, { bigint: true });
  if (space.bavail * space.bsize < BigInt(added.reduce((sum, entry) => sum + entry.size, 0)))
    fail("BACKUP_SPACE_INSUFFICIENT");
  // Keep existing immutable files for rollback and the safety backup. Startup
  // sweeps unreferenced files only after maintenance is durably idle.
  for (const entry of entries)
    await copyPhoto(context, join(directory, "photos", entry.key), destination, entry);
  await verifyPhotoReferences(context, entries);
}
