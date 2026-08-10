import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { fail } from "./hk-vps-release-core.mjs";
import { CONTROLLER_ROOT, assertControllerBinding } from "./hk-vps-release-controller-contract.mjs";
import { validateControllerDirectory } from "./hk-vps-release-controller-launcher.mjs";
import { readPrivateFile } from "./hk-vps-release-private-file.mjs";
import { HISTORY_ROOT, parseTransition } from "./hk-vps-release-remote-support.mjs";

const HISTORY = /^([0-9a-f]{40})-([0-9a-f]{32})-(committed|rolled_back)\.json$/u;
const CONTROLLER = /^[0-9a-f]{40}-[0-9a-f]{64}\.controller$/u;
const WORKSPACE = /^\.(?:controller-[0-9a-f]{32}\.tmp|cleanup-[0-9a-f]{32})$/u;

function missing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

async function assertRoot(path, uid, gid, allowMissing = false) {
  const metadata = await lstat(path).catch((error) => {
    if (allowMissing && missing(error)) return null;
    throw error;
  });
  if (metadata === null) return false;
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    (await realpath(path).catch(() => null)) !== path
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID");
  }
  return true;
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function historyRecords(dependencies) {
  const historyRoot = dependencies.historyRoot ?? HISTORY_ROOT;
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const names = (await (dependencies.readdir ?? readdir)(historyRoot)).sort();
  const records = [];
  for (const name of names) {
    const match = HISTORY.exec(name);
    if (match === null) fail("CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID");
    const source = await (dependencies.readHistory ?? readPrivateFile)(join(historyRoot, name), {
      code: "CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID",
      gid,
      maximumBytes: 64 * 1024,
      uid,
    });
    let record;
    try {
      record = parseTransition(JSON.parse(source));
    } catch (error) {
      fail("CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID", error);
    }
    if (
      source !== `${JSON.stringify(record)}\n` ||
      record.candidate_sha !== match[1] ||
      record.token !== match[2] ||
      record.outcome !== match[3]
    ) {
      fail("CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID");
    }
    records.push(record);
  }
  return Object.freeze(records);
}

function localControllerPath(root, record) {
  return join(root, basename(record.controller_path));
}

async function validateBoundController(root, record, uid, gid, dependencies) {
  assertControllerBinding(record);
  const controller = await (dependencies.validateController ?? validateControllerDirectory)(
    localControllerPath(root, record),
    { gid, uid },
  );
  if (
    controller.digest !== record.controller_sha256 ||
    controller.metadata.archive_sha256 !== record.archive_sha256 ||
    controller.metadata.candidate_sha !== record.candidate_sha ||
    controller.metadata.expected_sha !== record.expected_sha ||
    controller.metadata.migration_head !== record.migration_head
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID");
  }
}

export async function assertRetainedReleaseControllers(dependencies = {}) {
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const root = dependencies.controllerRoot ?? CONTROLLER_ROOT;
  const records = await (dependencies.records ?? historyRecords)(dependencies);
  const exists = await assertRoot(root, uid, gid, records.length === 0);
  if (!exists) return;
  const expected = new Set();
  for (const record of records) {
    const name = basename(record.controller_path);
    if (expected.has(name)) fail("CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID");
    expected.add(name);
    await validateBoundController(root, record, uid, gid, dependencies);
  }
  const names = (await (dependencies.readdir ?? readdir)(root)).sort();
  if (
    names.length !== expected.size ||
    names.some((name) => !expected.has(name)) ||
    names.some((name) => !CONTROLLER.test(name))
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID");
  }
}

async function assertRemovableTree(path, uid, gid, dependencies) {
  const metadata = await (dependencies.lstat ?? lstat)(path);
  if (
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.isDirectory()
      ? (metadata.mode & 0o7777) !== 0o700
      : !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o7777) !== 0o600)
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_CLEANUP_INVALID");
  }
  if (!metadata.isDirectory()) return;
  for (const name of await (dependencies.readdir ?? readdir)(path)) {
    await assertRemovableTree(join(path, name), uid, gid, dependencies);
  }
}

async function removeTree(path, root, uid, gid, dependencies) {
  await assertRemovableTree(path, uid, gid, dependencies);
  await (dependencies.rm ?? rm)(path, { recursive: true });
  await (dependencies.syncDirectory ?? syncDirectory)(root);
}

export async function cleanupUnboundReleaseControllers(dependencies = {}) {
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const root = dependencies.controllerRoot ?? CONTROLLER_ROOT;
  if (!(await assertRoot(root, uid, gid, true))) return;
  const records = await (dependencies.records ?? historyRecords)(dependencies);
  const retained = new Set(records.map((record) => basename(record.controller_path)));
  for (const name of (await (dependencies.readdir ?? readdir)(root)).sort()) {
    if (retained.has(name)) continue;
    const path = join(root, name);
    if (WORKSPACE.test(name)) {
      await removeTree(path, root, uid, gid, dependencies);
      continue;
    }
    if (!CONTROLLER.test(name)) fail("CLOUD_RELEASE_CONTROLLER_CLEANUP_INVALID");
    await (dependencies.validateController ?? validateControllerDirectory)(path, { gid, uid });
    const tombstone = join(root, `.cleanup-${randomBytes(16).toString("hex")}`);
    await (dependencies.rename ?? rename)(path, tombstone);
    await (dependencies.syncDirectory ?? syncDirectory)(root);
    await removeTree(tombstone, root, uid, gid, dependencies);
  }
}
