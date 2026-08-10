import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import { fail } from "./hk-vps-release-core.mjs";
import {
  parseCanonicalFinalizeEvidence,
  requireFinalizeEvidence,
} from "./hk-vps-release-finalize-evidence.mjs";
import {
  archiveTransition,
  readArchivedTransition,
  syncReleaseHistory,
} from "./hk-vps-release-history.mjs";
import {
  readCatalogEvidence,
  readMigrationLedger,
  verifyBackupEvidence,
} from "./hk-vps-release-remote-db.mjs";
import {
  persistFinalizeEvidence,
  readPersistedFinalizeEvidence,
} from "./hk-vps-release-remote-evidence.mjs";
import {
  LIVE_ROOT,
  assertMigrationLedger,
  migrationInventory,
  persistTransition,
  readReleaseMarker,
  readTransition,
  transitionExists,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";
import {
  assertDeskHealth,
  assertRollbackEvidence,
  assertSharedInfrastructure,
  assertSystemContract,
} from "./hk-vps-release-remote-system.mjs";

function assertIdentity(record, options) {
  if (
    record.candidate_sha !== options.candidateSha ||
    record.expected_sha !== options.expectedSha ||
    record.migration_head !== options.migrationHead ||
    record.token !== options.token
  ) {
    fail("CLOUD_RELEASE_TRANSITION_IDENTITY_MISMATCH");
  }
}

async function currentRepositoryRoot() {
  return await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
}

async function assertFinalizableState(record, options, signal) {
  if ((await currentRepositoryRoot()) !== LIVE_ROOT) fail("CLOUD_RELEASE_LIVE_ROOT_MISMATCH");
  const marker = await readReleaseMarker(LIVE_ROOT);
  if (marker.git_sha !== options.candidateSha) fail("CLOUD_RELEASE_MARKER_MISMATCH");
  await assertSystemContract(signal);
  await assertDeskHealth(options.candidateSha, signal);
  await assertRollbackEvidence(record);
  await verifyBackupEvidence(record);
  await assertSharedInfrastructure(signal);
  const inventory = await migrationInventory(LIVE_ROOT, options.migrationHead);
  assertMigrationLedger(inventory, await readMigrationLedger("laundry_v2", signal), "exact");
  await readCatalogEvidence("laundry_v2", signal, "stable");
}

async function validateCommittedRecord(record, binding, options, signal, dependencies) {
  assertIdentity(record, options);
  if (record.outcome !== "committed" || record.verification_evidence_authoritative !== true) {
    fail("CLOUD_RELEASE_COMMITTED_HISTORY_INVALID");
  }
  const persistedEvidence = await (
    dependencies.readPersistedFinalizeEvidence ?? readPersistedFinalizeEvidence
  )(record, { allowStale: true });
  requireFinalizeEvidence(persistedEvidence, binding, new Date(record.updated_at));
  await (dependencies.assertFinalizableState ?? assertFinalizableState)(record, options, signal);
  return record;
}

async function reconcileCommittedRelease(binding, options, signal, dependencies) {
  const record = await (dependencies.readArchivedTransition ?? readArchivedTransition)(
    binding,
    "committed",
  );
  await validateCommittedRecord(record, binding, options, signal, dependencies);
  await (dependencies.syncReleaseHistory ?? syncReleaseHistory)();
  return record;
}

export async function finalizeRelease(options, signal, source, dependencies = {}) {
  const binding = Object.freeze({
    candidateSha: options.candidateSha,
    expectedSha: options.expectedSha,
    migrationHead: options.migrationHead,
    token: options.token,
  });
  const evidence = parseCanonicalFinalizeEvidence(source, binding);
  if (!(await (dependencies.transitionExists ?? transitionExists)())) {
    return await reconcileCommittedRelease(binding, options, signal, dependencies);
  }
  let record = await (dependencies.readTransition ?? readTransition)();
  assertIdentity(record, options);
  if (record.outcome === "committed") {
    await validateCommittedRecord(record, binding, options, signal, dependencies);
    await (dependencies.archiveTransition ?? archiveTransition)(record, "committed");
    return record;
  }
  if (record.outcome !== null) fail("CLOUD_RELEASE_NOT_AWAITING_VERIFICATION");
  if (record.phase !== "awaiting_external_verification") {
    fail("CLOUD_RELEASE_NOT_AWAITING_VERIFICATION");
  }
  await (dependencies.assertFinalizableState ?? assertFinalizableState)(record, options, signal);
  const artifact = await (dependencies.persistFinalizeEvidence ?? persistFinalizeEvidence)(
    record,
    evidence,
  );
  record = updateTransition(record, {
    verification_evidence_authoritative: true,
    verification_evidence_path: artifact.path,
    verification_evidence_sha256: artifact.digest,
  });
  await (dependencies.persistTransition ?? persistTransition)(record);

  const committedRecord = await (dependencies.readTransition ?? readTransition)();
  assertIdentity(committedRecord, options);
  if (
    committedRecord.phase !== "awaiting_external_verification" ||
    committedRecord.outcome !== null
  ) {
    fail("CLOUD_RELEASE_NOT_AWAITING_VERIFICATION");
  }
  const persistedEvidence = await (
    dependencies.readPersistedFinalizeEvidence ?? readPersistedFinalizeEvidence
  )(committedRecord);
  await (dependencies.assertFinalizableState ?? assertFinalizableState)(
    committedRecord,
    options,
    signal,
  );
  requireFinalizeEvidence(persistedEvidence, binding, new Date());
  await (dependencies.archiveTransition ?? archiveTransition)(committedRecord, "committed");
  return committedRecord;
}
