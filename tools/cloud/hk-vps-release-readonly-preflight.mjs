import { assertDataProtectionLockHeld } from "./hk-vps-data-protection-lock.mjs";
import { CloudReleaseError, fail, requireSha } from "./hk-vps-release-core.mjs";
import {
  MAX_RETAINED_RELEASES,
  MINIMUM_RELEASE_FREE_BYTES,
  readReleaseHostSnapshot,
} from "./hk-vps-release-host-guard.mjs";
import { assertActiveReleaseSetIntegrity } from "./hk-vps-release-set-inventory.mjs";
import {
  LIVE_ROOT,
  RELEASE_ENVIRONMENT,
  readReleaseMarker,
  transitionExists,
} from "./hk-vps-release-remote-support.mjs";

export const STABLE_OPT_RESERVED_SLOTS = 2;

const SNAPSHOT_KEYS = Object.freeze(
  [
    "artifactRoom",
    "backupRoom",
    "backupSetsActive",
    "controllerActive",
    "evidenceActive",
    "historyActive",
    "historyRoom",
    "liveSha",
    "optAvailableBytes",
    "optPreparePeak",
    "optReserved",
    "optResident",
    "phase",
    "postgresqlAvailableBytes",
  ].sort(),
);
const HOST_KEYS = Object.freeze(
  ["historyActive", "optAvailableBytes", "optResident", "postgresqlAvailableBytes"].sort(),
);

function use(dependencies, name, fallback) {
  return dependencies[name] ?? fallback;
}

function exactKeys(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function stableCall(operation, code) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CloudReleaseError) throw error;
    fail(code, error);
  }
}

async function assertStableTransition(dependencies) {
  let exists;
  try {
    exists = await use(dependencies, "transitionExists", transitionExists)();
  } catch (error) {
    fail("CLOUD_RELEASE_SET_TRANSITION_ACTIVE", error);
  }
  if (exists !== false) fail("CLOUD_RELEASE_SET_TRANSITION_ACTIVE");
}

function activeCounts(entries) {
  if (!Array.isArray(entries)) fail("CLOUD_RELEASE_SET_ARCHIVE_INVALID");
  let backupSetsActive = 0;
  let evidenceActive = 0;
  for (const entry of entries) {
    const record = entry?.record;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof record !== "object" ||
      record === null ||
      Array.isArray(record) ||
      typeof record.controller_path !== "string" ||
      !(
        record.backup_path === null ||
        (typeof record.backup_path === "string" && record.backup_path !== "")
      ) ||
      !(
        record.verification_evidence_path === null ||
        (typeof record.verification_evidence_path === "string" &&
          record.verification_evidence_path !== "")
      )
    ) {
      fail("CLOUD_RELEASE_SET_ARCHIVE_INVALID");
    }
    if (record.backup_path !== null) backupSetsActive += 1;
    if (record.verification_evidence_path !== null) evidenceActive += 1;
  }
  return Object.freeze({ backupSetsActive, evidenceActive, historyActive: entries.length });
}

function requireHostSnapshot(value) {
  if (
    !exactKeys(value, HOST_KEYS) ||
    !isCount(value.historyActive) ||
    !isCount(value.optAvailableBytes) ||
    !isCount(value.optResident) ||
    !isCount(value.postgresqlAvailableBytes)
  ) {
    fail("CLOUD_RELEASE_CAPACITY_INVALID");
  }
  return value;
}

function requireMarker(value) {
  if (!exactKeys(value, ["environment", "git_sha"]) || value.environment !== RELEASE_ENVIRONMENT) {
    fail("CLOUD_RELEASE_MARKER_INVALID");
  }
  return requireSha(value.git_sha, "CLOUD_RELEASE_MARKER_INVALID");
}

export function requireReadonlyReleaseSnapshot(value) {
  if (
    !exactKeys(value, SNAPSHOT_KEYS) ||
    value.phase !== "stable" ||
    value.optReserved !== STABLE_OPT_RESERVED_SLOTS ||
    !isCount(value.optResident) ||
    value.optPreparePeak !== value.optResident + value.optReserved ||
    !isCount(value.optPreparePeak) ||
    !isCount(value.historyActive) ||
    value.controllerActive !== value.historyActive ||
    !isCount(value.backupSetsActive) ||
    value.backupSetsActive > value.historyActive ||
    !isCount(value.evidenceActive) ||
    value.evidenceActive > value.historyActive ||
    !isCount(value.optAvailableBytes) ||
    !isCount(value.postgresqlAvailableBytes) ||
    value.artifactRoom !== value.optPreparePeak < MAX_RETAINED_RELEASES ||
    value.historyRoom !== value.historyActive < MAX_RETAINED_RELEASES ||
    value.backupRoom !== value.backupSetsActive < MAX_RETAINED_RELEASES
  ) {
    fail("CLOUD_RELEASE_SET_ARCHIVE_INVALID");
  }
  requireSha(value.liveSha, "CLOUD_RELEASE_MARKER_INVALID");
  return value;
}

export async function readReadonlyReleaseSnapshot(signal, dependencies = {}) {
  await stableCall(
    async () =>
      await use(dependencies, "assertLockHeld", assertDataProtectionLockHeld)(dependencies),
    "CLOUD_DATA_LOCK_REQUIRED",
  );
  await assertStableTransition(dependencies);
  const entries = await stableCall(
    async () =>
      await use(
        dependencies,
        "assertActiveReleaseSetIntegrity",
        assertActiveReleaseSetIntegrity,
      )(dependencies),
    "CLOUD_RELEASE_SET_ARCHIVE_INVALID",
  );
  const counts = activeCounts(entries);
  const liveSha = requireMarker(
    await stableCall(
      async () =>
        await use(
          dependencies,
          "readReleaseMarker",
          readReleaseMarker,
        )(dependencies.liveRoot ?? LIVE_ROOT),
      "CLOUD_RELEASE_MARKER_INVALID",
    ),
  );
  const host = requireHostSnapshot(
    await stableCall(
      async () =>
        await use(
          dependencies,
          "readReleaseHostSnapshot",
          readReleaseHostSnapshot,
        )(signal, dependencies),
      "CLOUD_RELEASE_CAPACITY_INVALID",
    ),
  );
  if (host.historyActive !== counts.historyActive) {
    fail("CLOUD_RELEASE_HISTORY_RETENTION_INVALID");
  }
  const optPreparePeak = host.optResident + STABLE_OPT_RESERVED_SLOTS;
  return requireReadonlyReleaseSnapshot(
    Object.freeze({
      artifactRoom: optPreparePeak < MAX_RETAINED_RELEASES,
      backupRoom: counts.backupSetsActive < MAX_RETAINED_RELEASES,
      backupSetsActive: counts.backupSetsActive,
      controllerActive: counts.historyActive,
      evidenceActive: counts.evidenceActive,
      historyActive: counts.historyActive,
      historyRoom: counts.historyActive < MAX_RETAINED_RELEASES,
      liveSha,
      optAvailableBytes: host.optAvailableBytes,
      optPreparePeak,
      optReserved: STABLE_OPT_RESERVED_SLOTS,
      optResident: host.optResident,
      phase: "stable",
      postgresqlAvailableBytes: host.postgresqlAvailableBytes,
    }),
  );
}

export function assertReadonlyReleasePreflight(snapshot) {
  const value = requireReadonlyReleaseSnapshot(snapshot);
  if (
    value.optAvailableBytes < MINIMUM_RELEASE_FREE_BYTES ||
    value.postgresqlAvailableBytes < MINIMUM_RELEASE_FREE_BYTES
  ) {
    fail("CLOUD_RELEASE_CAPACITY_LOW");
  }
  if (!value.artifactRoom) fail("CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT");
  if (!value.historyRoom) fail("CLOUD_RELEASE_HISTORY_RETENTION_LIMIT");
  if (!value.backupRoom) fail("CLOUD_RELEASE_BACKUP_RETENTION_LIMIT");
}

export function formatReadonlyReleaseSnapshot(action, snapshot) {
  const value = requireReadonlyReleaseSnapshot(snapshot);
  const prefix =
    action === "inventory"
      ? "CLOUD_RELEASE_INVENTORY_OK"
      : action === "preflight"
        ? "CLOUD_RELEASE_PREFLIGHT_OK"
        : fail("CLOUD_RELEASE_SET_ARGS_INVALID");
  return (
    `${prefix} phase=${value.phase} live_sha=${value.liveSha} ` +
    `opt_resident=${value.optResident} opt_reserved=${value.optReserved} ` +
    `opt_prepare_peak=${value.optPreparePeak} history_active=${value.historyActive} ` +
    `controller_active=${value.controllerActive} backup_sets_active=${value.backupSetsActive} ` +
    `evidence_active=${value.evidenceActive} opt_available_bytes=${value.optAvailableBytes} ` +
    `postgresql_available_bytes=${value.postgresqlAvailableBytes} ` +
    `artifact_room=${value.artifactRoom} history_room=${value.historyRoom} ` +
    `backup_room=${value.backupRoom}\n`
  );
}
