import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  releaseTokenDigest,
  verificationEvidencePath,
} from "./hk-vps-release-finalize-evidence.mjs";
import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";

import {
  assertMigrationLedger,
  backupManifestPath,
  createTransition,
  isOldCodeCompatible,
  migrationInventory,
  parseMigrationLedger,
  parseTransition,
  readCompatibilityPolicy,
  releasePaths,
  resolveCompatibility,
  shadowDatabaseName,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "a".repeat(40);
const OTHER_CANDIDATE = "c".repeat(40);
const EXPECTED = "b".repeat(40);
const TOKEN = "d".repeat(32);
const MIGRATION_1 = "0045_cloud_auth.sql";
const MIGRATION_2 = "0046_cloud_primary.sql";
const DIGEST_1 = "1".repeat(64);
const DIGEST_2 = "2".repeat(64);
const ARCHIVE_DIGEST = "3".repeat(64);
const CONTROLLER_DIGEST = "4".repeat(64);

function transition() {
  return createTransition(
    {
      archiveDigest: ARCHIVE_DIGEST,
      candidateSha: CANDIDATE,
      controllerDigest: CONTROLLER_DIGEST,
      controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
      expectedSha: EXPECTED,
      migrationHead: MIGRATION_2,
      token: TOKEN,
    },
    new Date("2026-08-10T01:02:03.000Z"),
  );
}

function recoveryRecord() {
  const backupPath = `/var/lib/laundry-desk-release-backups/pre-${CANDIDATE}-1234567890abcdef1234567890abcdef.dump`;
  return updateTransition(
    transition(),
    {
      app_role_original_can_login: true,
      backup_path: backupPath,
      backup_sha256: "e".repeat(64),
      compatibility_decision: "ADR-37",
      old_code_compatible: true,
      phase: "recovery_ready",
      pre_migration_count: 45,
      pre_migration_head: MIGRATION_1,
      pre_migration_ledger_sha256: "f".repeat(64),
      shadow_database: shadowDatabaseName(backupPath),
      source_catalog_sha256: "9".repeat(64),
      write_freeze_terminated_sessions: 2,
      write_freeze_verified_at: "2026-08-10T01:02:30.000Z",
      write_gate_state: "active",
    },
    new Date("2026-08-10T01:03:03.000Z"),
  );
}

test("transition creation derives frozen exact paths and canonical timestamps", () => {
  const record = transition();
  assert.equal(Object.isFrozen(record), true);
  assert.deepEqual(
    {
      failed: record.failed_path,
      rollback: record.rollback_path,
      staging: record.staging_path,
    },
    releasePaths(CANDIDATE, EXPECTED),
  );
  assert.equal(record.created_at, "2026-08-10T01:02:03.000Z");
  assert.equal(record.updated_at, record.created_at);
  assert.equal(record.archive_sha256, ARCHIVE_DIGEST);
  assert.equal(record.controller_sha256, CONTROLLER_DIGEST);
});

test("transition schema rejects additions, mismatched paths, and incomplete phase evidence", () => {
  const record = transition();
  for (const invalid of [
    { ...record, surprise: true },
    { ...record, archive_sha256: null },
    { ...record, controller_path: `${record.controller_path}.other` },
    { ...record, staging_path: "/opt/laundry-desk" },
    { ...record, phase: "recovery_ready" },
    { ...record, pre_migration_count: 45 },
    { ...record, pre_migration_count: 0, pre_migration_head: MIGRATION_1 },
    { ...recoveryRecord(), shadow_database: "laundry_release_verify_deadbeef" },
    { ...record, created_at: "not-a-date" },
  ]) {
    assert.throws(() => parseTransition(invalid), {
      code: "CLOUD_RELEASE_TRANSITION_INVALID",
    });
  }
  assert.equal(parseTransition(recoveryRecord()).phase, "recovery_ready");
});

test("rolled-back history records require a released gate even when their phase was active", () => {
  const archived = updateTransition(recoveryRecord(), {
    outcome: "rolled_back",
    verification_evidence_authoritative: false,
    write_gate_state: "released",
  });
  assert.equal(parseTransition(archived).outcome, "rolled_back");
  assert.throws(
    () =>
      parseTransition({
        ...archived,
        write_gate_state: "active",
      }),
    { code: "CLOUD_RELEASE_TRANSITION_INVALID" },
  );
});

test("transition backup evidence is bound to the candidate and private backup namespace", () => {
  const record = recoveryRecord();
  assert.throws(
    () =>
      parseTransition({
        ...record,
        backup_path: `/var/lib/laundry-desk-release-backups/pre-${OTHER_CANDIDATE}-1234567890abcdef1234567890abcdef.dump`,
      }),
    { code: "CLOUD_RELEASE_TRANSITION_INVALID" },
  );
  assert.equal(backupManifestPath(record.backup_path), `${record.backup_path}.json`);
  for (const path of [
    "/var/lib/laundry-desk-release-backups/arbitrary.dump",
    "/var/lib/laundry-desk-release-backups/../arbitrary.dump",
  ]) {
    assert.throws(() => backupManifestPath(path), {
      code: "CLOUD_RELEASE_BACKUP_PATH_INVALID",
    });
  }
});

test("transition verification evidence has explicit active and recovery authority", () => {
  const awaiting = updateTransition(recoveryRecord(), {
    phase: "awaiting_external_verification",
    write_gate_state: "released",
  });
  const path = verificationEvidencePath(CANDIDATE, releaseTokenDigest(TOKEN));
  const bound = updateTransition(awaiting, {
    verification_evidence_authoritative: true,
    verification_evidence_path: path,
    verification_evidence_sha256: DIGEST_1,
  });
  assert.equal(parseTransition(bound).verification_evidence_path, path);
  for (const invalid of [
    { ...bound, verification_evidence_path: null },
    { ...bound, verification_evidence_path: `${path}.other` },
    { ...bound, verification_evidence_sha256: "A".repeat(64) },
    { ...bound, phase: "recovery_required" },
    { ...bound, verification_evidence_authoritative: false },
  ]) {
    assert.throws(() => parseTransition(invalid), {
      code: "CLOUD_RELEASE_TRANSITION_INVALID",
    });
  }
  assert.equal(
    updateTransition(bound, {
      verification_evidence_authoritative: null,
      verification_evidence_path: null,
      verification_evidence_sha256: null,
    }).verification_evidence_path,
    null,
  );
  assert.equal(
    updateTransition(bound, {
      phase: "recovery_required",
      verification_evidence_authoritative: false,
    }).verification_evidence_authoritative,
    false,
  );
});

test("migration inventory is sorted, checksummed, and pinned to the declared head", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-migrations-"));
  try {
    const directory = join(root, "packages/db/src/migrations");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, MIGRATION_2), "second\n");
    await writeFile(join(directory, MIGRATION_1), "first\n");
    await writeFile(join(directory, "README.md"), "ignored\n");
    const inventory = await migrationInventory(root, MIGRATION_2);
    assert.deepEqual(
      inventory.map((item) => item.filename),
      [MIGRATION_1, MIGRATION_2],
    );
    assert.ok(inventory.every((item) => /^[0-9a-f]{64}$/u.test(item.checksum)));
    await assert.rejects(() => migrationInventory(root, "0047_missing.sql"), {
      code: "CLOUD_RELEASE_MIGRATION_INVENTORY_INVALID",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration ledger parser and prefix/exact policies reject drift", () => {
  const source = `${MIGRATION_1}\t${DIGEST_1}\n${MIGRATION_2}\t${DIGEST_2}\n`;
  const inventory = parseMigrationLedger(source);
  assert.equal(Object.isFrozen(inventory), true);
  assert.doesNotThrow(() => assertMigrationLedger(inventory, inventory.slice(0, 1), "prefix"));
  assert.doesNotThrow(() => assertMigrationLedger(inventory, inventory, "exact"));
  assert.throws(() => assertMigrationLedger(inventory, inventory.slice(0, 1), "exact"), {
    code: "CLOUD_RELEASE_MIGRATION_LEDGER_MISMATCH",
  });
  assert.throws(
    () =>
      assertMigrationLedger(inventory, [{ filename: MIGRATION_1, checksum: DIGEST_2 }], "prefix"),
    { code: "CLOUD_RELEASE_MIGRATION_LEDGER_MISMATCH" },
  );
  for (const invalid of ["", `${MIGRATION_1}\t${DIGEST_1}\textra`, `bad.sql\t${DIGEST_1}`]) {
    assert.throws(() => parseMigrationLedger(invalid), {
      code: "CLOUD_RELEASE_MIGRATION_LEDGER_INVALID",
    });
  }
});

test("compatibility policy is strict, unique, and only approves declared transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-policy-"));
  try {
    const directory = join(root, "tools/cloud");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "hk-vps-release-compatibility.json");
    const item = {
      decision: "ADR-37",
      from_migration: MIGRATION_1,
      old_code_compatible: true,
      to_migration: MIGRATION_2,
    };
    await writeFile(path, JSON.stringify({ transitions: [item], version: 1 }));
    const policy = await readCompatibilityPolicy(root);
    assert.equal(isOldCodeCompatible(policy, MIGRATION_1, MIGRATION_2), true);
    assert.equal(isOldCodeCompatible(policy, MIGRATION_2, MIGRATION_1), false);
    assert.equal(isOldCodeCompatible(policy, MIGRATION_2, MIGRATION_2), true);
    assert.deepEqual(resolveCompatibility(policy, MIGRATION_1, MIGRATION_2), {
      compatible: true,
      decision: "ADR-37",
    });
    assert.deepEqual(resolveCompatibility(policy, MIGRATION_2, MIGRATION_1), {
      compatible: false,
      decision: "unproven",
    });

    await writeFile(path, JSON.stringify({ transitions: [item, item], version: 1 }));
    await assert.rejects(() => readCompatibilityPolicy(root), {
      code: "CLOUD_RELEASE_COMPATIBILITY_INVALID",
    });
    await writeFile(
      path,
      JSON.stringify({ transitions: [{ ...item, old_code_compatible: false }], version: 1 }),
    );
    await assert.rejects(() => readCompatibilityPolicy(root), {
      code: "CLOUD_RELEASE_COMPATIBILITY_INVALID",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
