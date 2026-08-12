import { constants } from "node:fs";
import { chown, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  DATA_PROTECTION_PHOTO_MARKER,
  DATA_PROTECTION_PHOTO_ROOT,
} from "./hk-vps-data-protection-contract.mjs";
import { captureDataProtectionPhotos } from "./hk-vps-data-protection-files.mjs";
import { sha256DataProtectionFile } from "./hk-vps-data-protection-hash.mjs";
import { fail, requireSha } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import { LIVE_ROOT, readReleaseMarker } from "./hk-vps-release-remote-support.mjs";

const CODE_TREE =
  /^(?:laundry-desk|laundry-desk\.(?:failed|next)-[0-9a-f]{40}|laundry-desk\.rollback-[0-9a-f]{40}-before-[0-9a-f]{40}|laundry-desk\.rollback-pre-[0-9a-f]{7}-\d{8}T\d{6}Z)$/u;
const OPERATION_ID = /^[0-9a-f]{32}$/u;
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

function missing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

function requireOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) {
    fail("CLOUD_DATA_OPERATION_INVALID");
  }
  return value;
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertDirectory(path, identity, mode, code, dependencies = {}) {
  const metadata = await (dependencies.lstat ?? lstat)(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    (metadata.mode & 0o7777) !== mode ||
    (await (dependencies.realpath ?? realpath)(path).catch(() => null)) !== path
  ) {
    fail(code);
  }
  return metadata;
}

async function pathPresent(path, dependencies = {}) {
  try {
    await (dependencies.lstat ?? lstat)(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function cleanupRecoveryStaging(paths, remove, code) {
  let failure;
  for (const path of paths) {
    try {
      await remove(path, { force: true, recursive: true });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) fail(code, failure);
}

export async function findDataProtectionCodeTree(expectedSha, options = {}) {
  const sha = requireSha(expectedSha, "CLOUD_DATA_CODE_SHA_INVALID");
  const root = options.root ?? "/opt";
  const identity = options.identity ?? Object.freeze({ uid: 0, gid: 0 });
  const names = (await (options.readdir ?? readdir)(root)).filter((name) => CODE_TREE.test(name));
  const matches = [];
  for (const name of names.sort()) {
    const path = join(root, name);
    await assertDirectory(path, identity, 0o755, "CLOUD_DATA_CODE_TREE_INVALID", options);
    const marker = await (options.readReleaseMarker ?? readReleaseMarker)(path);
    if (marker.git_sha === sha) matches.push(path);
  }
  if (matches.length !== 1) fail("CLOUD_DATA_CODE_TREE_AMBIGUOUS");
  return matches[0];
}

function codeStagingPath(root, operationId) {
  return join(root, `laundry-desk.restore-${requireOperationId(operationId)}`);
}

export async function prepareDataProtectionCodeRestore(
  source,
  expectedSha,
  operationId,
  options = {},
) {
  const root = options.root ?? "/opt";
  const identity = options.identity ?? Object.freeze({ uid: 0, gid: 0 });
  const staging = codeStagingPath(root, operationId);
  if (await pathPresent(staging, options)) fail("CLOUD_DATA_CODE_STAGING_COLLISION");
  await (options.mkdir ?? mkdir)(staging, { mode: 0o755 });
  try {
    await (options.runCloudCommand ?? runCloudCommand)(
      "/usr/bin/cp",
      ["--archive", "--reflink=auto", "--one-file-system", `${source}/.`, staging],
      {
        cwd: "/",
        environment: COMMAND_ENVIRONMENT,
        label: "CLOUD_DATA_CODE_PREPARE",
        signal: options.signal,
        timeoutMs: 10 * 60_000,
      },
    );
    await assertDirectory(staging, identity, 0o755, "CLOUD_DATA_CODE_STAGING_INVALID", options);
    const marker = await (options.readReleaseMarker ?? readReleaseMarker)(staging);
    if (marker.git_sha !== requireSha(expectedSha)) fail("CLOUD_DATA_CODE_STAGING_INVALID");
    await (options.syncDirectory ?? syncDirectory)(root);
    return staging;
  } catch (error) {
    await cleanupRecoveryStaging(
      [staging],
      options.rm ?? rm,
      "CLOUD_DATA_CODE_STAGING_CLEANUP_FAILED",
    );
    throw error;
  }
}

function rollbackCodePath(root, currentSha, createdAt) {
  const timestamp =
    createdAt.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "") + "Z";
  return join(root, `laundry-desk.rollback-pre-${requireSha(currentSha).slice(0, 7)}-${timestamp}`);
}

export async function switchDataProtectionCode(staging, currentSha, createdAt, options = {}) {
  const root = options.root ?? "/opt";
  const live = options.liveRoot ?? LIVE_ROOT;
  const rollback = rollbackCodePath(root, currentSha, createdAt);
  if (await pathPresent(rollback, options)) fail("CLOUD_DATA_CODE_ROLLBACK_COLLISION");
  const marker = await (options.readReleaseMarker ?? readReleaseMarker)(live);
  if (marker.git_sha !== requireSha(currentSha)) fail("CLOUD_DATA_LIVE_CODE_INVALID");
  await (options.rename ?? rename)(live, rollback);
  await (options.syncDirectory ?? syncDirectory)(root);
  await (options.rename ?? rename)(staging, live);
  await (options.syncDirectory ?? syncDirectory)(root);
  return rollback;
}

export async function verifyDataProtectionRestoredPhotos(
  path,
  manifest,
  identity,
  dependencies = {},
) {
  await assertDirectory(path, identity, 0o700, "CLOUD_DATA_PHOTO_RESTORE_INVALID", dependencies);
  const expected = [
    DATA_PROTECTION_PHOTO_MARKER,
    ...manifest.photos.files.map((entry) => entry.storage_key),
  ].sort();
  const names = (await (dependencies.readdir ?? readdir)(path)).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail("CLOUD_DATA_PHOTO_RESTORE_INVALID");
  }
  for (const entry of manifest.photos.files) {
    const file = join(path, entry.storage_key);
    const metadata = await (dependencies.lstat ?? lstat)(file).catch(() => null);
    if (
      metadata === null ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== identity.uid ||
      metadata.gid !== identity.gid ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o7777) !== 0o600 ||
      metadata.size !== entry.bytes ||
      (await (dependencies.sha256File ?? sha256DataProtectionFile)(file)) !== entry.sha256
    ) {
      fail("CLOUD_DATA_PHOTO_RESTORE_INVALID");
    }
  }
}

export async function prepareDataProtectionPhotoRestore(
  verified,
  operationId,
  identity,
  options = {},
) {
  const photoRoot = options.photoRoot ?? DATA_PROTECTION_PHOTO_ROOT;
  const parent = dirname(photoRoot);
  const id = requireOperationId(operationId);
  const container = join(parent, `.photo-restore-${id}.tmp`);
  const staging = `${photoRoot}.restore-${id}`;
  if ((await pathPresent(container, options)) || (await pathPresent(staging, options))) {
    fail("CLOUD_DATA_PHOTO_STAGING_COLLISION");
  }
  await (options.mkdir ?? mkdir)(container, { mode: 0o700 });
  try {
    await (options.capturePhotos ?? captureDataProtectionPhotos)(
      container,
      verified.manifest.photos.files,
      {
        photoRoot: join(verified.setPath, verified.manifest.photos.directory),
        sourceIdentity: options.sourceIdentity ?? Object.freeze({ uid: 0, gid: 0 }),
      },
    );
    await (options.rename ?? rename)(join(container, "photos"), staging);
    await (options.rm ?? rm)(container, { recursive: true });
    for (const name of [
      DATA_PROTECTION_PHOTO_MARKER,
      ...verified.manifest.photos.files.map((entry) => entry.storage_key),
    ]) {
      await (options.chown ?? chown)(join(staging, name), identity.uid, identity.gid);
    }
    await (options.chown ?? chown)(staging, identity.uid, identity.gid);
    await verifyDataProtectionRestoredPhotos(staging, verified.manifest, identity, options);
    await (options.syncDirectory ?? syncDirectory)(parent);
    return staging;
  } catch (error) {
    await cleanupRecoveryStaging(
      [container, staging],
      options.rm ?? rm,
      "CLOUD_DATA_PHOTO_STAGING_CLEANUP_FAILED",
    );
    throw error;
  }
}

export async function switchDataProtectionPhotos(staging, operationId, options = {}) {
  const photoRoot = options.photoRoot ?? DATA_PROTECTION_PHOTO_ROOT;
  const parent = dirname(photoRoot);
  const previous = `${photoRoot}.previous-${requireOperationId(operationId)}`;
  if (
    basename(staging) !== `photos.restore-${operationId}` ||
    (await pathPresent(previous, options))
  ) {
    fail("CLOUD_DATA_PHOTO_SWITCH_INVALID");
  }
  const liveMetadata = await (options.lstat ?? lstat)(photoRoot).catch(() => null);
  const stagedMetadata = await (options.lstat ?? lstat)(staging).catch(() => null);
  if (liveMetadata === null || stagedMetadata === null || liveMetadata.dev !== stagedMetadata.dev) {
    fail("CLOUD_DATA_PHOTO_DEVICE_INVALID");
  }
  await (options.rename ?? rename)(photoRoot, previous);
  await (options.syncDirectory ?? syncDirectory)(parent);
  await (options.rename ?? rename)(staging, photoRoot);
  await (options.syncDirectory ?? syncDirectory)(parent);
  return previous;
}

export async function cleanupDataProtectionRecoveryPath(path, operationId, options = {}) {
  const id = requireOperationId(operationId);
  const allowed = new Set([
    codeStagingPath(options.codeRoot ?? "/opt", id),
    `${options.photoRoot ?? DATA_PROTECTION_PHOTO_ROOT}.restore-${id}`,
    `${options.photoRoot ?? DATA_PROTECTION_PHOTO_ROOT}.previous-${id}`,
  ]);
  if (!allowed.has(path)) fail("CLOUD_DATA_RECOVERY_PATH_INVALID");
  await (options.rm ?? rm)(path, { force: true, recursive: true });
}
