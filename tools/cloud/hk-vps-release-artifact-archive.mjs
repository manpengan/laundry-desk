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

import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import { readPrivateFile } from "./hk-vps-release-private-file.mjs";
import {
  HISTORY_ROOT,
  LIVE_ROOT,
  parseTransition,
  readReleaseMarker,
} from "./hk-vps-release-remote-support.mjs";

export const OPT_ROOT = "/opt";
export const ARCHIVE_ROOT = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.paths.archiveRoot;
export const ARTIFACT_PREFIX = "laundry-desk.";

const CODE = "CLOUD_RELEASE_ARTIFACT_ARCHIVE_INVALID";
const SHA = "[0-9a-f]{40}";
const HISTORY_NAME = new RegExp(`^${SHA}-[0-9a-f]{32}-(?:committed|rolled_back)\\.json$`, "u");
const SUPERSEDED_ROLLBACK = new RegExp(`^laundry-desk\\.rollback-${SHA}-before-${SHA}$`, "u");
const RETIRED_ARTIFACT = Object.freeze([
  new RegExp(`^laundry-desk\\.failed-${SHA}$`, "u"),
  new RegExp(`^laundry-desk\\.rollback-${SHA}-before-${SHA}$`, "u"),
  // Pre-history-system safety points, e.g. laundry-desk.rollback-pre-ae9808c-20260809T112330Z.
  // These predate the transition ledger and can only ever qualify as orphans.
  /^laundry-desk\.rollback-pre-[0-9a-f]{7}-\d{8}T\d{6}Z$/u,
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

// The orphan path exists only for trees the transition ledger never claimed — pre-ledger safety
// points, or artifacts whose history was archived long ago. It is strictly narrower than the bound
// path: ANY reference from ANY record disqualifies the tree, so a live or historical rollback
// target can never reach it. Requiring the artifact's own marker to differ from the live marker is
// a second, independent proof that it is not the running deployment.
function assertUnreferenced(source, records) {
  for (const record of records) {
    if (record.failed_path === source || record.rollback_path === source) fail(CODE);
  }
}

// This path is deliberately separate from rolled-back and orphan retirement. A successful release
// adds a committed rollback tree, so /opt otherwise grows monotonically until preflight can never
// prepare again. Only an older committed release may qualify; the live release always keeps its own
// immediate rollback tree and must itself have authoritative committed history.
function assertSupersededRollback(source, records, liveSha, markerSha) {
  const bound = records.filter(
    (record) => record.failed_path === source || record.rollback_path === source,
  );
  const committed = bound.filter(
    (record) =>
      record.rollback_path === source &&
      record.outcome === "committed" &&
      record.verification_evidence_authoritative === true,
  );
  if (committed.length !== 1 || typeof liveSha !== "string") fail(CODE);
  const [authority] = committed;
  if (authority.candidate_sha === liveSha || authority.expected_sha !== markerSha) fail(CODE);
  const allBindingsAgree = bound.every(
    (record) =>
      record.rollback_path === source &&
      record.candidate_sha === authority.candidate_sha &&
      record.expected_sha === authority.expected_sha &&
      (record === authority ||
        (record.outcome === "rolled_back" && record.verification_evidence_authoritative === false)),
  );
  if (!allBindingsAgree) {
    fail(CODE);
  }
  const liveIsCommitted = records.some(
    (other) =>
      other.outcome === "committed" &&
      other.verification_evidence_authoritative === true &&
      other.candidate_sha === liveSha,
  );
  if (!liveIsCommitted) fail(CODE);
  return authority.candidate_sha;
}

async function assertNotLiveTree(source, dependencies) {
  const read = use(dependencies, "readReleaseMarker", readReleaseMarker);
  const liveRoot = dependencies.liveRoot ?? LIVE_ROOT;
  if (source === liveRoot) fail(CODE);
  const live = await read(liveRoot).catch((error) => fail(CODE, error));
  const artifact = await read(source).catch((error) => fail(CODE, error));
  if (
    typeof live.git_sha !== "string" ||
    typeof artifact.git_sha !== "string" ||
    artifact.git_sha === live.git_sha
  ) {
    fail(CODE);
  }
  return artifact.git_sha;
}

// Symlinks are counted as leaves, never rejected and never followed. A deployed tree is a pnpm
// workspace: laundry-desk.rollback-pre-ae9808c-20260809T112330Z alone holds 2,688 node_modules
// symlinks. Rejecting them made the mover unable to archive any real artifact. lstat does not
// follow, and isDirectory() is false for a link, so the walk cannot escape the tree either way —
// and the rename moves links intact regardless of what they point at. The root is still required
// to be a real directory: assertOwnedDirectory checks isSymbolicLink() and realpath.
async function measureTree(path, dependencies) {
  const metadata = await use(dependencies, "lstat", lstat)(path);
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
async function resolveArchivePlan(name, dependencies) {
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
  return { archiveRoot, optRoot, records, source, target };
}

export async function planArtifactArchive(name, dependencies = {}) {
  const plan = await resolveArchivePlan(name, dependencies);
  const candidates = assertReleasedByHistory(plan.source, plan.records);
  return Object.freeze({
    archiveRoot: plan.archiveRoot,
    candidates,
    optRoot: plan.optRoot,
    source: plan.source,
    target: plan.target,
  });
}

/**
 * Verify that `name` is an orphan: retired by shape, referenced by no history record at all, and
 * carrying a release marker that differs from the live one. Read-only.
 *
 * Separate from planArtifactArchive on purpose — this path is for trees the ledger never claimed,
 * and it must never become a way to retire a rollback target that history still binds.
 */
export async function planOrphanArtifactArchive(name, dependencies = {}) {
  const plan = await resolveArchivePlan(name, dependencies);
  assertUnreferenced(plan.source, plan.records);
  const markerSha = await assertNotLiveTree(plan.source, dependencies);
  return Object.freeze({
    archiveRoot: plan.archiveRoot,
    markerSha,
    optRoot: plan.optRoot,
    source: plan.source,
    target: plan.target,
  });
}

/** Verify a committed rollback tree that a later committed live release has superseded. */
export async function planSupersededRollbackArchive(name, dependencies = {}) {
  if (typeof name !== "string" || !SUPERSEDED_ROLLBACK.test(name)) fail(CODE);
  const plan = await resolveArchivePlan(name, dependencies);
  const markerSha = await assertNotLiveTree(plan.source, dependencies);
  const live = await use(
    dependencies,
    "readReleaseMarker",
    readReleaseMarker,
  )(dependencies.liveRoot ?? LIVE_ROOT).catch((error) => fail(CODE, error));
  const candidate = assertSupersededRollback(plan.source, plan.records, live.git_sha, markerSha);
  return Object.freeze({
    archiveRoot: plan.archiveRoot,
    candidates: Object.freeze([candidate]),
    markerSha,
    optRoot: plan.optRoot,
    source: plan.source,
    target: plan.target,
  });
}

/** Archive a superseded committed rollback tree. Requires its own explicit authorization. */
export async function archiveSupersededRollback(name, dependencies = {}) {
  return moveArchivedTree(await planSupersededRollbackArchive(name, dependencies), dependencies);
}

/**
 * Archive a retired /opt artifact by atomic rename, then prove the moved tree is byte-for-byte the
 * same object. Never deletes; the inverse rename restores the previous layout.
 */
export async function archiveRetiredArtifact(name, dependencies = {}) {
  return moveArchivedTree(await planArtifactArchive(name, dependencies), dependencies);
}

/**
 * Archive an orphaned artifact. Same atomic rename and same-object proof as the bound path; only
 * the qualifying rule differs. Requires the caller to have obtained explicit authorisation — the
 * runner gates this behind its own subcommand rather than folding it into --archive.
 */
export async function archiveOrphanArtifact(name, dependencies = {}) {
  return moveArchivedTree(await planOrphanArtifactArchive(name, dependencies), dependencies);
}

async function moveArchivedTree(plan, dependencies) {
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
    // Bound archives report the candidate SHAs history tied to the tree; orphan archives have no
    // such binding and report the tree's own marker instead.
    candidates: plan.candidates ?? null,
    entries: after.entries,
    ino: moved.ino,
    markerSha: plan.markerSha ?? null,
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

/** Superseded committed rollback trees that pass the complete read-only plan. */
export async function listSupersededRollbacks(dependencies = {}) {
  const optRoot = dependencies.optRoot ?? OPT_ROOT;
  const records = await use(dependencies, "records", historyRecords)(dependencies);
  const names = (await use(dependencies, "readdir", readdir)(optRoot)).sort();
  const result = [];
  for (const name of names) {
    if (!SUPERSEDED_ROLLBACK.test(name)) continue;
    try {
      await planSupersededRollbackArchive(name, {
        ...dependencies,
        records: async () => records,
      });
      result.push(name);
    } catch {
      continue;
    }
  }
  return Object.freeze(result);
}
