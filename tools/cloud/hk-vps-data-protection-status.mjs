import {
  DATA_PROTECTION_BACKUP_MAX_AGE_SECONDS,
  DATA_PROTECTION_DRILL_MAX_AGE_SECONDS,
  DATA_PROTECTION_STATUS_PATH,
  requireDataProtectionSetId,
} from "./hk-vps-data-protection-contract.mjs";
import { readDataProtectionLiveEvidence } from "./hk-vps-data-protection-db.mjs";
import {
  verifyDataProtectionSet,
  writeDataProtectionJson,
} from "./hk-vps-data-protection-files.mjs";
import { assertDataProtectionOffsite } from "./hk-vps-data-protection-offsite.mjs";
import {
  readDataProtectionOperation,
  readDataProtectionState,
} from "./hk-vps-data-protection-state.mjs";
import { inspectRetainedDataProtectionSets } from "./hk-vps-data-protection-storage.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import { assertSharedInfrastructure } from "./hk-vps-release-host-guard.mjs";
import { assertDeskHealth } from "./hk-vps-release-remote-system.mjs";
import { transitionExists } from "./hk-vps-release-remote-support.mjs";
import { inspectDatabaseWriteGate } from "./hk-vps-release-write-gate.mjs";

const CHECK_NAMES = Object.freeze([
  "operation_clear",
  "release_clear",
  "last_failure_clear",
  "backup_fresh",
  "offsite_fresh",
  "drill_fresh",
  "backup_verified",
  "offsite_verified",
  "offsite_attested",
  "drill_set_verified",
  "write_gate_open",
  "service_healthy",
  "source_compatible",
]);

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",")
  );
}

function requireTimestamp(value) {
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    fail("CLOUD_DATA_STATUS_INVALID");
  }
  return date;
}

export function dataProtectionAgeSeconds(value, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("CLOUD_DATA_STATUS_INVALID");
  }
  const seconds = Math.floor((now.getTime() - requireTimestamp(value).getTime()) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) fail("CLOUD_DATA_STATUS_CLOCK_INVALID");
  return seconds;
}

function nullableAge(entry, now) {
  return entry === null ? null : dataProtectionAgeSeconds(entry.completed_at, now);
}

function setReference(entry) {
  return entry === null
    ? null
    : Object.freeze({
        set_id: entry.set_id,
        manifest_sha256: entry.manifest_sha256,
      });
}

function requireChecks(value) {
  if (!exactKeys(value, CHECK_NAMES)) fail("CLOUD_DATA_STATUS_INVALID");
  const result = {};
  for (const name of CHECK_NAMES) {
    if (typeof value[name] !== "boolean") fail("CLOUD_DATA_STATUS_INVALID");
    result[name] = value[name];
  }
  return Object.freeze(result);
}

export function createDataProtectionStatusReport(input) {
  if (
    !exactKeys(input, ["generated_at", "checks", "ages_seconds", "latest"]) ||
    !exactKeys(input.ages_seconds, ["backup", "offsite", "drill"]) ||
    !exactKeys(input.latest, ["backup", "offsite", "drill"])
  ) {
    fail("CLOUD_DATA_STATUS_INVALID");
  }
  requireTimestamp(input.generated_at);
  const checks = requireChecks(input.checks);
  for (const age of Object.values(input.ages_seconds)) {
    if (age !== null && (!Number.isSafeInteger(age) || age < 0)) {
      fail("CLOUD_DATA_STATUS_INVALID");
    }
  }
  for (const reference of Object.values(input.latest)) {
    if (
      reference !== null &&
      (!exactKeys(reference, ["set_id", "manifest_sha256"]) ||
        typeof reference.set_id !== "string" ||
        typeof reference.manifest_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(reference.manifest_sha256))
    ) {
      fail("CLOUD_DATA_STATUS_INVALID");
    }
    if (reference !== null) requireDataProtectionSetId(reference.set_id);
  }
  return Object.freeze({
    schema: "laundry.cloud-data-protection.status",
    version: 1,
    generated_at: input.generated_at,
    healthy: Object.values(checks).every(Boolean),
    delivery_state: checks.offsite_attested ? "externally_verified" : "software_only",
    blockers: Object.freeze(checks.offsite_attested ? [] : ["blocked_external_offsite"]),
    checks,
    ages_seconds: Object.freeze({ ...input.ages_seconds }),
    latest: Object.freeze({ ...input.latest }),
  });
}

function findStateSet(retained, stateEntry) {
  if (stateEntry === null) return null;
  const matches = retained.sets.filter(
    (entry) =>
      entry.manifest.set_id === stateEntry.set_id &&
      entry.manifestSha256 === stateEntry.manifest_sha256,
  );
  return matches.length === 1 ? matches[0] : null;
}

function migrationMatches(manifest, live) {
  return (
    manifest.code_sha === live.codeSha &&
    manifest.migration.head === live.migration.head &&
    manifest.migration.count === live.migration.count &&
    manifest.migration.ledger_sha256 === live.migration.ledger_sha256 &&
    manifest.migration.catalog_sha256 === live.migration.catalog_sha256
  );
}

async function checked(action) {
  try {
    return (await action()) !== false;
  } catch {
    return false;
  }
}

export async function runDataProtectionStatus(options = {}, dependencies = {}) {
  const now = dependencies.now?.() ?? new Date();
  const state = await (dependencies.readState ?? readDataProtectionState)();
  const retained = await (dependencies.inspectSets ?? inspectRetainedDataProtectionSets)({
    reserveSlot: false,
  });
  const backup = findStateSet(retained, state.last_backup);
  const drill = findStateSet(retained, state.last_drill);
  const ages = Object.freeze({
    backup: nullableAge(state.last_backup, now),
    offsite: nullableAge(state.last_offsite, now),
    drill: nullableAge(state.last_drill, now),
  });
  let offsite;
  const checks = {
    operation_clear: await checked(
      async () => (await (dependencies.readOperation ?? readDataProtectionOperation)()) === null,
    ),
    release_clear: await checked(
      async () => !(await (dependencies.transitionExists ?? transitionExists)()),
    ),
    last_failure_clear: Object.values(state.last_failure).every((entry) => entry === null),
    backup_fresh: ages.backup !== null && ages.backup <= DATA_PROTECTION_BACKUP_MAX_AGE_SECONDS,
    offsite_fresh: ages.offsite !== null && ages.offsite <= DATA_PROTECTION_BACKUP_MAX_AGE_SECONDS,
    drill_fresh: ages.drill !== null && ages.drill <= DATA_PROTECTION_DRILL_MAX_AGE_SECONDS,
    backup_verified: backup !== null,
    offsite_verified: await checked(async () => {
      if (state.last_offsite === null) return false;
      offsite = await (dependencies.assertOffsite ?? assertDataProtectionOffsite)({
        sourceRoot: retained.root,
        signal: options.signal,
      });
      const verified = await (dependencies.verifySet ?? verifyDataProtectionSet)(
        `${offsite.setsRoot}/${state.last_offsite.set_id}`,
        { identity: offsite.identity, expectedSetId: state.last_offsite.set_id },
      );
      return (
        verified.manifestSha256 === state.last_offsite.manifest_sha256 &&
        offsite.targetId === state.last_offsite.target_id &&
        offsite.failureDomain === state.last_offsite.failure_domain &&
        offsite.remoteIdentity === state.last_offsite.remote_identity &&
        state.last_backup !== null &&
        state.last_offsite.set_id === state.last_backup.set_id &&
        state.last_offsite.manifest_sha256 === state.last_backup.manifest_sha256
      );
    }),
    offsite_attested: offsite?.deploymentProof === true,
    drill_set_verified: drill !== null,
    write_gate_open: await checked(async () => {
      await (dependencies.inspectWriteGate ?? inspectDatabaseWriteGate)(options.signal);
    }),
    service_healthy: await checked(async () => {
      if (backup === null) return false;
      await (dependencies.assertDeskHealth ?? assertDeskHealth)(
        backup.manifest.code_sha,
        options.signal,
      );
      await (dependencies.assertSharedInfrastructure ?? assertSharedInfrastructure)(options.signal);
    }),
    source_compatible: await checked(async () => {
      if (backup === null) return false;
      const live = await (dependencies.readLiveEvidence ?? readDataProtectionLiveEvidence)(
        options.signal,
      );
      return migrationMatches(backup.manifest, live);
    }),
  };
  const report = createDataProtectionStatusReport({
    generated_at: now.toISOString(),
    checks,
    ages_seconds: ages,
    latest: {
      backup: setReference(state.last_backup),
      offsite: setReference(state.last_offsite),
      drill: setReference(state.last_drill),
    },
  });
  await (dependencies.writeJson ?? writeDataProtectionJson)(
    options.statusPath ?? DATA_PROTECTION_STATUS_PATH,
    report,
    { replace: true, code: "CLOUD_DATA_STATUS_WRITE_FAILED" },
  );
  return report;
}

export function formatDataProtectionPrometheus(report) {
  const parsed = createDataProtectionStatusReport({
    generated_at: report.generated_at,
    checks: report.checks,
    ages_seconds: report.ages_seconds,
    latest: report.latest,
  });
  const lines = [
    "# TYPE laundry_data_protection_healthy gauge",
    `laundry_data_protection_healthy ${parsed.healthy ? 1 : 0}`,
  ];
  for (const name of CHECK_NAMES) {
    lines.push(`laundry_data_protection_check_${name} ${parsed.checks[name] ? 1 : 0}`);
  }
  for (const name of ["backup", "offsite", "drill"]) {
    lines.push(`laundry_data_protection_${name}_age_seconds ${parsed.ages_seconds[name] ?? -1}`);
  }
  return `${lines.join("\n")}\n`;
}
