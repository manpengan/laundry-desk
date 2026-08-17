import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

import { assertRetainedBackupIntegrity } from "./hk-vps-release-backup-retention.mjs";
import { CONTROLLER_ROOT } from "./hk-vps-release-controller-contract.mjs";
import { assertRetainedReleaseControllers } from "./hk-vps-release-controller-retention.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import { assertRetainedFinalizeEvidence } from "./hk-vps-release-evidence-retention.mjs";
import { releaseTokenDigest } from "./hk-vps-release-finalize-evidence.mjs";
import { readPrivateFile } from "./hk-vps-release-private-file.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import {
  BACKUP_ROOT,
  HISTORY_ROOT,
  LIVE_ROOT,
  STATE_ROOT,
  TRANSITION_PATH,
  parseTransition,
  readReleaseMarker,
  transitionExists,
} from "./hk-vps-release-remote-support.mjs";

export const RELEASE_ARCHIVE_ROOT = "/var/lib/laundry-desk-release-archive";
export const RELEASE_SET_ROOT = `${RELEASE_ARCHIVE_ROOT}/release-sets`;

const CODE = "CLOUD_RELEASE_SET_ARCHIVE_INVALID";
const HISTORY = /^([0-9a-f]{40})-([0-9a-f]{32})-(committed|rolled_back)\.json$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const OUTCOMES = new Set(["committed", "rolled_back"]);
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

function use(dependencies, name, fallback) {
  return dependencies[name] ?? fallback;
}

async function assertPrivateDirectory(path, uid, gid, mode, dependencies) {
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(path).catch((error) => fail(CODE, error));
  const canonical = await use(dependencies, "realpath", realpath)(path).catch(() => null);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== mode ||
    canonical !== path
  ) {
    fail(CODE);
  }
}

export async function assertNoReleaseTransition(dependencies = {}) {
  const exists = await use(dependencies, "transitionExists", transitionExists)();
  if (exists) fail("CLOUD_RELEASE_SET_TRANSITION_ACTIVE");
}

export async function readActiveReleaseHistory(dependencies = {}) {
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const historyRoot = dependencies.historyRoot ?? HISTORY_ROOT;
  await assertPrivateDirectory(historyRoot, uid, gid, 0o700, dependencies);
  const names = (await use(dependencies, "readdir", readdir)(historyRoot)).sort();
  const entries = [];
  for (const name of names) {
    const match = HISTORY.exec(name);
    if (match === null) fail(CODE);
    const path = join(historyRoot, name);
    const source = await use(
      dependencies,
      "readHistory",
      readPrivateFile,
    )(path, {
      code: CODE,
      gid,
      maximumBytes: 64 * 1024,
      uid,
    });
    let record;
    try {
      record = parseTransition(JSON.parse(source));
    } catch (error) {
      fail(CODE, error);
    }
    if (
      source !== `${JSON.stringify(record)}\n` ||
      record.candidate_sha !== match[1] ||
      record.token !== match[2] ||
      record.outcome !== match[3]
    ) {
      fail(CODE);
    }
    entries.push(Object.freeze({ name, path, record, source }));
  }
  return Object.freeze(entries);
}

async function resolvePostgresGid(dependencies) {
  if (Number.isSafeInteger(dependencies.postgresGid) && dependencies.postgresGid >= 0) {
    return dependencies.postgresGid;
  }
  const result = await use(dependencies, "runCloudCommand", runCloudCommand)(
    "/usr/bin/id",
    ["-g", "postgres"],
    Object.freeze({
      cwd: "/",
      environment: COMMAND_ENVIRONMENT,
      label: "CLOUD_RELEASE_SET_POSTGRES_GID",
      timeoutMs: 2 * 60_000,
    }),
  );
  if (!/^\d+\n?$/u.test(result.stdout)) fail("CLOUD_RELEASE_POSTGRES_IDENTITY_INVALID");
  const value = Number(result.stdout.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("CLOUD_RELEASE_POSTGRES_IDENTITY_INVALID");
  }
  return value;
}

export async function assertActiveReleaseSetIntegrity(dependencies = {}) {
  await assertNoReleaseTransition(dependencies);
  const entries = await readActiveReleaseHistory(dependencies);
  const records = Object.freeze(entries.map(({ record }) => record));
  const shared = { ...dependencies, records: async () => records };
  await use(dependencies, "assertControllers", assertRetainedReleaseControllers)(shared);
  await use(
    dependencies,
    "assertBackups",
    assertRetainedBackupIntegrity,
  )({
    ...shared,
    postgresGid: await resolvePostgresGid(dependencies),
  });
  await use(dependencies, "assertEvidence", assertRetainedFinalizeEvidence)(dependencies);
  return entries;
}

function localOptPath(path, dependencies) {
  return join(dependencies.optRoot ?? "/opt", basename(path));
}

async function anyReferencedTreeExists(record, dependencies) {
  for (const path of [record.staging_path, record.failed_path, record.rollback_path]) {
    const metadata = await use(
      dependencies,
      "lstat",
      lstat,
    )(localOptPath(path, dependencies)).catch((error) => {
      if (error instanceof Error && error.code === "ENOENT") return null;
      return fail(CODE, error);
    });
    if (metadata !== null) return true;
  }
  return false;
}

async function isQualified(entry, entries, liveSha, dependencies) {
  const { record } = entry;
  if (record.candidate_sha === liveSha || (await anyReferencedTreeExists(record, dependencies))) {
    return false;
  }
  if (record.outcome === "rolled_back") {
    return record.verification_evidence_authoritative === false;
  }
  if (record.outcome !== "committed" || record.verification_evidence_authoritative !== true) {
    return false;
  }
  return entries.some(
    ({ record: current }) =>
      current.candidate_sha === liveSha &&
      current.outcome === "committed" &&
      current.verification_evidence_authoritative === true,
  );
}

export async function listReleaseSetCandidates(dependencies = {}) {
  const entries = await assertActiveReleaseSetIntegrity(dependencies);
  const live = await use(
    dependencies,
    "readReleaseMarker",
    readReleaseMarker,
  )(dependencies.liveRoot ?? LIVE_ROOT).catch((error) => fail(CODE, error));
  const candidates = [];
  for (const entry of entries) {
    if (!(await isQualified(entry, entries, live.git_sha, dependencies))) continue;
    candidates.push(
      Object.freeze({
        candidateSha: entry.record.candidate_sha,
        outcome: entry.record.outcome,
        tokenSha256: releaseTokenDigest(entry.record.token),
      }),
    );
  }
  return Object.freeze(candidates);
}

export async function selectReleaseSet(identity, dependencies = {}) {
  if (
    typeof identity !== "object" ||
    identity === null ||
    !SHA.test(identity.candidateSha) ||
    !DIGEST.test(identity.tokenSha256) ||
    !OUTCOMES.has(identity.outcome)
  ) {
    fail(CODE);
  }
  const entries = await assertActiveReleaseSetIntegrity(dependencies);
  const live = await use(
    dependencies,
    "readReleaseMarker",
    readReleaseMarker,
  )(dependencies.liveRoot ?? LIVE_ROOT).catch((error) => fail(CODE, error));
  const matches = entries.filter(
    ({ record }) =>
      record.candidate_sha === identity.candidateSha &&
      record.outcome === identity.outcome &&
      releaseTokenDigest(record.token) === identity.tokenSha256,
  );
  if (
    matches.length !== 1 ||
    !(await isQualified(matches[0], entries, live.git_sha, dependencies))
  ) {
    fail(CODE);
  }
  return matches[0];
}

export function releaseSetRoots(dependencies = {}) {
  return Object.freeze({
    archiveRoot: dependencies.archiveRoot ?? RELEASE_ARCHIVE_ROOT,
    backupRoot: dependencies.backupRoot ?? BACKUP_ROOT,
    controllerRoot: dependencies.controllerRoot ?? CONTROLLER_ROOT,
    historyRoot: dependencies.historyRoot ?? HISTORY_ROOT,
    setRoot: dependencies.setRoot ?? RELEASE_SET_ROOT,
    stateRoot: dependencies.stateRoot ?? STATE_ROOT,
    transitionPath: dependencies.transitionPath ?? TRANSITION_PATH,
  });
}
