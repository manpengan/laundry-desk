import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";
import {
  fail,
  requireDigest,
  requireMigrationHead,
  requireSha,
  requireToken,
} from "./hk-vps-release-core.mjs";
import {
  assertControllerBinding,
  releaseControllerPath,
} from "./hk-vps-release-controller-contract.mjs";
import { isTransitionEvidenceStateValid } from "./hk-vps-release-finalize-evidence.mjs";
import { isTransitionWriteGateStateValid } from "./hk-vps-release-write-gate.mjs";

export {
  assertMigrationLedger,
  isOldCodeCompatible,
  migrationInventory,
  parseMigrationLedger,
  readCompatibilityPolicy,
  resolveCompatibility,
} from "./hk-vps-release-remote-migrations.mjs";

const PROFILE = DEFAULT_CLOUD_ENVIRONMENT_PROFILE;

export const LIVE_ROOT = PROFILE.paths.liveRoot;
export const STATE_ROOT = PROFILE.paths.releaseStateRoot;
export const HISTORY_ROOT = `${STATE_ROOT}/history`;
export const TRANSITION_PATH = `${STATE_ROOT}/transition.json`;
export const BACKUP_ROOT = PROFILE.paths.releaseBackupRoot;
export const SERVICE_NAME = PROFILE.services.desk;
export const ENV_FILE = PROFILE.paths.serverEnvironmentFile;
export const RELEASE_ENVIRONMENT = PROFILE.environmentMarker;

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PHASES = new Set([
  "staged",
  "write_frozen",
  "recovery_ready",
  "migrating",
  "switched",
  "awaiting_external_verification",
  "recovery_required",
]);
const TRANSITION_KEYS = Object.freeze([
  "app_role_original_can_login",
  "archive_sha256",
  "backup_path",
  "backup_sha256",
  "candidate_sha",
  "compatibility_decision",
  "controller_path",
  "controller_sha256",
  "created_at",
  "expected_sha",
  "failed_path",
  "migration_head",
  "old_code_compatible",
  "outcome",
  "phase",
  "pre_migration_count",
  "pre_migration_head",
  "pre_migration_ledger_sha256",
  "rollback_path",
  "shadow_database",
  "source_catalog_sha256",
  "staging_path",
  "token",
  "updated_at",
  "verification_evidence_authoritative",
  "verification_evidence_path",
  "verification_evidence_sha256",
  "version",
  "write_freeze_terminated_sessions",
  "write_freeze_verified_at",
  "write_gate_state",
]);

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function releasePaths(candidateSha, expectedSha) {
  const candidate = requireSha(candidateSha);
  const expected = requireSha(expectedSha);
  return Object.freeze({
    failed: `${LIVE_ROOT}.failed-${candidate}`,
    rollback: `${LIVE_ROOT}.rollback-${expected}-before-${candidate}`,
    staging: `${LIVE_ROOT}.next-${candidate}`,
  });
}

export function createTransition(input, now = new Date()) {
  const candidate = requireSha(input.candidateSha);
  const expected = requireSha(input.expectedSha);
  const token = requireToken(input.token);
  const migrationHead = requireMigrationHead(input.migrationHead);
  const archiveDigest = requireDigest(input.archiveDigest);
  const controllerDigest = requireDigest(input.controllerDigest);
  const controllerPath = releaseControllerPath(candidate, token);
  if (input.controllerPath !== controllerPath) fail("CLOUD_RELEASE_CONTROLLER_BINDING_INVALID");
  const paths = releasePaths(candidate, expected);
  const timestamp = now.toISOString();
  return Object.freeze({
    app_role_original_can_login: null,
    archive_sha256: archiveDigest,
    backup_path: null,
    backup_sha256: null,
    candidate_sha: candidate,
    compatibility_decision: null,
    controller_path: controllerPath,
    controller_sha256: controllerDigest,
    created_at: timestamp,
    expected_sha: expected,
    failed_path: paths.failed,
    migration_head: migrationHead,
    old_code_compatible: null,
    outcome: null,
    phase: "staged",
    pre_migration_count: null,
    pre_migration_head: null,
    pre_migration_ledger_sha256: null,
    rollback_path: paths.rollback,
    shadow_database: null,
    source_catalog_sha256: null,
    staging_path: paths.staging,
    token,
    updated_at: timestamp,
    verification_evidence_authoritative: null,
    verification_evidence_path: null,
    verification_evidence_sha256: null,
    version: 1,
    write_freeze_terminated_sessions: null,
    write_freeze_verified_at: null,
    write_gate_state: null,
  });
}

export function parseTransition(value) {
  if (!exactKeys(value, TRANSITION_KEYS)) fail("CLOUD_RELEASE_TRANSITION_INVALID");
  const paths = releasePaths(value.candidate_sha, value.expected_sha);
  requireToken(value.token);
  requireMigrationHead(value.migration_head);
  const hasBackup =
    value.backup_path !== null && value.backup_sha256 !== null && value.shadow_database !== null;
  const freezeValues = [
    value.pre_migration_head,
    value.pre_migration_count,
    value.pre_migration_ledger_sha256,
    value.source_catalog_sha256,
    value.write_freeze_terminated_sessions,
    value.write_freeze_verified_at,
  ];
  const hasPreMigration = freezeValues.every((item) => item !== null);
  const hasCompatibility =
    typeof value.old_code_compatible === "boolean" &&
    typeof value.compatibility_decision === "string" &&
    /^(ADR-\d+|same_migration|unproven)$/u.test(value.compatibility_decision);
  const preFreezeRecovery =
    value.phase === "recovery_required" && !hasPreMigration && !hasCompatibility;
  const timestampsValid = [value.created_at, value.updated_at].every(isCanonicalTimestamp);
  const backupMatch =
    typeof value.backup_path === "string"
      ? /^\/var\/lib\/laundry-desk-release-backups\/pre-([0-9a-f]{40})-[0-9a-f]{32}\.dump$/u.exec(
          value.backup_path,
        )
      : null;
  if (
    value.version !== 1 ||
    !PHASES.has(value.phase) ||
    value.staging_path !== paths.staging ||
    value.rollback_path !== paths.rollback ||
    value.failed_path !== paths.failed ||
    !timestampsValid ||
    [value.backup_path, value.backup_sha256, value.shadow_database].some(
      (item) => (item === null) !== !hasBackup,
    ) ||
    freezeValues.some((item) => (item === null) !== !hasPreMigration) ||
    (value.old_code_compatible === null) !== (value.compatibility_decision === null) ||
    (value.old_code_compatible !== null && !hasCompatibility) ||
    (value.phase !== "staged" && !preFreezeRecovery && !hasPreMigration) ||
    (value.phase !== "staged" && !preFreezeRecovery && !hasCompatibility) ||
    (["recovery_ready", "migrating", "switched", "awaiting_external_verification"].includes(
      value.phase,
    ) &&
      !hasBackup) ||
    (value.backup_path !== null && backupMatch?.[1] !== value.candidate_sha) ||
    (value.backup_path !== null &&
      value.shadow_database !== shadowDatabaseName(value.backup_path)) ||
    (value.backup_sha256 !== null && !DIGEST.test(value.backup_sha256)) ||
    !isTransitionEvidenceStateValid(value) ||
    !isTransitionWriteGateStateValid(value) ||
    (value.pre_migration_ledger_sha256 !== null &&
      !DIGEST.test(value.pre_migration_ledger_sha256)) ||
    (value.source_catalog_sha256 !== null && !DIGEST.test(value.source_catalog_sha256)) ||
    (value.pre_migration_head !== null && !MIGRATION_NAME.test(value.pre_migration_head)) ||
    (value.pre_migration_count !== null &&
      (!Number.isSafeInteger(value.pre_migration_count) || value.pre_migration_count < 1)) ||
    (value.write_freeze_terminated_sessions !== null &&
      (!Number.isSafeInteger(value.write_freeze_terminated_sessions) ||
        value.write_freeze_terminated_sessions < 0)) ||
    (value.write_freeze_verified_at !== null &&
      !isCanonicalTimestamp(value.write_freeze_verified_at))
  ) {
    fail("CLOUD_RELEASE_TRANSITION_INVALID");
  }
  try {
    assertControllerBinding(value);
  } catch (error) {
    fail("CLOUD_RELEASE_TRANSITION_INVALID", error);
  }
  return Object.freeze({ ...value });
}

export function updateTransition(record, changes, now = new Date()) {
  return parseTransition({ ...record, ...changes, updated_at: now.toISOString() });
}

async function assertDirectory(path, uid, gid, mode, code) {
  const metadata = await lstat(path).catch(() => null);
  const canonical = metadata === null ? null : await realpath(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== mode ||
    canonical !== path
  ) {
    fail(code);
  }
}

export async function ensureReleaseDirectories() {
  await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  await mkdir(HISTORY_ROOT, { recursive: true, mode: 0o700 });
  await assertDirectory(STATE_ROOT, 0, 0, 0o700, "CLOUD_RELEASE_STATE_ROOT_INVALID");
  await assertDirectory(HISTORY_ROOT, 0, 0, 0o700, "CLOUD_RELEASE_HISTORY_ROOT_INVALID");
}

async function writePrivateJson(path, value) {
  const temporary = join(dirname(path), `.transition-${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    fail("CLOUD_RELEASE_TRANSITION_WRITE_FAILED", error);
  }
}

export async function transitionExists() {
  try {
    await lstat(TRANSITION_PATH);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readTransition() {
  const metadata = await lstat(TRANSITION_PATH).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o7777) !== 0o600 ||
    metadata.size < 2 ||
    metadata.size > 64 * 1024
  ) {
    fail("CLOUD_RELEASE_TRANSITION_INVALID");
  }
  try {
    return parseTransition(JSON.parse(await readFile(TRANSITION_PATH, "utf8")));
  } catch (error) {
    fail("CLOUD_RELEASE_TRANSITION_INVALID", error);
  }
}

export async function persistTransition(record) {
  await ensureReleaseDirectories();
  await writePrivateJson(TRANSITION_PATH, parseTransition(record));
}

export async function assertOrdinaryDirectory(path, expectedMode = 0o755) {
  await assertDirectory(path, 0, 0, expectedMode, "CLOUD_RELEASE_DIRECTORY_INVALID");
}

export async function readReleaseMarker(root) {
  const path = join(root, ".laundry-release.json");
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o7777) !== 0o644 ||
    metadata.size < 2 ||
    metadata.size > 4_096
  ) {
    fail("CLOUD_RELEASE_MARKER_INVALID");
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("CLOUD_RELEASE_MARKER_INVALID", error);
  }
  if (!exactKeys(value, ["environment", "git_sha"]) || value.environment !== RELEASE_ENVIRONMENT) {
    fail("CLOUD_RELEASE_MARKER_INVALID");
  }
  requireSha(value.git_sha, "CLOUD_RELEASE_MARKER_INVALID");
  return Object.freeze({ ...value });
}

export function createBackupPath(candidateSha) {
  const suffix = randomBytes(16).toString("hex");
  return join(BACKUP_ROOT, `pre-${requireSha(candidateSha)}-${suffix}.dump`);
}

export function assertBackupDirectory(path, metadata, canonical, postgresGid, root = false) {
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    (root
      ? metadata.gid !== postgresGid || (metadata.mode & 0o7777) !== 0o710
      : metadata.gid !== 0 || (metadata.mode & 0o022) !== 0) ||
    canonical !== path
  ) {
    fail("CLOUD_RELEASE_BACKUP_ROOT_INVALID");
  }
}

export function assertPrivateBackupFile(metadata, allowEmpty = false) {
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o7777) !== 0o600 ||
    (!allowEmpty && metadata.size < 1)
  ) {
    fail("CLOUD_RELEASE_BACKUP_INVALID");
  }
}

export function backupManifestPath(backupPath) {
  if (
    dirname(backupPath) !== BACKUP_ROOT ||
    !/^pre-[0-9a-f]{40}-[0-9a-f]{32}\.dump$/u.test(basename(backupPath))
  ) {
    fail("CLOUD_RELEASE_BACKUP_PATH_INVALID");
  }
  return `${backupPath}.json`;
}

export function shadowDatabaseName(backupPath) {
  backupManifestPath(backupPath);
  const suffix = basename(backupPath).slice(-37, -5);
  return `laundry_release_verify_${suffix}`;
}
