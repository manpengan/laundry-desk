import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { composeCopyFromCommand } from "./compose.mjs";
import { createDatabaseBackup, LocalDataError, verifyBackupFile } from "./data-tools.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const PHOTO_STORE_MARKER = ".laundry-photo-store-v1";
const PHOTO_NAMESPACE = "delivery-evidence";
const PHOTO_NAME =
  /^(?:\.laundry-photo-store-v1|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp))$/u;
const SNAPSHOT_NAME = /^laundry-v2-(?:backup|pre-restore)-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump\.photos$/u;

const fail = (code, cause) => {
  throw new LocalDataError(code, cause === undefined ? undefined : { cause });
};

async function sha256File(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", rejectHash);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function writePrivateJson(path, value) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(path, code) {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o7777) !== DIRECTORY_MODE
  ) {
    fail(code);
  }
}

async function copyPrivateFile(source, destination) {
  const sourceMetadata = await lstat(source);
  if (
    sourceMetadata.isSymbolicLink() ||
    !sourceMetadata.isFile() ||
    (sourceMetadata.mode & 0o7777) !== FILE_MODE
  ) {
    fail("LOCAL_PHOTO_BACKUP_SOURCE_INVALID");
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, FILE_MODE);
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isFile() || destinationMetadata.size !== sourceMetadata.size) {
    fail("LOCAL_PHOTO_BACKUP_COPY_INVALID");
  }
  return Object.freeze({
    bytes: destinationMetadata.size,
    sha256: await sha256File(destination),
  });
}

async function inspectPrivateFile(path, code) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o7777) !== FILE_MODE) {
    fail(code);
  }
  return Object.freeze({
    bytes: metadata.size,
    sha256: await sha256File(path),
  });
}

function isPhotoPath(path) {
  if (typeof path !== "string") return false;
  if (PHOTO_NAME.test(path)) return true;
  const prefix = `${PHOTO_NAMESPACE}/`;
  return path.startsWith(prefix) && PHOTO_NAME.test(path.slice(prefix.length));
}

function photoFileCount(files) {
  return files.filter((file) => basename(file.name) !== PHOTO_STORE_MARKER).length;
}

async function inspectPhotoTree(rootPath, code) {
  const files = [];
  let hasNamespace = false;
  for (const name of (await readdir(rootPath)).sort()) {
    if (PHOTO_NAME.test(name)) {
      files.push(
        Object.freeze({ name, ...(await inspectPrivateFile(join(rootPath, name), code)) }),
      );
      continue;
    }
    if (name !== PHOTO_NAMESPACE) fail(code);
    hasNamespace = true;
    const namespacePath = join(rootPath, name);
    await assertPrivateDirectory(namespacePath, code);
    for (const child of (await readdir(namespacePath)).sort()) {
      if (!PHOTO_NAME.test(child)) fail(code);
      const relativePath = `${PHOTO_NAMESPACE}/${child}`;
      files.push(
        Object.freeze({
          name: relativePath,
          ...(await inspectPrivateFile(join(namespacePath, child), code)),
        }),
      );
    }
  }
  if (
    !files.some((file) => file.name === PHOTO_STORE_MARKER) ||
    (hasNamespace &&
      !files.some((file) => file.name === `${PHOTO_NAMESPACE}/${PHOTO_STORE_MARKER}`))
  ) {
    fail(code);
  }
  return Object.freeze(files);
}

async function createPhotoSnapshot(context, dumpPath, options, dependencies) {
  const snapshotName = `${basename(dumpPath)}.photos`;
  if (!SNAPSHOT_NAME.test(snapshotName)) fail("LOCAL_PHOTO_BACKUP_NAME_INVALID");
  const snapshotPath = join(context.backupDirectory, snapshotName);
  await mkdir(snapshotPath, { mode: DIRECTORY_MODE });
  const files = [];
  try {
    await dependencies.run(
      composeCopyFromCommand("server", "/var/lib/laundry/photos/.", snapshotPath, {
        project: context.project,
      }),
      Object.freeze({ cwd: options.cwd, env: context.env }),
    );
    await assertPrivateDirectory(snapshotPath, "LOCAL_PHOTO_BACKUP_DIRECTORY_INVALID");
    files.push(...(await inspectPhotoTree(snapshotPath, "LOCAL_PHOTO_BACKUP_SOURCE_INVALID")));
  } catch (error) {
    await rm(snapshotPath, { recursive: true, force: true });
    if (error instanceof LocalDataError) throw error;
    fail("LOCAL_PHOTO_BACKUP_FAILED", error);
  }
  return Object.freeze({
    path: snapshotPath,
    directory: snapshotName,
    files: Object.freeze(files),
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  });
}

export async function createDisasterRecoveryBackup(context, options, dependencies) {
  const database = await createDatabaseBackup(context, options, dependencies);
  let photos;
  try {
    photos = await createPhotoSnapshot(context, database.path, options, dependencies);
    const manifestPath = `${database.path}.bundle.json`;
    await writePrivateJson(manifestPath, {
      version: 1,
      instance_id: context.config.instanceId,
      created_at: options.createdAt ?? dependencies.now().toISOString(),
      database: {
        file: basename(database.path),
        sha256: database.sha256,
        bytes: database.bytes,
      },
      photos: {
        directory: photos.directory,
        bytes: photos.bytes,
        files: photos.files,
      },
    });
    return Object.freeze({
      path: database.path,
      sha256: await sha256File(manifestPath),
      database_sha256: database.sha256,
      bytes: database.bytes + photos.bytes,
      photo_files: photoFileCount(photos.files),
    });
  } catch (error) {
    if (photos !== undefined) await rm(photos.path, { recursive: true, force: true });
    await rm(database.path, { force: true });
    await rm(`${database.path}.json`, { force: true });
    if (error instanceof LocalDataError) throw error;
    fail("LOCAL_DISASTER_BACKUP_FAILED", error);
  }
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",")
  );
}

export async function verifyDisasterRecoveryBackup(context, inputPath, expectedSha256) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) fail("LOCAL_RESTORE_ARGS_INVALID");
  const candidate = resolve(inputPath);
  const candidateRelative = relative(context.backupDirectory, candidate);
  if (
    !isAbsolute(inputPath) ||
    candidateRelative.startsWith("..") ||
    isAbsolute(candidateRelative) ||
    dirname(candidate) !== context.backupDirectory
  ) {
    fail("LOCAL_RESTORE_FILE_FORBIDDEN");
  }
  const manifestPath = `${candidate}.bundle.json`;
  const manifestMetadata = await lstat(manifestPath).catch(() => null);
  if (
    manifestMetadata === null ||
    manifestMetadata.isSymbolicLink() ||
    !manifestMetadata.isFile() ||
    manifestMetadata.size < 1 ||
    manifestMetadata.size > 2_000_000 ||
    (manifestMetadata.mode & 0o7777) !== FILE_MODE ||
    (await sha256File(manifestPath)) !== expectedSha256
  ) {
    fail("LOCAL_RESTORE_BUNDLE_INVALID");
  }
  let manifest;
  try {
    const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      manifest = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    fail("LOCAL_RESTORE_BUNDLE_INVALID", error);
  }
  if (
    !exactKeys(manifest, ["version", "instance_id", "created_at", "database", "photos"]) ||
    manifest.version !== 1 ||
    manifest.instance_id !== context.config.instanceId ||
    !exactKeys(manifest.database, ["file", "sha256", "bytes"]) ||
    !exactKeys(manifest.photos, ["directory", "bytes", "files"]) ||
    manifest.database.file !== basename(candidate) ||
    !SNAPSHOT_NAME.test(manifest.photos.directory) ||
    !Array.isArray(manifest.photos.files)
  ) {
    fail("LOCAL_RESTORE_BUNDLE_INVALID");
  }
  const database = await verifyBackupFile(context, candidate, manifest.database.sha256);
  if (database.bytes !== manifest.database.bytes) fail("LOCAL_RESTORE_BUNDLE_INVALID");
  const snapshotPath = resolve(context.backupDirectory, manifest.photos.directory);
  if (
    basename(manifest.photos.directory) !== manifest.photos.directory ||
    dirname(snapshotPath) !== context.backupDirectory
  ) {
    fail("LOCAL_RESTORE_PHOTOS_INVALID");
  }
  await assertPrivateDirectory(snapshotPath, "LOCAL_RESTORE_PHOTOS_INVALID");
  const actualFiles = await inspectPhotoTree(snapshotPath, "LOCAL_RESTORE_PHOTOS_INVALID");
  if (
    new Set(manifest.photos.files.map((entry) => entry?.name)).size !==
      manifest.photos.files.length ||
    actualFiles.length !== manifest.photos.files.length
  ) {
    fail("LOCAL_RESTORE_PHOTOS_INVALID");
  }
  const actualByName = new Map(actualFiles.map((entry) => [entry.name, entry]));
  let totalBytes = 0;
  for (const entry of manifest.photos.files) {
    if (
      !exactKeys(entry, ["name", "bytes", "sha256"]) ||
      !isPhotoPath(entry.name) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      fail("LOCAL_RESTORE_PHOTOS_INVALID");
    }
    const actual = actualByName.get(entry.name);
    if (actual === undefined || actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      fail("LOCAL_RESTORE_PHOTOS_INVALID");
    }
    totalBytes += entry.bytes;
  }
  if (
    totalBytes !== manifest.photos.bytes ||
    !manifest.photos.files.some((entry) => entry.name === PHOTO_STORE_MARKER)
  ) {
    fail("LOCAL_RESTORE_PHOTOS_INVALID");
  }
  return Object.freeze({
    ...database,
    sha256: expectedSha256,
    database_sha256: database.sha256,
    snapshotPath,
    photo_files: photoFileCount(manifest.photos.files),
  });
}

export async function restorePhotoSnapshot(context, source) {
  const photoRoot = join(dirname(context.backupDirectory), "photos");
  await assertPrivateDirectory(photoRoot, "LOCAL_RESTORE_PHOTOS_INVALID");
  const suffix = randomUUID();
  const staging = `${photoRoot}.restore-${suffix}`;
  const previous = `${photoRoot}.previous-${suffix}`;
  await mkdir(staging, { mode: DIRECTORY_MODE });
  try {
    const files = await inspectPhotoTree(source.snapshotPath, "LOCAL_RESTORE_PHOTOS_INVALID");
    if (files.some((file) => file.name.startsWith(`${PHOTO_NAMESPACE}/`))) {
      await mkdir(join(staging, PHOTO_NAMESPACE), { mode: DIRECTORY_MODE });
    }
    for (const file of files) {
      await copyPrivateFile(join(source.snapshotPath, file.name), join(staging, file.name));
    }
    await rename(photoRoot, previous);
    try {
      await rename(staging, photoRoot);
    } catch (error) {
      await rename(previous, photoRoot);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof LocalDataError) throw error;
    fail("LOCAL_RESTORE_PHOTOS_FAILED", error);
  }
  return Object.freeze({ photo_files: source.photo_files });
}
