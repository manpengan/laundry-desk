import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { fail, requireMigrationHead, requireSha, requireToken } from "./hk-vps-release-core.mjs";
import {
  HISTORY_ROOT,
  STATE_ROOT,
  TRANSITION_PATH,
  parseTransition,
  persistTransition,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";

const MAX_HISTORY_BYTES = 64 * 1024;
const OUTCOMES = new Set(["committed", "rolled_back"]);

function requireOutcome(value) {
  if (typeof value !== "string" || !OUTCOMES.has(value)) {
    fail("CLOUD_RELEASE_OUTCOME_INVALID");
  }
  return value;
}

function historyPathAt(root, identity, outcome) {
  const candidate = requireSha(identity.candidateSha);
  const token = requireToken(identity.token);
  return join(root, `${candidate}-${token}-${requireOutcome(outcome)}.json`);
}

export function releaseHistoryPath(identity, outcome) {
  return historyPathAt(HISTORY_ROOT, identity, outcome);
}

export function prepareArchivedTransition(record, outcome, now = new Date()) {
  const parsed = parseTransition(record);
  const expectedOutcome = requireOutcome(outcome);
  if (parsed.outcome !== null && parsed.outcome !== expectedOutcome) {
    fail("CLOUD_RELEASE_OUTCOME_INVALID");
  }
  if (parsed.outcome === expectedOutcome) return parsed;
  return updateTransition(
    parsed,
    {
      outcome: expectedOutcome,
      verification_evidence_authoritative: expectedOutcome === "committed",
    },
    now,
  );
}

async function syncDirectory(path, dependencies) {
  const handle = await (dependencies.open ?? open)(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncReleaseHistory(dependencies = {}) {
  await syncDirectory(dependencies.historyRoot ?? HISTORY_ROOT, dependencies);
  await syncDirectory(dependencies.stateRoot ?? STATE_ROOT, dependencies);
}

export async function archiveTransition(record, outcome, dependencies = {}) {
  const archived = prepareArchivedTransition(record, outcome, dependencies.now ?? new Date());
  const historyRoot = dependencies.historyRoot ?? HISTORY_ROOT;
  const stateRoot = dependencies.stateRoot ?? STATE_ROOT;
  const transitionPath = dependencies.transitionPath ?? TRANSITION_PATH;
  const destination = historyPathAt(
    historyRoot,
    { candidateSha: archived.candidate_sha, token: archived.token },
    outcome,
  );
  const existing = await (dependencies.lstat ?? lstat)(destination).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    const retained = await readArchivedTransition(
      {
        candidateSha: archived.candidate_sha,
        expectedSha: archived.expected_sha,
        migrationHead: archived.migration_head,
        token: archived.token,
      },
      outcome,
      dependencies,
    );
    if (JSON.stringify(retained) !== JSON.stringify(archived)) {
      fail("CLOUD_RELEASE_HISTORY_COLLISION");
    }
    await (dependencies.unlink ?? unlink)(transitionPath);
    await syncReleaseHistory({ ...dependencies, historyRoot, stateRoot });
    return retained;
  }
  await (dependencies.persistTransition ?? persistTransition)(archived);
  await (dependencies.rename ?? rename)(transitionPath, destination);
  await syncReleaseHistory({ ...dependencies, historyRoot, stateRoot });
  return archived;
}

async function assertHistoryRoot(path, uid, gid, dependencies) {
  const metadata = await (dependencies.lstat ?? lstat)(path).catch(() => null);
  const canonical =
    metadata === null ? null : await (dependencies.realpath ?? realpath)(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    canonical !== path
  ) {
    fail("CLOUD_RELEASE_HISTORY_INVALID");
  }
}

function assertHistoryIdentity(record, identity, outcome) {
  if (
    record.candidate_sha !== requireSha(identity.candidateSha) ||
    record.expected_sha !== requireSha(identity.expectedSha) ||
    record.migration_head !== requireMigrationHead(identity.migrationHead) ||
    record.token !== requireToken(identity.token) ||
    record.outcome !== outcome ||
    record.verification_evidence_authoritative !== (outcome === "committed")
  ) {
    fail("CLOUD_RELEASE_HISTORY_IDENTITY_MISMATCH");
  }
}

export async function readArchivedTransition(identity, outcome, dependencies = {}) {
  const expectedOutcome = requireOutcome(outcome);
  const historyRoot = dependencies.historyRoot ?? HISTORY_ROOT;
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const path = historyPathAt(historyRoot, identity, expectedOutcome);
  await assertHistoryRoot(historyRoot, uid, gid, dependencies);
  let handle;
  let buffer;
  try {
    handle = await (dependencies.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== uid ||
      metadata.gid !== gid ||
      (metadata.mode & 0o7777) !== 0o600 ||
      metadata.size < 2 ||
      metadata.size > MAX_HISTORY_BYTES ||
      (await (dependencies.realpath ?? realpath)(path).catch(() => null)) !== path
    ) {
      fail("CLOUD_RELEASE_HISTORY_INVALID");
    }
    buffer = await handle.readFile();
    if (buffer.byteLength !== metadata.size) fail("CLOUD_RELEASE_HISTORY_INVALID");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const record = parseTransition(JSON.parse(source));
    if (source !== `${JSON.stringify(record)}\n`) fail("CLOUD_RELEASE_HISTORY_INVALID");
    assertHistoryIdentity(record, identity, expectedOutcome);
    return record;
  } catch (error) {
    if (error?.code?.startsWith?.("CLOUD_RELEASE_")) throw error;
    fail("CLOUD_RELEASE_HISTORY_INVALID", error);
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}
