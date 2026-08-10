import { fail } from "./hk-vps-release-core.mjs";
import {
  archiveTransition,
  readArchivedTransition,
  syncReleaseHistory,
} from "./hk-vps-release-history.mjs";
import {
  discoverUnboundFinalizeEvidence,
  readPersistedFinalizeEvidence,
} from "./hk-vps-release-remote-evidence.mjs";
import {
  LIVE_ROOT,
  persistTransition,
  readReleaseMarker,
  readTransition,
  transitionExists,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";
import {
  assertDeskHealth,
  assertSharedInfrastructure,
  removeOrphanStaging,
  restorePreviousCode,
  startDesk,
  stopDesk,
} from "./hk-vps-release-remote-system.mjs";
import {
  activatePersistedRecoveryWriteGate,
  releasePersistedWriteGate,
} from "./hk-vps-release-write-gate-state.mjs";

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

function transitionIdentity(record) {
  return Object.freeze({
    candidateSha: record.candidate_sha,
    expectedSha: record.expected_sha,
    migrationHead: record.migration_head,
    token: record.token,
  });
}

export async function markRecoveryRequired(record, dependencies = {}) {
  const evidence = await resolveRollbackEvidence(record, dependencies);
  const next = updateTransition(record, {
    phase: "recovery_required",
    verification_evidence_authoritative: evidence === null ? null : false,
    verification_evidence_path: evidence?.path ?? null,
    verification_evidence_sha256: evidence?.digest ?? null,
  });
  await (dependencies.persistTransition ?? persistTransition)(next);
  return next;
}

async function resolveRollbackEvidence(record, dependencies) {
  if (record.verification_evidence_path === null) {
    return await (dependencies.discoverEvidence ?? discoverUnboundFinalizeEvidence)(record);
  }
  await (dependencies.readEvidence ?? readPersistedFinalizeEvidence)(record, { allowStale: true });
  return Object.freeze({
    digest: record.verification_evidence_sha256,
    path: record.verification_evidence_path,
  });
}

export async function prepareRollbackArchiveRecord(record, dependencies = {}) {
  if (![null, "rolled_back"].includes(record.outcome)) {
    fail("CLOUD_RELEASE_ROLLBACK_PHASE_INVALID");
  }
  const evidence = await resolveRollbackEvidence(record, dependencies);
  const path = evidence?.path ?? null;
  const digest = evidence?.digest ?? null;
  if (
    record.outcome === "rolled_back" &&
    path === record.verification_evidence_path &&
    digest === record.verification_evidence_sha256
  ) {
    return record;
  }
  return updateTransition(record, {
    outcome: "rolled_back",
    verification_evidence_authoritative: false,
    verification_evidence_path: path,
    verification_evidence_sha256: digest,
  });
}

async function archiveRolledBackTransition(record, dependencies = {}) {
  const prepared = await prepareRollbackArchiveRecord(record, dependencies);
  return await (dependencies.archiveTransition ?? archiveTransition)(prepared, "rolled_back");
}

async function assertRolledBackState(record, options) {
  assertIdentity(record, options);
  if (record.outcome !== "rolled_back" || record.verification_evidence_authoritative !== false) {
    fail("CLOUD_RELEASE_ROLLBACK_HISTORY_INVALID");
  }
  const marker = await readReleaseMarker(LIVE_ROOT);
  if (marker.git_sha !== options.expectedSha) fail("CLOUD_RELEASE_MARKER_MISMATCH");
  await assertDeskHealth(options.expectedSha, undefined);
  await assertSharedInfrastructure(undefined);
  if (record.verification_evidence_path !== null) {
    await readPersistedFinalizeEvidence(record, { allowStale: true });
  }
}

async function reconcileRolledBack(record) {
  const identity = transitionIdentity(record);
  await assertRolledBackState(await readArchivedTransition(identity, "rolled_back"), identity);
  await syncReleaseHistory();
}

async function requireRecoveryAfterRollbackFailure(record, error, dependencies) {
  if (!(await (dependencies.transitionExists ?? transitionExists)())) {
    try {
      await (dependencies.reconcileRolledBack ?? reconcileRolledBack)(record);
      return;
    } catch (historyError) {
      fail("CLOUD_RELEASE_RECOVERY_REQUIRED", historyError);
    }
  }
  try {
    await (dependencies.markRecoveryRequired ?? markRecoveryRequired)(record, dependencies);
  } catch (stateError) {
    fail("CLOUD_RELEASE_RECOVERY_REQUIRED", stateError);
  }
  fail("CLOUD_RELEASE_RECOVERY_REQUIRED", error);
}

async function rollbackStaged(record, dependencies) {
  let current = record;
  const persistAndTrack = async (next) => {
    current = next;
    await (dependencies.persistTransition ?? persistTransition)(next);
  };
  try {
    current = await (dependencies.releasePersistedWriteGate ?? releasePersistedWriteGate)(
      current,
      undefined,
      {
        persistTransition: persistAndTrack,
        releaseWriteGate: dependencies.releaseWriteGate,
      },
    );
    await (dependencies.startDesk ?? startDesk)(undefined);
    await (dependencies.assertDeskHealth ?? assertDeskHealth)(current.expected_sha, undefined);
    await (dependencies.assertSharedInfrastructure ?? assertSharedInfrastructure)(undefined);
    await (dependencies.removeOrphanStaging ?? removeOrphanStaging)(current, undefined);
    await (dependencies.archiveRolledBackTransition ?? archiveRolledBackTransition)(
      current,
      dependencies,
    );
  } catch (error) {
    await requireRecoveryAfterRollbackFailure(current, error, dependencies);
  }
}

export async function rollbackOrRequireRecovery(
  record,
  compatible,
  deskStopAttempted = false,
  dependencies = {},
) {
  if (typeof deskStopAttempted !== "boolean") fail("CLOUD_RELEASE_ROLLBACK_PHASE_INVALID");
  if (record.phase === "staged") {
    await rollbackStaged(record, dependencies);
    return;
  }
  if (!compatible) {
    let current = record;
    let recoveryError;
    const persistAndTrack = async (next) => {
      current = next;
      await (dependencies.persistTransition ?? persistTransition)(next);
    };
    try {
      await (dependencies.stopDesk ?? stopDesk)(undefined);
    } catch (error) {
      recoveryError = error;
    }
    try {
      current = await (
        dependencies.activatePersistedRecoveryWriteGate ?? activatePersistedRecoveryWriteGate
      )(current, undefined, {
        activateWriteGate: dependencies.activateWriteGate,
        persistTransition: persistAndTrack,
      });
    } catch (error) {
      recoveryError ??= error;
    }
    try {
      await (dependencies.markRecoveryRequired ?? markRecoveryRequired)(current, {
        ...dependencies,
        persistTransition: persistAndTrack,
      });
    } catch (error) {
      recoveryError ??= error;
    }
    fail("CLOUD_RELEASE_RECOVERY_REQUIRED", recoveryError);
  }
  let current = record;
  const persistAndTrack = async (next) => {
    current = next;
    await (dependencies.persistTransition ?? persistTransition)(next);
  };
  try {
    await (dependencies.restorePreviousCode ?? restorePreviousCode)(current, {
      beforeStart: async () => {
        current = await (dependencies.releasePersistedWriteGate ?? releasePersistedWriteGate)(
          current,
          undefined,
          {
            persistTransition: persistAndTrack,
            releaseWriteGate: dependencies.releaseWriteGate,
          },
        );
      },
    });
    await (dependencies.removeOrphanStaging ?? removeOrphanStaging)(current, undefined);
    await (dependencies.archiveRolledBackTransition ?? archiveRolledBackTransition)(
      current,
      dependencies,
    );
  } catch (error) {
    await requireRecoveryAfterRollbackFailure(current, error, dependencies);
  }
}

export async function rollbackRelease(options) {
  if (!(await transitionExists())) {
    await assertRolledBackState(await readArchivedTransition(options, "rolled_back"), options);
    await syncReleaseHistory();
    return;
  }
  const record = await readTransition();
  assertIdentity(record, options);
  if (record.outcome === "rolled_back") {
    await assertRolledBackState(record, options);
    await archiveRolledBackTransition(record);
    return;
  }
  if (record.outcome !== null) fail("CLOUD_RELEASE_ROLLBACK_PHASE_INVALID");
  if (
    ![
      "staged",
      "write_frozen",
      "recovery_ready",
      "migrating",
      "switched",
      "awaiting_external_verification",
      "recovery_required",
    ].includes(record.phase)
  ) {
    fail("CLOUD_RELEASE_ROLLBACK_PHASE_INVALID");
  }
  const migrationMayHaveStarted =
    ["migrating", "switched", "awaiting_external_verification"].includes(record.phase) ||
    (record.phase === "recovery_required" && record.pre_migration_head !== null);
  await rollbackOrRequireRecovery(
    record,
    !migrationMayHaveStarted || record.old_code_compatible === true,
  );
}
