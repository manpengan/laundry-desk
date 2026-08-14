// Recoverable archive for retired /opt release artifacts.
//
// The release preflight fails closed at MAX_RETAINED_RELEASES instead of deleting anything, so
// retiring an artifact is a deliberate, separately authorised step. This module only ever performs
// a same-filesystem atomic rename into a root-only archive root: nothing is deleted, and the
// inverse rename restores the previous layout exactly.
//
// It refuses any artifact that is not provably bound to rolled-back, non-authoritative history —
// in particular the rollback tree of the live release, whose history record is `committed`.

import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";

import { fail } from "./hk-vps-release-core.mjs";
import { readPrivateFile } from "./hk-vps-release-private-file.mjs";
import { HISTORY_ROOT, parseTransition } from "./hk-vps-release-remote-support.mjs";

export const OPT_ROOT = "/opt";
export const ARCHIVE_ROOT = "/var/lib/laundry-desk-release-archive";
export const ARTIFACT_PREFIX = "laundry-desk.";

const CODE = "CLOUD_RELEASE_ARTIFACT_ARCHIVE_INVALID";
const SHA = "[0-9a-f]{40}";
const HISTORY_NAME = new RegExp(`^${SHA}-[0-9a-f]{32}-(?:committed|rolled_back)\\.json$`, "u");
const RETIRED_ARTIFACT = Object.freeze([
  new RegExp(`^laundry-desk\\.failed-${SHA}$`, "u"),
  new RegExp(`^laundry-desk\\.rollback-${SHA}-before-${SHA}$`, "u"),
]);

function use(dependencies, name, fallback) {
  return dependencies[name] ?? fallback;
}

async function assertOwnedDirectory(path, mode, dependencies) {
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(path).catch((error) => fail(CODE, error));
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== mode ||
    (await use(dependencies, "realpath", realpath)(path).catch(() => null)) !== path
  ) {
    fail(CODE);
  }
  return metadata;
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
  const root = dependencies.historyRoot ?? HISTORY_ROOT;
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const names = (await use(dependencies, "readdir", readdir)(root)).sort();
  const records = [];
  for (const name of names) {
    if (!HISTORY_NAME.test(name)) fail(CODE);
    const source = await use(
      dependencies,
      "readHistory",
      readPrivateFile,
    )(join(root, name), {
      code: CODE,
      gid,
      maximumBytes: 64 * 1024,
      uid,
    });
    try {
      records.push(parseTransition(JSON.parse(source)));
    } catch (error) {
      fail(CODE, error);
    }
  }
  return Object.freeze(records);
}

function assertRetiredName(name) {
  if (typeof name !== "string" || !name.startsWith(ARTIFACT_PREFIX)) fail(CODE);
  if (!RETIRED_ARTIFACT.some((pattern) => pattern.test(name))) fail(CODE);
}

// An artifact may only be archived when every history record that binds it is rolled back and
// carries no authoritative verification evidence. Unbound artifacts are refused outright: without a
// record there is nothing proving the tree is retired rather than load-bearing.
function assertReleasedByHistory(source, records) {
  const bound = records.filter(
    (record) => record.failed_path === source || record.rollback_path === source,
  );
  if (bound.length === 0) fail(CODE);
  for (const record of bound) {
    if (record.outcome !== "rolled_back") fail(CODE);
    if (record.verification_evidence_authoritative !== false) fail(CODE);
  }
  return Object.freeze(bound.map((record) => record.candidate_sha));
}

async function measureTree(path, dependencies) {
  const metadata = await use(dependencies, "lstat", lstat)(path);
  if (metadata.isSymbolicLink()) fail(CODE);
  let entries = 1;
  let bytes = metadata.size;
  if (metadata.isDirectory()) {
    for (const name of (await use(dependencies, "readdir", readdir)(path)).sort()) {
      const nested = await measureTree(join(path, name), dependencies);
      entries += nested.entries;
      bytes += nested.bytes;
    }
  }
  return Object.freeze({ bytes, entries });
}

async function assertAbsent(path, dependencies) {
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(path).catch((error) => {
    if (error instanceof Error && error.code === "ENOENT") return null;
    return fail(CODE, error);
  });
  if (metadata !== null) fail(CODE);
}

/**
 * Verify that `name` under /opt may be archived. Read-only: performs every ownership, binding and
 * filesystem check and returns the resolved plan without touching the tree.
 */
export async function planArtifactArchive(name, dependencies = {}) {
  assertRetiredName(name);
  const optRoot = dependencies.optRoot ?? OPT_ROOT;
  const archiveRoot = dependencies.archiveRoot ?? ARCHIVE_ROOT;
  const source = join(optRoot, name);
  const target = join(archiveRoot, name.slice(ARTIFACT_PREFIX.length));
  const opt = await assertOwnedDirectory(optRoot, 0o755, dependencies);
  const archive = await assertOwnedDirectory(archiveRoot, 0o700, dependencies);
  // A cross-device move would be a copy: not atomic, and a partial failure would leave two trees.
  if (opt.dev !== archive.dev) fail(CODE);
  await assertOwnedDirectory(source, 0o755, dependencies);
  await assertAbsent(target, dependencies);
  const records = await use(dependencies, "records", historyRecords)(dependencies);
  const candidates = assertReleasedByHistory(source, records);
  return Object.freeze({ archiveRoot, candidates, optRoot, source, target });
}

/**
 * Archive a retired /opt artifact by atomic rename, then prove the moved tree is byte-for-byte the
 * same object. Never deletes; the inverse rename restores the previous layout.
 */
export async function archiveRetiredArtifact(name, dependencies = {}) {
  const plan = await planArtifactArchive(name, dependencies);
  const before = await measureTree(plan.source, dependencies);
  const identity = await use(dependencies, "lstat", lstat)(plan.source);
  await use(dependencies, "rename", rename)(plan.source, plan.target);
  const sync = use(dependencies, "syncDirectory", syncDirectory);
  await sync(plan.optRoot);
  await sync(plan.archiveRoot);
  await assertAbsent(plan.source, dependencies);
  const after = await measureTree(plan.target, dependencies);
  const moved = await use(dependencies, "lstat", lstat)(plan.target);
  if (
    after.entries !== before.entries ||
    after.bytes !== before.bytes ||
    moved.dev !== identity.dev ||
    moved.ino !== identity.ino
  ) {
    fail(CODE);
  }
  return Object.freeze({
    bytes: after.bytes,
    candidates: plan.candidates,
    entries: after.entries,
    ino: moved.ino,
    source: plan.source,
    target: plan.target,
  });
}

/** Retired artifacts under /opt that history proves are archivable, sorted by name. */
export async function listArchivableArtifacts(dependencies = {}) {
  const optRoot = dependencies.optRoot ?? OPT_ROOT;
  const records = await use(dependencies, "records", historyRecords)(dependencies);
  const names = (await use(dependencies, "readdir", readdir)(optRoot)).sort();
  const archivable = [];
  for (const name of names) {
    if (!name.startsWith(ARTIFACT_PREFIX)) continue;
    if (!RETIRED_ARTIFACT.some((pattern) => pattern.test(name))) continue;
    try {
      assertReleasedByHistory(join(optRoot, name), records);
    } catch {
      continue;
    }
    archivable.push(name);
  }
  return Object.freeze(archivable);
}
