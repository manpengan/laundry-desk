import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  CONTROLLER_ENTRY,
  releaseControllerLauncherPath,
  releaseControllerPath,
} from "./hk-vps-release-controller-contract.mjs";
import {
  cleanupUnboundReleaseControllers,
  assertRetainedReleaseControllers,
} from "./hk-vps-release-controller-retention.mjs";
import { selectRollbackEntry, validateController } from "./hk-vps-release-controller-launcher.mjs";
import { installReleaseController } from "./hk-vps-release-controller.mjs";
import { remoteStatefulArguments } from "./hk-vps-release-local.mjs";
import {
  prepareRollbackArchiveRecord,
  rollbackOrRequireRecovery,
} from "./hk-vps-release-remote-rollback.mjs";
import { installAndPersistReleaseController } from "./hk-vps-release-remote.mjs";
import {
  createTransition,
  shadowDatabaseName,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "a".repeat(40);
const CANDIDATE_2 = "e".repeat(40);
const EXPECTED = "b".repeat(40);
const TOKEN = "c".repeat(32);
const TOKEN_2 = "f".repeat(32);
const ARCHIVE = "1".repeat(64);
const ARCHIVE_2 = "2".repeat(64);
const MIGRATION = "0046_cloud_primary.sql";

function input(overrides = {}) {
  return Object.freeze({
    archiveDigest: ARCHIVE,
    candidateSha: CANDIDATE,
    expectedSha: EXPECTED,
    migrationHead: MIGRATION,
    token: TOKEN,
    ...overrides,
  });
}

function request(options = input()) {
  return Object.freeze({
    candidate_sha: options.candidateSha,
    expected_sha: options.expectedSha,
    migration_head: options.migrationHead,
    schema: "laundry.cloud-release.rollback-request",
    token: options.token,
    version: 1,
  });
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-controller-test-")));
  const sourceRoot = join(root, "source");
  const sourceCloud = join(sourceRoot, "tools/cloud");
  const controllerRoot = join(root, "controllers");
  await mkdir(sourceCloud, { mode: 0o755, recursive: true });
  await chmod(join(sourceRoot, "tools"), 0o755);
  await chmod(sourceCloud, 0o755);
  await mkdir(controllerRoot, { mode: 0o700 });
  await chmod(controllerRoot, 0o700);
  for (const [name, source] of [
    ["hk-vps-release-controller-launcher.mjs", "export const launcher = 1;\n"],
    ["hk-vps-release-rollback-entry.mjs", "export async function runRollbackRequest() {}\n"],
  ]) {
    await writeFile(join(sourceCloud, name), source, { mode: 0o644 });
    await chmod(join(sourceCloud, name), 0o644);
  }
  return Object.freeze({ controllerRoot, root, sourceCloud, sourceRoot });
}

async function install(files, options = input()) {
  const uid = process.getuid();
  const gid = process.getgid();
  const artifact = await installReleaseController(files.sourceRoot, options, {
    gid,
    root: files.controllerRoot,
    uid,
  });
  return Object.freeze({ artifact, gid, uid });
}

function transition(artifact, options = input()) {
  return createTransition({
    ...options,
    controllerDigest: artifact.digest,
    controllerPath: artifact.path,
  });
}

function migrated(record, phase) {
  const backup = `/var/lib/laundry-desk-release-backups/pre-${record.candidate_sha}-${"d".repeat(32)}.dump`;
  return updateTransition(record, {
    app_role_original_can_login: true,
    backup_path: [
      "recovery_ready",
      "migrating",
      "switched",
      "awaiting_external_verification",
    ].includes(phase)
      ? backup
      : null,
    backup_sha256: [
      "recovery_ready",
      "migrating",
      "switched",
      "awaiting_external_verification",
    ].includes(phase)
      ? "3".repeat(64)
      : null,
    compatibility_decision: "ADR-37",
    old_code_compatible: true,
    phase,
    pre_migration_count: 45,
    pre_migration_head: "0045_cloud_auth.sql",
    pre_migration_ledger_sha256: "4".repeat(64),
    shadow_database: [
      "recovery_ready",
      "migrating",
      "switched",
      "awaiting_external_verification",
    ].includes(phase)
      ? shadowDatabaseName(backup)
      : null,
    source_catalog_sha256: "5".repeat(64),
    write_freeze_terminated_sessions: 0,
    write_freeze_verified_at: "2026-08-10T02:00:00.000Z",
    write_gate_state: phase === "awaiting_external_verification" ? "released" : "active",
  });
}

test("controller publish is private, recursive, digest-bound, idempotent and concurrently safe", async () => {
  const files = await fixture();
  try {
    const first = await install(files);
    const localPath = join(files.controllerRoot, basename(first.artifact.path));
    const validated = await validateController(request(), {
      gid: first.gid,
      root: files.controllerRoot,
      uid: first.uid,
    });
    assert.equal(validated.path, localPath);
    assert.equal(validated.digest, first.artifact.digest);
    assert.ok(
      JSON.parse(await readFile(join(localPath, "files.json"), "utf8")).some(
        (item) => item.path === CONTROLLER_ENTRY,
      ),
    );
    assert.equal((await lstat(localPath)).mode & 0o7777, 0o700);

    const retried = await install(files);
    assert.deepEqual(retried.artifact, first.artifact);
    await assert.rejects(() => install(files, input({ archiveDigest: ARCHIVE_2 })), {
      code: "CLOUD_RELEASE_CONTROLLER_ARCHIVE_MISMATCH",
    });

    const second = input({
      archiveDigest: ARCHIVE_2,
      candidateSha: CANDIDATE_2,
      token: TOKEN_2,
    });
    await writeFile(
      join(files.sourceCloud, "hk-vps-release-controller-launcher.mjs"),
      "export const launcher = 2;\n",
    );
    const published = await Promise.all([install(files, second), install(files, second)]);
    assert.deepEqual(published[0].artifact, published[1].artifact);
    assert.notEqual(published[0].artifact.digest, first.artifact.digest);
    assert.equal((await readdir(files.controllerRoot)).length, 2);
  } finally {
    await rm(files.root, { force: true, recursive: true });
  }
});

test("controller validation fails closed on tamper, symlink and hardlink ambiguity", async () => {
  for (const kind of ["tamper", "symlink", "hardlink"]) {
    const files = await fixture();
    try {
      const installed = await install(files);
      const path = join(files.controllerRoot, basename(installed.artifact.path), CONTROLLER_ENTRY);
      if (kind === "tamper") await writeFile(path, "tampered\n");
      if (kind === "symlink") {
        await unlink(path);
        await symlink("controller.json", path);
      }
      if (kind === "hardlink") await link(path, join(files.controllerRoot, "ambiguous-link"));
      await assert.rejects(
        () =>
          validateController(request(), {
            gid: installed.gid,
            root: files.controllerRoot,
            uid: installed.uid,
          }),
        { code: /^CLOUD_RELEASE_CONTROLLER_/u },
      );
    } finally {
      await rm(files.root, { force: true, recursive: true });
    }
  }
});

test("every rollback phase selects the retained controller, including both live rename windows", async () => {
  const artifact = Object.freeze({
    digest: "6".repeat(64),
    path: releaseControllerPath(CANDIDATE, TOKEN),
  });
  const base = transition(artifact);
  const controller = Object.freeze({
    digest: artifact.digest,
    metadata: Object.freeze({ archive_sha256: ARCHIVE }),
    path: artifact.path,
  });
  const records = [
    base,
    ...[
      "write_frozen",
      "recovery_ready",
      "migrating",
      "switched",
      "awaiting_external_verification",
    ].map((phase) => migrated(base, phase)),
    updateTransition(migrated(base, "migrating"), { phase: "recovery_required" }),
  ];
  for (const record of records) {
    assert.equal(
      selectRollbackEntry(record, request(), controller),
      join(artifact.path, CONTROLLER_ENTRY),
    );
  }
});

test("rollback uses the versioned controller with identity only on canonical stdin", () => {
  const arguments_ = remoteStatefulArguments("rollback", input(), "/private/known-hosts");
  assert.ok(arguments_.includes(releaseControllerLauncherPath(CANDIDATE, TOKEN)));
  assert.equal(
    arguments_.includes("/opt/laundry-desk/tools/cloud/hk-vps-release-remote.mjs"),
    false,
  );
  assert.equal(arguments_.includes(TOKEN), false);
  assert.equal(arguments_.includes("--candidate-sha"), false);
});

test("publish-before-transition crashes reconcile automatically and incomplete publish never persists", async () => {
  const files = await fixture();
  try {
    const installed = await install(files);
    let persists = 0;
    await assert.rejects(
      () =>
        installAndPersistReleaseController(input(), "/opt/laundry-desk.next-test", async () => {}, {
          installController: async () => installed.artifact,
          persistTransition: async () => {
            persists += 1;
            throw new Error("crash after publish before transition durability");
          },
        }),
      /crash after publish/u,
    );
    assert.equal(persists, 1);
    await cleanupUnboundReleaseControllers({
      controllerRoot: files.controllerRoot,
      gid: installed.gid,
      records: async () => [],
      uid: installed.uid,
    });
    assert.deepEqual(await readdir(files.controllerRoot), []);

    persists = 0;
    await assert.rejects(
      () =>
        installAndPersistReleaseController(input(), "/opt/laundry-desk.next-test", async () => {}, {
          installController: async () => {
            throw new Error("crash before publish");
          },
          persistTransition: async () => {
            persists += 1;
          },
        }),
      /crash before publish/u,
    );
    assert.equal(persists, 0);
  } finally {
    await rm(files.root, { force: true, recursive: true });
  }
});

test("retained controller remains history-bound for rollback response-loss retry", async () => {
  const files = await fixture();
  try {
    const installed = await install(files);
    const record = updateTransition(transition(installed.artifact), {
      outcome: "rolled_back",
      verification_evidence_authoritative: false,
    });
    await assertRetainedReleaseControllers({
      controllerRoot: files.controllerRoot,
      gid: installed.gid,
      records: async () => [record],
      uid: installed.uid,
    });
    await cleanupUnboundReleaseControllers({
      controllerRoot: files.controllerRoot,
      gid: installed.gid,
      records: async () => [record],
      uid: installed.uid,
    });
    assert.deepEqual(await readdir(files.controllerRoot), [basename(installed.artifact.path)]);
    assert.equal(
      selectRollbackEntry(
        record,
        request(),
        Object.freeze({
          digest: installed.artifact.digest,
          metadata: Object.freeze({ archive_sha256: ARCHIVE }),
          path: installed.artifact.path,
        }),
      ),
      join(installed.artifact.path, CONTROLLER_ENTRY),
    );
  } finally {
    await rm(files.root, { force: true, recursive: true });
  }
});

test("staged controller rollback idempotently restores Desk after the stop durability gap", async () => {
  const artifact = Object.freeze({
    digest: "6".repeat(64),
    path: releaseControllerPath(CANDIDATE, TOKEN),
  });
  const record = transition(artifact);
  for (const initiallyRunning of [false, true]) {
    let running = initiallyRunning;
    let starts = 0;
    let history;
    await rollbackOrRequireRecovery(record, true, false, {
      archiveRolledBackTransition: async (current) => {
        history = await prepareRollbackArchiveRecord(current, {
          discoverEvidence: async () => null,
        });
      },
      assertDeskHealth: async (expectedSha) => {
        assert.equal(expectedSha, EXPECTED);
        assert.equal(running, true);
      },
      assertSharedInfrastructure: async () => assert.equal(running, true),
      removeOrphanStaging: async (current) => assert.equal(current, record),
      startDesk: async () => {
        starts += 1;
        running = true;
      },
    });
    assert.equal(starts, 1);
    assert.equal(history.outcome, "rolled_back");
    assert.equal(history.verification_evidence_authoritative, false);
    assert.equal(history.controller_path, record.controller_path);
    assert.equal(history.controller_sha256, record.controller_sha256);
  }
});

test("staged rollback releases every persisted gate state before starting Desk", async () => {
  const artifact = Object.freeze({
    digest: "6".repeat(64),
    path: releaseControllerPath(CANDIDATE, TOKEN),
  });
  const base = transition(artifact);
  for (const state of [null, "intent", "active", "released"]) {
    const record =
      state === null
        ? base
        : updateTransition(base, {
            app_role_original_can_login: true,
            write_gate_state: state,
          });
    const events = [];
    let archived;
    await rollbackOrRequireRecovery(record, true, false, {
      archiveRolledBackTransition: async (current) => {
        archived = current;
        events.push("archive");
      },
      assertDeskHealth: async () => events.push("health"),
      assertSharedInfrastructure: async () => events.push("shared"),
      persistTransition: async (current) => events.push(`persist:${current.write_gate_state}`),
      releaseWriteGate: async () => events.push("login"),
      removeOrphanStaging: async () => events.push("cleanup"),
      startDesk: async () => events.push("start"),
    });
    const expectedPrefix = state === null ? ["start"] : ["login", "persist:released", "start"];
    assert.deepEqual(events.slice(0, expectedPrefix.length), expectedPrefix);
    assert.equal(archived.write_gate_state, state === null ? null : "released");
  }
});

test("compatible rollback restores code, releases LOGIN, then starts old Desk", async () => {
  const artifact = Object.freeze({
    digest: "6".repeat(64),
    path: releaseControllerPath(CANDIDATE, TOKEN),
  });
  const record = migrated(transition(artifact), "write_frozen");
  const events = [];
  let archived;
  await rollbackOrRequireRecovery(record, true, true, {
    archiveRolledBackTransition: async (current) => {
      archived = current;
      events.push("archive");
    },
    persistTransition: async (current) => events.push(`persist:${current.write_gate_state}`),
    releaseWriteGate: async () => events.push("login"),
    removeOrphanStaging: async () => events.push("cleanup"),
    restorePreviousCode: async (_current, restoreDependencies) => {
      events.push("restore-code");
      await restoreDependencies.beforeStart();
      events.push("start-old");
    },
  });
  assert.deepEqual(events, [
    "restore-code",
    "login",
    "persist:released",
    "start-old",
    "cleanup",
    "archive",
  ]);
  assert.equal(archived.write_gate_state, "released");
});

test("incompatible migrated recovery reacquires NOLOGIN and stays stopped", async () => {
  const artifact = Object.freeze({
    digest: "6".repeat(64),
    path: releaseControllerPath(CANDIDATE, TOKEN),
  });
  const record = updateTransition(migrated(transition(artifact), "switched"), {
    compatibility_decision: "unproven",
    old_code_compatible: false,
    write_gate_state: "released",
  });
  const events = [];
  let lastPersisted;
  await assert.rejects(
    () =>
      rollbackOrRequireRecovery(record, false, true, {
        activateWriteGate: async () => events.push("nologin"),
        markRecoveryRequired: async (current) => {
          events.push("mark-recovery");
          return current;
        },
        persistTransition: async (current) => {
          lastPersisted = current;
          events.push(`persist:${current.phase}:${current.write_gate_state}`);
        },
        stopDesk: async () => events.push("stop"),
      }),
    { code: "CLOUD_RELEASE_RECOVERY_REQUIRED" },
  );
  assert.deepEqual(events, [
    "stop",
    "persist:recovery_required:intent",
    "nologin",
    "persist:recovery_required:active",
    "mark-recovery",
  ]);
  assert.equal(lastPersisted.write_gate_state, "active");
});

test("staged controller rollback start failure becomes recovery_required without losing binding", async () => {
  const artifact = Object.freeze({
    digest: "6".repeat(64),
    path: releaseControllerPath(CANDIDATE, TOKEN),
  });
  const record = transition(artifact);
  let recovery;
  await assert.rejects(
    () =>
      rollbackOrRequireRecovery(record, true, false, {
        discoverEvidence: async () => null,
        persistTransition: async (current) => {
          recovery = current;
        },
        startDesk: async () => {
          throw new Error("service start failed");
        },
        transitionExists: async () => true,
      }),
    { code: "CLOUD_RELEASE_RECOVERY_REQUIRED" },
  );
  assert.equal(recovery.phase, "recovery_required");
  assert.equal(recovery.outcome, null);
  assert.equal(recovery.controller_path, record.controller_path);
  assert.equal(recovery.controller_sha256, record.controller_sha256);
  assert.equal(recovery.archive_sha256, record.archive_sha256);
});
