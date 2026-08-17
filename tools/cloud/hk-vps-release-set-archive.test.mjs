import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";
import { REMOTE_RELEASE_LOCK } from "./hk-vps-release-core.mjs";
import {
  releaseTokenDigest,
  verificationEvidencePath,
} from "./hk-vps-release-finalize-evidence.mjs";
import { prepareArchivedTransition } from "./hk-vps-release-history.mjs";
import {
  archiveReleaseSet,
  listArchivableReleaseSets,
  restoreReleaseSet,
} from "./hk-vps-release-set-archive.mjs";
import {
  isDirectEntrypoint,
  lockedReleaseSetArguments,
  main,
  parseReleaseSetArguments,
} from "./hk-vps-release-set-archive-run.mjs";
import { selectReleaseSet } from "./hk-vps-release-set-inventory.mjs";
import {
  createReleaseSetManifest,
  readReleaseSetManifest,
} from "./hk-vps-release-set-manifest.mjs";
import {
  BACKUP_ROOT,
  createTransition,
  shadowDatabaseName,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "1".repeat(40);
const LIVE = "9".repeat(40);
const EXPECTED = "2".repeat(40);
const TOKEN = "3".repeat(32);
const CONTROLLER_DIGEST = "4".repeat(64);
const ARCHIVE_DIGEST = "5".repeat(64);
const MIGRATION = "0069_self_service_read_model.sql";
const NOW = new Date("2026-08-17T18:00:00.000Z");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function privateFile(path, value) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function archivedRecord(contents, options = {}) {
  const candidate = options.candidate ?? CANDIDATE;
  const expected = options.expected ?? EXPECTED;
  const token = options.token ?? TOKEN;
  const outcome = options.outcome ?? "rolled_back";
  const backupPath = `${BACKUP_ROOT}/pre-${candidate}-${token}.dump`;
  const evidencePath = verificationEvidencePath(candidate, releaseTokenDigest(token));
  const base = createTransition(
    {
      archiveDigest: ARCHIVE_DIGEST,
      candidateSha: candidate,
      controllerDigest: CONTROLLER_DIGEST,
      controllerPath: releaseControllerPath(candidate, token),
      expectedSha: expected,
      migrationHead: MIGRATION,
      token,
    },
    NOW,
  );
  const awaiting = updateTransition(
    base,
    {
      app_role_original_can_login: true,
      backup_path: backupPath,
      backup_sha256: digest(contents.backup),
      compatibility_decision: "ADR-37",
      old_code_compatible: true,
      phase: "awaiting_external_verification",
      pre_migration_count: 69,
      pre_migration_head: "0068_customer_self_service.sql",
      pre_migration_ledger_sha256: "6".repeat(64),
      shadow_database: shadowDatabaseName(backupPath),
      source_catalog_sha256: "7".repeat(64),
      verification_evidence_authoritative: true,
      verification_evidence_path: evidencePath,
      verification_evidence_sha256: digest(contents.evidence),
      write_freeze_terminated_sessions: 0,
      write_freeze_verified_at: "2026-08-17T17:50:00.000Z",
      write_gate_state: "released",
    },
    NOW,
  );
  return prepareArchivedTransition(awaiting, outcome, NOW);
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "laundry-release-set-")));
  t.after(() => rm(base, { force: true, recursive: true }));
  const roots = Object.freeze({
    archiveRoot: join(base, "archive"),
    backupRoot: join(base, "backups"),
    controllerRoot: join(base, "controllers"),
    historyRoot: join(base, "state", "history"),
    liveRoot: join(base, "live"),
    optRoot: join(base, "opt"),
    setRoot: join(base, "archive", "release-sets"),
    stateRoot: join(base, "state"),
  });
  for (const path of [
    roots.archiveRoot,
    roots.backupRoot,
    roots.controllerRoot,
    roots.liveRoot,
    roots.optRoot,
    roots.stateRoot,
  ]) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  await mkdir(roots.historyRoot, { mode: 0o700 });
  await chmod(roots.historyRoot, 0o700);

  const contents = Object.freeze({
    backup: Buffer.from("complete pg dump fixture\n"),
    backupManifest: Buffer.from('{"verified":true}\n'),
    evidence: Buffer.from('{"accepted":true}\n'),
  });
  const record = archivedRecord(contents);
  const historyName = `${record.candidate_sha}-${record.token}-${record.outcome}.json`;
  const controller = join(roots.controllerRoot, basename(record.controller_path));
  const backup = join(roots.backupRoot, basename(record.backup_path));
  const backupManifest = `${backup}.json`;
  const evidence = join(roots.stateRoot, basename(record.verification_evidence_path));
  const history = join(roots.historyRoot, historyName);
  await mkdir(controller, { mode: 0o700 });
  await chmod(controller, 0o700);
  await privateFile(join(controller, "controller.json"), "controller fixture\n");
  await privateFile(backup, contents.backup);
  await privateFile(backupManifest, contents.backupManifest);
  await privateFile(evidence, contents.evidence);
  await privateFile(history, `${JSON.stringify(record)}\n`);

  let locks = 0;
  const dependencies = {
    ...roots,
    assertBackups: async () => undefined,
    assertControllers: async () => undefined,
    assertEvidence: async () => undefined,
    assertLockHeld: async () => {
      locks += 1;
    },
    gid: process.getgid(),
    now: NOW,
    postgresGid: process.getgid(),
    processUid: 0,
    readReleaseMarker: async () => ({ git_sha: LIVE }),
    syncDirectory: async () => undefined,
    transitionExists: async () => false,
    uid: process.getuid(),
    validateController: async (path) => {
      assert.equal(basename(path), basename(record.controller_path));
      return Object.freeze({
        digest: CONTROLLER_DIGEST,
        metadata: Object.freeze({
          archive_sha256: ARCHIVE_DIGEST,
          candidate_sha: CANDIDATE,
          expected_sha: EXPECTED,
          migration_head: MIGRATION,
        }),
      });
    },
  };
  const identity = Object.freeze({
    candidateSha: CANDIDATE,
    outcome: "rolled_back",
    tokenSha256: releaseTokenDigest(TOKEN),
  });
  return Object.freeze({
    dependencies,
    identity,
    locks: () => locks,
    paths: Object.freeze({ backup, backupManifest, controller, evidence, history }),
    record,
    roots,
  });
}

async function missing(path) {
  await assert.rejects(() => lstat(path), { code: "ENOENT" });
}

test("archives and restores one complete manifest-bound release set without changing inode", async (t) => {
  const context = await fixture(t);
  const before = new Map();
  for (const [kind, path] of Object.entries(context.paths)) {
    before.set(kind, (await lstat(path)).ino);
  }

  assert.deepEqual(await listArchivableReleaseSets(context.dependencies), [context.identity]);
  const archived = await archiveReleaseSet(context.identity, context.dependencies);
  assert.deepEqual(archived, {
    candidateSha: CANDIDATE,
    itemCount: 5,
    outcome: "rolled_back",
    state: "archived",
    tokenSha256: context.identity.tokenSha256,
  });
  const bundle = await readReleaseSetManifest(context.identity, context.dependencies);
  assert.equal(bundle.manifest.items.length, 5);
  for (const item of bundle.manifest.items) {
    await missing(item.source);
    assert.equal((await lstat(item.target)).ino, Number(item.ino));
  }

  const restored = await restoreReleaseSet(context.identity, context.dependencies);
  assert.equal(restored.state, "restored");
  for (const [kind, path] of Object.entries(context.paths)) {
    assert.equal((await lstat(path)).ino, before.get(kind));
  }
  assert.equal(context.locks(), 3);
});

test("archive resumes after an interrupted prefix and is idempotent after completion", async (t) => {
  const context = await fixture(t);
  let moves = 0;
  await assert.rejects(
    () =>
      archiveReleaseSet(context.identity, {
        ...context.dependencies,
        afterMove: async ({ index }) => {
          moves += 1;
          if (index === 1) throw new Error("simulated power loss");
        },
      }),
    /simulated power loss/u,
  );
  assert.equal(moves, 2);
  const interrupted = await readReleaseSetManifest(context.identity, context.dependencies);
  assert.deepEqual(
    await Promise.all(
      interrupted.manifest.items.map(async (item) =>
        lstat(item.target).then(
          () => "archive",
          () => "active",
        ),
      ),
    ),
    ["archive", "archive", "active", "active", "active"],
  );

  assert.equal((await archiveReleaseSet(context.identity, context.dependencies)).state, "archived");
  assert.equal((await archiveReleaseSet(context.identity, context.dependencies)).state, "archived");
});

test("restore reverses a partially completed archive from its persisted manifest", async (t) => {
  const context = await fixture(t);
  await assert.rejects(() =>
    archiveReleaseSet(context.identity, {
      ...context.dependencies,
      afterMove: async ({ index }) => {
        if (index === 1) throw new Error("stop midway");
      },
    }),
  );

  assert.equal((await restoreReleaseSet(context.identity, context.dependencies)).state, "restored");
  for (const path of Object.values(context.paths)) await assert.doesNotReject(() => lstat(path));
  assert.equal((await readdir(context.roots.historyRoot)).length, 1);
});

test("manifest-bound resume refuses target collision and archived-byte tampering", async (t) => {
  const collision = await fixture(t);
  const entry = await selectReleaseSet(collision.identity, collision.dependencies);
  const created = await createReleaseSetManifest(collision.identity, entry, collision.dependencies);
  await privateFile(created.manifest.items[0].target, "collision\n");
  await assert.rejects(() => archiveReleaseSet(collision.identity, collision.dependencies), {
    code: "CLOUD_RELEASE_SET_ARCHIVE_INVALID",
  });

  const tampered = await fixture(t);
  await archiveReleaseSet(tampered.identity, tampered.dependencies);
  const bundle = await readReleaseSetManifest(tampered.identity, tampered.dependencies);
  const evidence = bundle.manifest.items.find((item) => item.kind === "evidence");
  await privateFile(evidence.target, "tampered\n");
  await assert.rejects(() => restoreReleaseSet(tampered.identity, tampered.dependencies), {
    code: "CLOUD_RELEASE_SET_ARCHIVE_INVALID",
  });
});

test("selection refuses live records, active transitions and still-referenced opt trees", async (t) => {
  const live = await fixture(t);
  assert.deepEqual(
    await listArchivableReleaseSets({
      ...live.dependencies,
      readReleaseMarker: async () => ({ git_sha: CANDIDATE }),
    }),
    [],
  );

  const transition = await fixture(t);
  await assert.rejects(
    () =>
      listArchivableReleaseSets({
        ...transition.dependencies,
        transitionExists: async () => true,
      }),
    { code: "CLOUD_RELEASE_SET_TRANSITION_ACTIVE" },
  );

  const referenced = await fixture(t);
  const rollback = join(referenced.roots.optRoot, basename(referenced.record.rollback_path));
  await mkdir(rollback, { mode: 0o755 });
  await chmod(rollback, 0o755);
  assert.deepEqual(await listArchivableReleaseSets(referenced.dependencies), []);
  await assert.rejects(() => archiveReleaseSet(referenced.identity, referenced.dependencies), {
    code: "CLOUD_RELEASE_SET_ARCHIVE_INVALID",
  });
});

test("a committed set qualifies only after a distinct committed live record supersedes it", async (t) => {
  const context = await fixture(t);
  const contents = {
    backup: await readFile(context.paths.backup),
    evidence: await readFile(context.paths.evidence),
  };
  const committed = archivedRecord(contents, { outcome: "committed" });
  await rm(context.paths.history);
  const committedPath = join(
    context.roots.historyRoot,
    `${committed.candidate_sha}-${committed.token}-committed.json`,
  );
  await privateFile(committedPath, `${JSON.stringify(committed)}\n`);
  assert.deepEqual(await listArchivableReleaseSets(context.dependencies), []);

  const live = archivedRecord(contents, {
    candidate: LIVE,
    expected: CANDIDATE,
    outcome: "committed",
    token: "8".repeat(32),
  });
  await privateFile(
    join(context.roots.historyRoot, `${live.candidate_sha}-${live.token}-committed.json`),
    `${JSON.stringify(live)}\n`,
  );
  const identity = {
    candidateSha: CANDIDATE,
    outcome: "committed",
    tokenSha256: releaseTokenDigest(TOKEN),
  };
  assert.deepEqual(await listArchivableReleaseSets(context.dependencies), [identity]);
  assert.equal((await archiveReleaseSet(identity, context.dependencies)).state, "archived");
});

test("cross-device plans fail before a manifest or any source move", async (t) => {
  const context = await fixture(t);
  const inspect = context.dependencies.lstat ?? lstat;
  await assert.rejects(
    () =>
      archiveReleaseSet(context.identity, {
        ...context.dependencies,
        lstat: async (path) => {
          const metadata = await inspect(path);
          if (path !== context.roots.archiveRoot) return metadata;
          return Object.assign(Object.create(Object.getPrototypeOf(metadata)), metadata, {
            dev: metadata.dev + 1,
          });
        },
      }),
    { code: "CLOUD_RELEASE_SET_ARCHIVE_INVALID" },
  );
  for (const path of Object.values(context.paths)) await assert.doesNotReject(() => lstat(path));
});

test("CLI grammar and locked launcher expose only token digest, never the raw token", async () => {
  const identity = {
    candidateSha: CANDIDATE,
    tokenSha256: releaseTokenDigest(TOKEN),
    outcome: "rolled_back",
  };
  const parsed = parseReleaseSetArguments([
    "archive",
    identity.candidateSha,
    identity.tokenSha256,
    identity.outcome,
  ]);
  assert.deepEqual(parsed, { action: "archive", identity });
  assert.deepEqual(parseReleaseSetArguments(["list"]), { action: "list", identity: null });
  for (const arguments_ of [
    [],
    ["archive", CANDIDATE, TOKEN, "rolled_back"],
    ["restore", CANDIDATE, identity.tokenSha256, "pending"],
    ["list", CANDIDATE],
  ]) {
    assert.throws(() => parseReleaseSetArguments(arguments_), {
      code: "CLOUD_RELEASE_SET_ARGS_INVALID",
    });
  }

  const script = "/opt/laundry-desk/tools/cloud/hk-vps-release-set-archive-run.mjs";
  const locked = lockedReleaseSetArguments(script, parsed);
  assert.deepEqual(locked.slice(0, 9), [
    "--no-fork",
    "--exclusive",
    "--nonblock",
    "--conflict-exit-code",
    "73",
    REMOTE_RELEASE_LOCK,
    "/opt/nodejs/bin/node",
    script,
    "--lock-held",
  ]);
  assert.equal(locked.includes(TOKEN), false);

  const output = [];
  await main(["--lock-held", "list"], {
    listReleaseSets: async () => [identity],
    processUid: 0,
    stdout: { write: (value) => output.push(value) },
  });
  assert.equal(output.join("").includes(identity.tokenSha256), true);
  assert.equal(output.join("").includes(TOKEN), false);
});

test("runner self-execution check is exact", () => {
  const moduleUrl = new URL("./hk-vps-release-set-archive-run.mjs", import.meta.url).href;
  assert.equal(isDirectEntrypoint(undefined, moduleUrl), false);
  assert.equal(isDirectEntrypoint("/other.mjs", moduleUrl), false);
});
