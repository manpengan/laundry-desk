import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";
import { assertRetainedFinalizeEvidence } from "./hk-vps-release-evidence-retention.mjs";
import {
  releaseTokenDigest,
  verificationEvidencePath,
} from "./hk-vps-release-finalize-evidence.mjs";
import { prepareArchivedTransition } from "./hk-vps-release-history.mjs";
import {
  createTransition,
  shadowDatabaseName,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "f276bdbf328ae20aba20c7985c690a63484afdca";
const EXPECTED = "6f106076018940eec8fcc9e8c2cfb7842c323f47";
const MIGRATION = "0048_catalog_governance.sql";
const TOKEN = "c".repeat(32);
const NOW = new Date("2026-08-11T12:58:40.046Z");
const API_JOURNEYS = Object.freeze([
  "configuration",
  "dual_admin_auth",
  "staff_credentials",
  "accounting_baseline",
  "catalog_price",
  "synthetic_customer",
  "cash_order_fulfillment",
  "member_lifecycle",
  "accounting_today_delta",
  "order_finance",
  "reporting_exports_shift",
  "reminder_history",
  "safe_cleanup",
  "session_logout",
  "overall",
]);

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function retainedEvidence() {
  return Object.freeze({
    schema: "laundry.cloud-release.finalize-evidence",
    version: 1,
    candidate_sha: CANDIDATE,
    expected_sha: EXPECTED,
    migration_head: MIGRATION,
    token_sha256: releaseTokenDigest(TOKEN),
    verification_id: "87458fee-2cf9-4954-bbd6-688f46cd0ca4",
    api: Object.freeze({
      schema: "laundry.adr36.api-acceptance-evidence",
      version: 1,
      run_id: "ADR36-20260811T125802788Z-565ce627",
      results: Object.freeze(
        API_JOURNEYS.map((journey) => Object.freeze({ journey, status: "PASS" })),
      ),
    }),
    browser: Object.freeze({
      schema: "laundry.cloud-web.browser-evidence",
      version: 1,
      run_id: "CLOUD-BROWSER-20260811T125835362Z-70ab733f",
      test_count: 1,
      test_title: "core_ui_subset: public Cloud Web read surfaces are reachable",
      test_status: "PASS",
      retries: 0,
      results: Object.freeze([
        Object.freeze({ journey: "configuration", status: "PASS" }),
        Object.freeze({ journey: "core_ui_subset", status: "PASS" }),
        Object.freeze({ journey: "session_logout", status: "PASS" }),
        Object.freeze({ journey: "business_cleanup", status: "NOT_REQUIRED" }),
        Object.freeze({ journey: "standalone_completion", status: "NOT_AUTHORIZED" }),
      ]),
    }),
    created_at: NOW.toISOString(),
  });
}

function archivedTransition(evidencePath, evidenceDigest) {
  const base = createTransition(
    {
      candidateSha: CANDIDATE,
      expectedSha: EXPECTED,
      migrationHead: MIGRATION,
      token: TOKEN,
      archiveDigest: "4".repeat(64),
      controllerDigest: "5".repeat(64),
      controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
    },
    NOW,
  );
  const backupPath = `/var/lib/laundry-desk-release-backups/pre-${CANDIDATE}-${"d".repeat(32)}.dump`;
  const awaiting = updateTransition(
    base,
    {
      app_role_original_can_login: true,
      backup_path: backupPath,
      backup_sha256: "1".repeat(64),
      compatibility_decision: "ADR-37",
      old_code_compatible: true,
      phase: "awaiting_external_verification",
      pre_migration_count: 48,
      pre_migration_head: "0047_reminder_delivery.sql",
      pre_migration_ledger_sha256: "2".repeat(64),
      shadow_database: shadowDatabaseName(backupPath),
      source_catalog_sha256: "3".repeat(64),
      verification_evidence_authoritative: true,
      verification_evidence_path: evidencePath,
      verification_evidence_sha256: evidenceDigest,
      write_freeze_terminated_sessions: 0,
      write_freeze_verified_at: "2026-08-11T12:50:00.000Z",
      write_gate_state: "released",
    },
    NOW,
  );
  return prepareArchivedTransition(awaiting, "committed", NOW);
}

test("retention accepts the committed f276 evidence profile without rewriting history", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "release-retained-v1-test-")));
  const historyRoot = join(stateRoot, "history");
  await chmod(stateRoot, 0o700);
  await mkdir(historyRoot, { mode: 0o700 });
  try {
    const uid = process.getuid();
    const gid = process.getgid();
    const canonical = canonicalJson(retainedEvidence());
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    const evidencePath = verificationEvidencePath(CANDIDATE, releaseTokenDigest(TOKEN));
    const localEvidencePath = join(stateRoot, basename(evidencePath));
    await writeFile(localEvidencePath, canonical, { mode: 0o600 });
    await chmod(localEvidencePath, 0o600);

    const archived = archivedTransition(evidencePath, digest);
    const historyPath = join(historyRoot, `${CANDIDATE}-${TOKEN}-committed.json`);
    await writeFile(historyPath, `${JSON.stringify(archived)}\n`, { mode: 0o600 });
    await chmod(historyPath, 0o600);

    const evidenceBefore = await readFile(localEvidencePath);
    const historyBefore = await readFile(historyPath);
    const evidenceMetadata = await lstat(localEvidencePath);
    const historyMetadata = await lstat(historyPath);
    await assertRetainedFinalizeEvidence({ gid, historyRoot, stateRoot, uid });

    assert.deepEqual(await readFile(localEvidencePath), evidenceBefore);
    assert.deepEqual(await readFile(historyPath), historyBefore);
    assert.equal((await lstat(localEvidencePath)).ino, evidenceMetadata.ino);
    assert.equal((await lstat(localEvidencePath)).mtimeMs, evidenceMetadata.mtimeMs);
    assert.equal((await lstat(historyPath)).ino, historyMetadata.ino);
    assert.equal((await lstat(historyPath)).mtimeMs, historyMetadata.mtimeMs);
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});
