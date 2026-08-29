import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import {
  CloudReleaseError,
  fail,
  requireDigest,
  requireMigrationHead,
  requireSha,
  requireToken,
} from "./hk-vps-release-core.mjs";
import { installReleaseController } from "./hk-vps-release-controller.mjs";
import { cleanupUnboundReleaseControllers } from "./hk-vps-release-controller-retention.mjs";
import { cleanupStaleMigrationBundles } from "./hk-vps-release-migration-cleanup.mjs";
import { materializeAcceptanceSecrets } from "./hk-vps-release-acceptance-secrets.mjs";
import { withCloudSignalCancellation } from "./hk-vps-release-process.mjs";
import { readBoundedEvidenceInput } from "./hk-vps-release-remote-evidence.mjs";
import { collectRemoteApiEvidence } from "./hk-vps-release-remote-api.mjs";
import { finalizeRelease } from "./hk-vps-release-remote-finalize.mjs";
import { rollbackOrRequireRecovery, rollbackRelease } from "./hk-vps-release-remote-rollback.mjs";
import {
  applyMigrations,
  captureMigrationAuthority,
  createVerifiedBackup,
  freezeDatabaseWrites,
  readCatalogEvidence,
  readMigrationLedger,
  verifyBackupEvidence,
} from "./hk-vps-release-remote-db.mjs";
import { migrationLedgerDigest } from "./hk-vps-release-remote-db-evidence.mjs";
import {
  persistWriteGateIntent,
  releasePersistedWriteGate,
} from "./hk-vps-release-write-gate-state.mjs";
import {
  LIVE_ROOT,
  assertMigrationLedger,
  createTransition,
  ensureReleaseDirectories,
  migrationInventory,
  persistTransition,
  readCompatibilityPolicy,
  readReleaseMarker,
  readTransition,
  resolveCompatibility,
  transitionExists,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";
import {
  assertDeskHealth,
  assertReleasePreflight,
  assertRollbackEvidence,
  assertSharedInfrastructure,
  assertSystemContract,
  prepareStaging,
  startDesk,
  stopDesk,
  switchToCandidate,
} from "./hk-vps-release-remote-system.mjs";

const ACTIONS = new Set(["api-evidence", "deploy", "finalize", "rollback", "status"]);

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      typeof key !== "string" ||
      !key.startsWith("--") ||
      typeof value !== "string" ||
      values.has(key)
    ) {
      fail("CLOUD_RELEASE_ARGS_INVALID");
    }
    values.set(key, value);
  }
  const action = values.get("--action") ?? "deploy";
  if (!ACTIONS.has(action)) fail("CLOUD_RELEASE_ACTION_INVALID");
  const allowed = new Set(
    action === "status"
      ? ["--action"]
      : [
          "--action",
          "--candidate-sha",
          "--expected-current-sha",
          "--migration-head",
          "--release-token",
          ...(action === "deploy" ? ["--archive-sha256"] : []),
        ],
  );
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    fail("CLOUD_RELEASE_ARGS_INVALID");
  }
  if (action === "status") return Object.freeze({ action });
  if ([...allowed].filter((key) => key !== "--action").some((key) => !values.has(key))) {
    fail("CLOUD_RELEASE_ARGS_INVALID");
  }
  return Object.freeze({
    action,
    archiveDigest: action === "deploy" ? requireDigest(values.get("--archive-sha256")) : undefined,
    candidateSha: requireSha(values.get("--candidate-sha")),
    expectedSha: requireSha(values.get("--expected-current-sha")),
    migrationHead: requireMigrationHead(values.get("--migration-head")),
    token: requireToken(values.get("--release-token")),
  });
}

async function currentRepositoryRoot() {
  const candidate = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return await realpath(candidate);
}

export async function enterWriteFreeze(record, inventory, policy, signal, dependencies) {
  await dependencies.stopDesk(signal);
  const intent = await (dependencies.persistWriteGateIntent ?? persistWriteGateIntent)(
    record,
    signal,
    {
      inspectWriteGate: dependencies.inspectWriteGate,
      persistTransition: dependencies.persistTransition,
    },
  );
  const evidence = await dependencies.freezeDatabaseWrites(signal);
  assertMigrationLedger(inventory, evidence.ledger, "prefix");
  const head = evidence.ledger.at(-1)?.filename;
  if (head === undefined) fail("CLOUD_RELEASE_MIGRATION_LEDGER_INVALID");
  const compatibility = resolveCompatibility(policy, head, record.migration_head);
  const next = updateTransition(intent, {
    compatibility_decision: compatibility.decision,
    old_code_compatible: compatibility.compatible,
    phase: "write_frozen",
    pre_migration_count: evidence.ledger.length,
    pre_migration_head: head,
    pre_migration_ledger_sha256: migrationLedgerDigest(evidence.ledger),
    source_catalog_sha256: evidence.catalog.sha256,
    write_freeze_terminated_sessions: evidence.terminatedSessions,
    write_freeze_verified_at: evidence.verifiedAt,
    write_gate_state: "active",
  });
  await dependencies.persistTransition(next);
  return Object.freeze({ compatible: compatibility.compatible, evidence, record: next });
}

export async function freezeAndPrepareStaging(
  record,
  root,
  candidateSha,
  migrationHead,
  inventory,
  policy,
  signal,
  dependencies,
) {
  const frozen = await enterWriteFreeze(record, inventory, policy, signal, dependencies);
  const authority = await (dependencies.captureMigrationAuthority ?? captureMigrationAuthority)(
    root,
    inventory,
  );
  await (dependencies.prepareStaging ?? prepareStaging)(root, candidateSha, migrationHead, signal);
  return Object.freeze({ ...frozen, authority });
}

export function backupFailureRequiresRecovery(error) {
  return (
    error instanceof CloudReleaseError && error.code === "CLOUD_RELEASE_BACKUP_RECOVERY_REQUIRED"
  );
}

export async function prepareDeployState(signal, dependencies = {}) {
  await (dependencies.ensureReleaseDirectories ?? ensureReleaseDirectories)();
  if (await (dependencies.transitionExists ?? transitionExists)()) {
    fail("CLOUD_RELEASE_TRANSITION_ACTIVE");
  }
  await (dependencies.cleanupStaleMigrationBundles ?? cleanupStaleMigrationBundles)();
  await (dependencies.cleanupUnboundReleaseControllers ?? cleanupUnboundReleaseControllers)();
  await (dependencies.assertReleasePreflight ?? assertReleasePreflight)(signal);
}

export async function installAndPersistReleaseController(
  options,
  root,
  beforePersist,
  dependencies = {},
) {
  const controller = await (dependencies.installController ?? installReleaseController)(
    root,
    options,
  );
  const record = createTransition({
    ...options,
    controllerDigest: controller.digest,
    controllerPath: controller.path,
  });
  await beforePersist(record);
  await (dependencies.persistTransition ?? persistTransition)(record);
  return record;
}

async function deploy(options, signal) {
  if (options.candidateSha === options.expectedSha) fail("CLOUD_RELEASE_ALREADY_CURRENT");
  await prepareDeployState(signal);
  await materializeAcceptanceSecrets();
  const root = await currentRepositoryRoot();
  const record = await installAndPersistReleaseController(options, root, async (installed) => {
    if (root !== installed.staging_path) fail("CLOUD_RELEASE_STAGING_ROOT_MISMATCH");
    const liveMarker = await readReleaseMarker(LIVE_ROOT);
    if (liveMarker.git_sha !== options.expectedSha) fail("CLOUD_RELEASE_CURRENT_SHA_MISMATCH");
  });

  let current = record;
  let compatible = false;
  let deskStopAttempted = false;
  const persistAndTrack = async (next) => {
    current = next;
    await persistTransition(next);
  };
  try {
    await assertSystemContract(signal);
    await assertDeskHealth(options.expectedSha, signal);
    await assertSharedInfrastructure(signal);
    const inventory = await migrationInventory(root, options.migrationHead);
    const beforeLedger = await readMigrationLedger(PROFILE.services.postgresDatabase, signal);
    assertMigrationLedger(inventory, beforeLedger, "prefix");
    const policy = await readCompatibilityPolicy(root);
    const frozen = await freezeAndPrepareStaging(
      current,
      root,
      options.candidateSha,
      options.migrationHead,
      inventory,
      policy,
      signal,
      {
        freezeDatabaseWrites,
        persistTransition: persistAndTrack,
        stopDesk: async (stopSignal) => {
          deskStopAttempted = true;
          await stopDesk(stopSignal);
        },
      },
    );
    current = frozen.record;
    compatible = frozen.compatible;
    await assertSharedInfrastructure(signal);

    await createVerifiedBackup(
      options,
      frozen.evidence,
      async (artifact) => {
        current = updateTransition(current, {
          backup_path: artifact.path,
          backup_sha256: artifact.sha256,
          shadow_database: artifact.shadow,
        });
        await persistAndTrack(current);
      },
      signal,
    );
    current = updateTransition(current, { phase: "recovery_ready" });
    await persistAndTrack(current);

    current = updateTransition(current, { phase: "migrating" });
    await persistAndTrack(current);
    await applyMigrations(current, frozen.authority, signal);
    assertMigrationLedger(
      inventory,
      await readMigrationLedger(PROFILE.services.postgresDatabase, signal),
      "exact",
    );
    await readCatalogEvidence(PROFILE.services.postgresDatabase, signal, "write_frozen");

    await switchToCandidate(current);
    current = updateTransition(current, { phase: "switched" });
    await persistAndTrack(current);
    current = await releasePersistedWriteGate(current, signal, {
      persistTransition: persistAndTrack,
    });
    await readCatalogEvidence(PROFILE.services.postgresDatabase, signal, "stable");
    await startDesk(signal);
    await assertDeskHealth(options.candidateSha, signal);
    await assertRollbackEvidence(current);
    await verifyBackupEvidence(current);
    await assertSharedInfrastructure(signal);
    assertMigrationLedger(
      inventory,
      await readMigrationLedger(PROFILE.services.postgresDatabase, signal),
      "exact",
    );

    current = updateTransition(current, { phase: "awaiting_external_verification" });
    await persistAndTrack(current);
    process.stdout.write(
      `CLOUD_RELEASE_REMOTE_AWAITING_EXTERNAL_VERIFICATION candidate_sha=${options.candidateSha}\n`,
    );
  } catch (error) {
    const migrationMayHaveStarted = [
      "migrating",
      "switched",
      "awaiting_external_verification",
    ].includes(current.phase);
    const backupNeedsRecovery = backupFailureRequiresRecovery(error);
    await rollbackOrRequireRecovery(
      current,
      !backupNeedsRecovery && (!migrationMayHaveStarted || compatible),
      deskStopAttempted,
    );
    throw error;
  }
}

async function status() {
  await ensureReleaseDirectories();
  if (!(await transitionExists())) {
    process.stdout.write("CLOUD_RELEASE_REMOTE_STATUS phase=stable\n");
    return;
  }
  const record = await readTransition();
  process.stdout.write(
    `CLOUD_RELEASE_REMOTE_STATUS phase=${record.phase} candidate_sha=${record.candidate_sha} expected_sha=${record.expected_sha} migration_head=${record.migration_head}\n`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  if (process.getuid?.() !== 0) fail("CLOUD_RELEASE_ROOT_REQUIRED");
  const options = parseArguments(argv);
  await withCloudSignalCancellation(async (signal) => {
    if (options.action === "status") await status();
    else if (options.action === "deploy") await deploy(options, signal);
    else if (options.action === "api-evidence") {
      if ((await currentRepositoryRoot()) !== LIVE_ROOT) fail("CLOUD_RELEASE_LIVE_ROOT_MISMATCH");
      process.stdout.write(`${JSON.stringify(await collectRemoteApiEvidence(options, signal))}\n`);
    } else if (options.action === "finalize") {
      await finalizeRelease(options, signal, await readBoundedEvidenceInput());
      process.stdout.write(
        `CLOUD_RELEASE_REMOTE_COMMITTED candidate_sha=${options.candidateSha}\n`,
      );
    } else {
      await rollbackRelease(options);
      process.stdout.write(
        `CLOUD_RELEASE_REMOTE_ROLLED_BACK candidate_sha=${options.candidateSha}\n`,
      );
    }
  });
}

export function isDirectEntrypoint(entry, moduleUrl) {
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href;
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof CloudReleaseError ? error.code : "CLOUD_RELEASE_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
