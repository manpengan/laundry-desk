import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  DATA_PROTECTION_PHOTO_MARKER,
  DATA_PROTECTION_PHOTO_MARKER_CONTENT,
  DATA_PROTECTION_PHOTO_ROOT,
  DATA_PROTECTION_ROOT,
  DATA_PROTECTION_SET_ROOT,
  dataProtectionSetPath,
  parseDataProtectionManifest,
  parseDataProtectionVerification,
  requireDataProtectionSetId,
  requirePhotoStorageKey,
} from "./hk-vps-data-protection-contract.mjs";
import { sha256DataProtectionFile } from "./hk-vps-data-protection-hash.mjs";
import { fail } from "./hk-vps-release-core.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024 * 1024;

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function photoInventoryDigest(files) {
  return createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex");
}

async function assertDirectory(path, identity, code) {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    (metadata.mode & 0o7777) !== DIRECTORY_MODE ||
    (await realpath(path).catch(() => null)) !== path
  ) {
    fail(code);
  }
  return metadata;
}

async function assertPrivateFile(path, identity, code, maximumBytes, allowEmpty = false) {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o7777) !== FILE_MODE ||
    (!allowEmpty && metadata.size < 1) ||
    metadata.size > maximumBytes ||
    (await realpath(path).catch(() => null)) !== path
  ) {
    fail(code);
  }
  return metadata;
}

export async function ensureDataProtectionRoots(dependencies = {}) {
  const root = dependencies.root ?? DATA_PROTECTION_ROOT;
  const setRoot = dependencies.setRoot ?? DATA_PROTECTION_SET_ROOT;
  const identity = dependencies.identity ?? Object.freeze({ uid: 0, gid: 0 });
  const makeDirectory = dependencies.mkdir ?? mkdir;
  await makeDirectory(root, { recursive: true, mode: DIRECTORY_MODE });
  await makeDirectory(setRoot, { recursive: true, mode: DIRECTORY_MODE });
  await assertDirectory(root, identity, "CLOUD_DATA_ROOT_INVALID");
  await assertDirectory(setRoot, identity, "CLOUD_DATA_SET_ROOT_INVALID");
  if (dirname(setRoot) !== root) fail("CLOUD_DATA_SET_ROOT_INVALID");
  return Object.freeze({ root, setRoot });
}

export async function writeDataProtectionJson(path, value, options = {}) {
  const temporary = join(dirname(path), `.data-${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.replace === true) await rename(temporary, path);
    else {
      await link(temporary, path);
      await unlink(temporary);
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    fail(options.code ?? "CLOUD_DATA_JSON_WRITE_FAILED", error);
  }
}

export async function readDataProtectionJsonFile(path, options = {}) {
  const identity = options.identity ?? Object.freeze({ uid: 0, gid: 0 });
  const code = options.code ?? "CLOUD_DATA_JSON_INVALID";
  const metadata = await assertPrivateFile(path, identity, code, MAX_JSON_BYTES);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      fail(code);
    }
    const source = await handle.readFile("utf8");
    if (Buffer.byteLength(source) !== metadata.size) fail(code);
    return Object.freeze({ source, value: JSON.parse(source) });
  } catch (error) {
    if (error?.code?.startsWith?.("CLOUD_")) throw error;
    fail(code, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function copyVerifiedFile(source, destination, expected, sourceIdentity) {
  const metadata = await assertPrivateFile(
    source,
    sourceIdentity,
    "CLOUD_DATA_PHOTO_SOURCE_INVALID",
    8 * 1024 * 1024,
  );
  if (metadata.size !== expected.bytes) fail("CLOUD_DATA_PHOTO_SOURCE_INVALID");
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await sourceHandle.stat();
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      fail("CLOUD_DATA_PHOTO_SOURCE_INVALID");
    }
    const bytes = await sourceHandle.readFile();
    if (
      bytes.byteLength !== expected.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256
    ) {
      fail("CLOUD_DATA_PHOTO_SOURCE_INVALID");
    }
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    await destinationHandle.writeFile(bytes);
    await destinationHandle.sync();
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    if (error?.code?.startsWith?.("CLOUD_")) throw error;
    fail("CLOUD_DATA_PHOTO_COPY_FAILED", error);
  } finally {
    await sourceHandle?.close().catch(() => undefined);
    await destinationHandle?.close().catch(() => undefined);
  }
}

async function copyPhotoMarker(source, destination, sourceIdentity) {
  const metadata = await assertPrivateFile(
    source,
    sourceIdentity,
    "CLOUD_DATA_PHOTO_ROOT_INVALID",
    128,
  );
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      (await handle.readFile("utf8")) !== DATA_PROTECTION_PHOTO_MARKER_CONTENT
    ) {
      fail("CLOUD_DATA_PHOTO_ROOT_INVALID");
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let target;
  try {
    target = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    await target.writeFile(DATA_PROTECTION_PHOTO_MARKER_CONTENT, "utf8");
    await target.sync();
  } finally {
    await target?.close().catch(() => undefined);
  }
}

export async function captureDataProtectionPhotos(setDirectory, inputFiles, options = {}) {
  const photoRoot = options.photoRoot ?? DATA_PROTECTION_PHOTO_ROOT;
  const sourceIdentity = options.sourceIdentity;
  if (
    sourceIdentity === undefined ||
    !Number.isSafeInteger(sourceIdentity.uid) ||
    !Number.isSafeInteger(sourceIdentity.gid)
  ) {
    fail("CLOUD_DATA_PHOTO_IDENTITY_INVALID");
  }
  await assertDirectory(photoRoot, sourceIdentity, "CLOUD_DATA_PHOTO_ROOT_INVALID");
  const files = [...inputFiles].sort((left, right) =>
    left.storage_key.localeCompare(right.storage_key),
  );
  if (new Set(files.map((entry) => entry.storage_key)).size !== files.length) {
    fail("CLOUD_DATA_PHOTO_INVENTORY_INVALID");
  }
  const destination = join(setDirectory, "photos");
  await mkdir(destination, { mode: DIRECTORY_MODE });
  await copyPhotoMarker(
    join(photoRoot, DATA_PROTECTION_PHOTO_MARKER),
    join(destination, DATA_PROTECTION_PHOTO_MARKER),
    sourceIdentity,
  );
  for (const entry of files) {
    requirePhotoStorageKey(entry.storage_key);
    await copyVerifiedFile(
      join(photoRoot, entry.storage_key),
      join(destination, entry.storage_key),
      entry,
      sourceIdentity,
    );
  }
  await syncDirectory(destination);
  return Object.freeze({
    directory: "photos",
    count: files.length,
    bytes: files.reduce((total, entry) => total + entry.bytes, 0),
    inventory_sha256: photoInventoryDigest(files),
    files: Object.freeze(files.map((entry) => Object.freeze({ ...entry }))),
  });
}

async function verifyPhotoDirectory(setPath, manifest, identity) {
  const directory = join(setPath, manifest.photos.directory);
  await assertDirectory(directory, identity, "CLOUD_DATA_PHOTO_SNAPSHOT_INVALID");
  const expected = [
    DATA_PROTECTION_PHOTO_MARKER,
    ...manifest.photos.files.map((entry) => entry.storage_key),
  ].sort();
  const names = (await readdir(directory)).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail("CLOUD_DATA_PHOTO_SNAPSHOT_INVALID");
  }
  const marker = await readDataProtectionJsonMarker(
    join(directory, DATA_PROTECTION_PHOTO_MARKER),
    identity,
  );
  if (marker !== DATA_PROTECTION_PHOTO_MARKER_CONTENT) {
    fail("CLOUD_DATA_PHOTO_SNAPSHOT_INVALID");
  }
  for (const entry of manifest.photos.files) {
    const path = join(directory, entry.storage_key);
    const metadata = await assertPrivateFile(
      path,
      identity,
      "CLOUD_DATA_PHOTO_SNAPSHOT_INVALID",
      8 * 1024 * 1024,
    );
    if (
      metadata.size !== entry.bytes ||
      (await sha256DataProtectionFile(path, {
        code: "CLOUD_DATA_PHOTO_SNAPSHOT_INVALID",
      })) !== entry.sha256
    ) {
      fail("CLOUD_DATA_PHOTO_SNAPSHOT_INVALID");
    }
  }
  if (photoInventoryDigest(manifest.photos.files) !== manifest.photos.inventory_sha256) {
    fail("CLOUD_DATA_PHOTO_SNAPSHOT_INVALID");
  }
}

async function readDataProtectionJsonMarker(path, identity) {
  const metadata = await assertPrivateFile(
    path,
    identity,
    "CLOUD_DATA_PHOTO_SNAPSHOT_INVALID",
    128,
  );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      fail("CLOUD_DATA_PHOTO_SNAPSHOT_INVALID");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function verifyDataProtectionSet(setPath, options = {}) {
  const identity = options.identity ?? Object.freeze({ uid: 0, gid: 0 });
  const setId =
    options.expectedSetId === undefined
      ? requireDataProtectionSetId(basename(setPath))
      : requireDataProtectionSetId(options.expectedSetId);
  await assertDirectory(setPath, identity, "CLOUD_DATA_SET_INVALID");
  const manifestRead = await readDataProtectionJsonFile(join(setPath, "manifest.json"), {
    identity,
    code: "CLOUD_DATA_MANIFEST_INVALID",
  });
  const manifest = parseDataProtectionManifest(manifestRead.value);
  if (manifest.set_id !== setId || manifestRead.source !== `${JSON.stringify(manifest)}\n`) {
    fail("CLOUD_DATA_MANIFEST_INVALID");
  }
  const manifestSha256 = createHash("sha256").update(manifestRead.source).digest("hex");
  const dumpPath = join(setPath, manifest.database.file);
  const dump = await assertPrivateFile(
    dumpPath,
    identity,
    "CLOUD_DATA_DATABASE_INVALID",
    MAX_DATABASE_BYTES,
  );
  if (
    dump.size !== manifest.database.bytes ||
    (await sha256DataProtectionFile(dumpPath, {
      code: "CLOUD_DATA_DATABASE_INVALID",
    })) !== manifest.database.sha256
  ) {
    fail("CLOUD_DATA_DATABASE_INVALID");
  }
  await verifyPhotoDirectory(setPath, manifest, identity);
  let verification = null;
  if (options.requireVerification !== false) {
    const read = await readDataProtectionJsonFile(join(setPath, "verification.json"), {
      identity,
      code: "CLOUD_DATA_VERIFICATION_INVALID",
    });
    verification = parseDataProtectionVerification(read.value);
    if (
      read.source !== `${JSON.stringify(verification)}\n` ||
      verification.set_id !== setId ||
      verification.manifest_sha256 !== manifestSha256 ||
      verification.migration_ledger_sha256 !== manifest.migration.ledger_sha256 ||
      verification.catalog_sha256 !== manifest.migration.catalog_sha256 ||
      verification.photo_inventory_sha256 !== manifest.photos.inventory_sha256
    ) {
      fail("CLOUD_DATA_VERIFICATION_INVALID");
    }
  }
  const expectedNames = [
    "database.dump",
    "manifest.json",
    "photos",
    ...(options.requireVerification === false ? [] : ["verification.json"]),
  ].sort();
  const names = (await readdir(setPath)).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    fail("CLOUD_DATA_SET_INVALID");
  }
  return Object.freeze({ dumpPath, manifest, manifestSha256, setPath, verification });
}

export async function publishDataProtectionSet(stagingPath, setId, options = {}) {
  const root = options.setRoot ?? DATA_PROTECTION_SET_ROOT;
  const target = dataProtectionSetPath(setId, root);
  try {
    await rename(stagingPath, target);
    await syncDirectory(root);
  } catch (error) {
    fail("CLOUD_DATA_SET_PUBLISH_FAILED", error);
  }
  return target;
}
