import assert from "node:assert/strict";
import test from "node:test";
import { basename } from "node:path";

import { assertRetainedBackups } from "./hk-vps-release-backup-retention.mjs";
import {
  BACKUP_ROOT,
  HISTORY_ROOT,
  createTransition,
  shadowDatabaseName,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";
import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";

const EXPECTED = "b".repeat(40);
const DIGEST = "d".repeat(64);
const POSTGRES_GID = 123;

function missing(path) {
  return Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
}

function directory(mode = 0o710, ownership = {}) {
  return {
    gid: ownership.gid ?? POSTGRES_GID,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mode,
    uid: ownership.uid ?? 0,
  };
}

function archivedRecord(index, { backup = true } = {}) {
  const candidate = index.toString(16).padStart(40, "0");
  const token = index.toString(16).padStart(32, "0");
  let record = createTransition({
    archiveDigest: DIGEST,
    candidateSha: candidate,
    controllerDigest: "e".repeat(64),
    controllerPath: releaseControllerPath(candidate, token),
    expectedSha: EXPECTED,
    migrationHead: "0046_print_job_request_idempotency.sql",
    token,
  });
  if (backup) {
    const backupPath = `${BACKUP_ROOT}/pre-${candidate}-${token}.dump`;
    record = updateTransition(record, {
      app_role_original_can_login: true,
      backup_path: backupPath,
      backup_sha256: "a".repeat(64),
      compatibility_decision: "ADR-37",
      old_code_compatible: true,
      phase: "recovery_ready",
      pre_migration_count: 46,
      pre_migration_head: "0046_print_job_request_idempotency.sql",
      pre_migration_ledger_sha256: "c".repeat(64),
      shadow_database: shadowDatabaseName(backupPath),
      source_catalog_sha256: "f".repeat(64),
      write_freeze_terminated_sessions: 0,
      write_freeze_verified_at: "2026-08-10T02:00:00.000Z",
      write_gate_state: "active",
    });
  }
  return updateTransition(record, {
    outcome: "rolled_back",
    verification_evidence_authoritative: false,
    write_gate_state: backup ? "released" : null,
  });
}

function fixture(records, names) {
  const verified = [];
  return {
    dependencies: {
      lstat: async (path) => {
        if (path === BACKUP_ROOT) return directory();
        throw missing(path);
      },
      postgresGid: POSTGRES_GID,
      readdir: async (path) => (path === BACKUP_ROOT ? names : []),
      realpath: async (path) => path,
      records: async () => records,
      verifyBackupEvidence: async (record) => verified.push(record.backup_path),
    },
    verified,
  };
}

function namesFor(record) {
  const name = basename(record.backup_path);
  return [name, `${name}.json`];
}

test("retained backups are the exact history-bound set and each manifest is reverified", async () => {
  const records = [archivedRecord(1), archivedRecord(2), archivedRecord(3, { backup: false })];
  const names = records.flatMap((record) => (record.backup_path === null ? [] : namesFor(record)));
  const context = fixture(records, names.reverse());
  await assertRetainedBackups(context.dependencies);
  assert.deepEqual(
    context.verified.sort(),
    [records[0].backup_path, records[1].backup_path].sort(),
  );
});

test("retention permits no backup root only when no history record binds a backup", async () => {
  await assert.doesNotReject(() =>
    assertRetainedBackups({
      lstat: async (path) => {
        throw missing(path);
      },
      postgresGid: POSTGRES_GID,
      records: async () => [archivedRecord(1, { backup: false })],
    }),
  );
  await assert.rejects(
    () =>
      assertRetainedBackups({
        lstat: async (path) => {
          throw missing(path);
        },
        postgresGid: POSTGRES_GID,
        records: async () => [archivedRecord(1)],
      }),
    { code: "CLOUD_RELEASE_BACKUP_RETENTION_INVALID" },
  );
});

test("retention rejects missing, orphan, duplicate, excessive, and tampered backup bindings", async () => {
  const first = archivedRecord(1);
  const exact = namesFor(first);
  for (const names of [
    exact.slice(0, 1),
    [...exact, ...namesFor(archivedRecord(2))],
    [`${exact[0]}.json`, exact[0]],
  ]) {
    const context = fixture([first], names);
    if (names.length === 2 && new Set(names).size === 2) {
      await assert.doesNotReject(() => assertRetainedBackups(context.dependencies));
    } else {
      await assert.rejects(() => assertRetainedBackups(context.dependencies), {
        code: "CLOUD_RELEASE_BACKUP_RETENTION_INVALID",
      });
    }
  }

  const duplicate = fixture(
    [first, Object.freeze({ ...archivedRecord(2), backup_path: first.backup_path })],
    exact,
  );
  await assert.rejects(() => assertRetainedBackups(duplicate.dependencies), {
    code: "CLOUD_RELEASE_BACKUP_RETENTION_INVALID",
  });

  const excessiveRecords = Array.from({ length: 8 }, (_, index) => archivedRecord(index + 1));
  const excessive = fixture(excessiveRecords, excessiveRecords.flatMap(namesFor));
  await assert.rejects(() => assertRetainedBackups(excessive.dependencies), {
    code: "CLOUD_RELEASE_BACKUP_RETENTION_LIMIT",
  });

  const tampered = fixture([first], exact);
  tampered.dependencies.verifyBackupEvidence = async () => {
    throw Object.assign(new Error("tampered"), { code: "CLOUD_RELEASE_BACKUP_EVIDENCE_INVALID" });
  };
  await assert.rejects(() => assertRetainedBackups(tampered.dependencies), {
    code: "CLOUD_RELEASE_BACKUP_EVIDENCE_INVALID",
  });
});

test("retention reads canonical private history and binds its filename identity", async () => {
  const record = archivedRecord(1);
  const historyName = `${record.candidate_sha}-${record.token}-rolled_back.json`;
  const source = `${JSON.stringify(record)}\n`;
  const context = fixture([record], namesFor(record));
  delete context.dependencies.records;
  context.dependencies.readdir = async (path) => {
    if (path === HISTORY_ROOT) return [historyName];
    if (path === BACKUP_ROOT) return namesFor(record);
    return [];
  };
  context.dependencies.readHistory = async (path, options) => {
    assert.equal(path, `${HISTORY_ROOT}/${historyName}`);
    assert.equal(options.code, "CLOUD_RELEASE_BACKUP_RETENTION_INVALID");
    return source;
  };
  await assertRetainedBackups(context.dependencies);

  context.dependencies.readHistory = async () =>
    `${JSON.stringify({ ...record, token: "f".repeat(32) })}\n`;
  await assert.rejects(() => assertRetainedBackups(context.dependencies), {
    code: "CLOUD_RELEASE_BACKUP_RETENTION_INVALID",
  });
});
