import { fail } from "./hk-vps-release-core.mjs";
import { readArchivedTransition } from "./hk-vps-release-history.mjs";
import {
  readPersistedFinalizeEvidence,
  runRemoteApiAcceptance,
} from "./hk-vps-release-remote-evidence.mjs";
import {
  LIVE_ROOT,
  readReleaseMarker,
  readTransition,
  transitionExists,
} from "./hk-vps-release-remote-support.mjs";

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

export async function collectRemoteApiEvidence(options, signal, dependencies = {}) {
  const active = await (dependencies.transitionExists ?? transitionExists)();
  const record = active
    ? await (dependencies.readTransition ?? readTransition)()
    : await (dependencies.readArchivedTransition ?? readArchivedTransition)(options, "committed");
  assertIdentity(record, options);
  const activeAwaiting = active && record.outcome === null;
  const committedRetry =
    record.outcome === "committed" && record.verification_evidence_authoritative === true;
  if (record.phase !== "awaiting_external_verification" || (!activeAwaiting && !committedRetry)) {
    fail("CLOUD_RELEASE_NOT_AWAITING_VERIFICATION");
  }
  if (committedRetry) {
    await (dependencies.readPersistedFinalizeEvidence ?? readPersistedFinalizeEvidence)(record, {
      allowStale: true,
    });
  }
  const marker = await (dependencies.readReleaseMarker ?? readReleaseMarker)(LIVE_ROOT);
  if (marker.git_sha !== options.candidateSha) fail("CLOUD_RELEASE_MARKER_MISMATCH");
  return await (dependencies.runRemoteApiAcceptance ?? runRemoteApiAcceptance)(signal);
}
