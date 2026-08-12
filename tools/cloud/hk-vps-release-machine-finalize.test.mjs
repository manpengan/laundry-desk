import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  ADR36_API_EVIDENCE_JOURNEYS,
  ADR36_API_EVIDENCE_VERSION,
} from "./adr36-web-acceptance-evidence.mjs";
import { CLOUD_BROWSER_EXPECTED_TEST_TITLE } from "./cloud-web-browser-evidence.mjs";
import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";
import {
  canonicalFinalizeEvidence,
  createFinalizeEvidence,
  finalizeEvidenceDigest,
  verificationEvidencePath,
} from "./hk-vps-release-finalize-evidence.mjs";
import { assertRetainedFinalizeEvidence } from "./hk-vps-release-evidence-retention.mjs";
import {
  collectFinalizeEvidence,
  parseRemoteApiEvidenceResult,
  runLocalBrowserEvidence,
} from "./hk-vps-release-local-evidence.mjs";
import { completeRemoteAction, remoteStatefulArguments } from "./hk-vps-release-local.mjs";
import {
  discoverUnboundFinalizeEvidence,
  persistFinalizeEvidence,
  readBoundedEvidenceInput,
  readPersistedFinalizeEvidence,
  runRemoteApiAcceptance,
} from "./hk-vps-release-remote-evidence.mjs";
import { finalizeRelease } from "./hk-vps-release-remote-finalize.mjs";
import {
  archiveTransition,
  prepareArchivedTransition,
  readArchivedTransition,
} from "./hk-vps-release-history.mjs";
import { collectRemoteApiEvidence } from "./hk-vps-release-remote-api.mjs";
import {
  markRecoveryRequired,
  prepareRollbackArchiveRecord,
} from "./hk-vps-release-remote-rollback.mjs";
import {
  createTransition,
  shadowDatabaseName,
  updateTransition,
} from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const TOKEN = "c".repeat(32);
const MIGRATION = "0046_cloud_primary.sql";
const NOW = new Date("2026-08-10T02:30:00.000Z");

function passedApi() {
  return Object.freeze({
    schema: "laundry.adr36.api-acceptance-evidence",
    version: ADR36_API_EVIDENCE_VERSION,
    run_id: "ADR36-20260810T022900Z-12345678",
    results: Object.freeze(
      ADR36_API_EVIDENCE_JOURNEYS.map((journey) => Object.freeze({ journey, status: "PASS" })),
    ),
  });
}

function passedBrowser() {
  return Object.freeze({
    schema: "laundry.cloud-web.browser-evidence",
    version: 1,
    run_id: "CLOUD-BROWSER-20260810T022930Z-12345678",
    test_count: 1,
    test_title: CLOUD_BROWSER_EXPECTED_TEST_TITLE,
    test_status: "PASS",
    retries: 0,
    results: Object.freeze([
      Object.freeze({ journey: "configuration", status: "PASS" }),
      Object.freeze({ journey: "core_ui_subset", status: "PASS" }),
      Object.freeze({ journey: "session_logout", status: "PASS" }),
      Object.freeze({ journey: "business_cleanup", status: "NOT_REQUIRED" }),
      Object.freeze({ journey: "standalone_completion", status: "NOT_AUTHORIZED" }),
    ]),
  });
}

function options() {
  return Object.freeze({
    candidateSha: CANDIDATE,
    expectedSha: EXPECTED,
    migrationHead: MIGRATION,
    token: TOKEN,
  });
}

function evidence(uuid = "12345678-1234-4123-8123-123456789abc", now = NOW) {
  return createFinalizeEvidence(
    Object.freeze({ api: passedApi(), browser: passedBrowser(), ...options() }),
    Object.freeze({ now: () => now, randomUUID: () => uuid }),
  );
}

function awaitingTransition() {
  const base = createTransition(
    {
      ...options(),
      archiveDigest: "4".repeat(64),
      controllerDigest: "5".repeat(64),
      controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
    },
    NOW,
  );
  const backupPath = `/var/lib/laundry-desk-release-backups/pre-${CANDIDATE}-${"d".repeat(32)}.dump`;
  return updateTransition(
    base,
    {
      app_role_original_can_login: true,
      backup_path: backupPath,
      backup_sha256: "1".repeat(64),
      compatibility_decision: "ADR-37",
      old_code_compatible: true,
      phase: "awaiting_external_verification",
      pre_migration_count: 45,
      pre_migration_head: "0045_cloud_auth.sql",
      pre_migration_ledger_sha256: "2".repeat(64),
      shadow_database: shadowDatabaseName(backupPath),
      source_catalog_sha256: "3".repeat(64),
      write_freeze_terminated_sessions: 2,
      write_freeze_verified_at: "2026-08-10T02:20:00.000Z",
      write_gate_state: "released",
    },
    NOW,
  );
}

test("remote evidence storage is atomic, private, digest-bound and safely replaceable on retry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-evidence-test-")));
  await chmod(root, 0o700);
  try {
    const uid = process.getuid();
    const gid = process.getgid();
    const record = awaitingTransition();
    const first = evidence();
    const artifact = await persistFinalizeEvidence(record, first, { gid, now: NOW, root, uid });
    assert.equal(artifact.path, verificationEvidencePath(CANDIDATE, first.token_sha256));
    let bound = updateTransition(record, {
      verification_evidence_authoritative: true,
      verification_evidence_path: artifact.path,
      verification_evidence_sha256: artifact.digest,
    });
    assert.deepEqual(
      await readPersistedFinalizeEvidence(bound, { gid, now: NOW, root, uid }),
      first,
    );

    const second = evidence("87654321-4321-4876-8876-cba987654321");
    const replacement = await persistFinalizeEvidence(record, second, { gid, now: NOW, root, uid });
    assert.notEqual(replacement.digest, artifact.digest);
    bound = updateTransition(record, {
      verification_evidence_authoritative: true,
      verification_evidence_path: replacement.path,
      verification_evidence_sha256: replacement.digest,
    });
    assert.deepEqual(
      await readPersistedFinalizeEvidence(bound, { gid, now: NOW, root, uid }),
      second,
    );
    const localPath = join(root, replacement.path.split("/").at(-1));
    const metadata = await lstat(localPath);
    assert.equal(metadata.mode & 0o7777, 0o600);
    assert.equal(
      await readFile(localPath, "utf8"),
      canonicalFinalizeEvidence(second, options(), NOW),
    );

    await chmod(localPath, 0o644);
    await assert.rejects(
      () => persistFinalizeEvidence(record, first, { gid, now: NOW, root, uid }),
      { code: "CLOUD_RELEASE_EVIDENCE_FILE_INVALID" },
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("finalize fails without canonical stdin, revalidates after persistence, and survives retry", async () => {
  let state = awaitingTransition();
  let archived = false;
  let crash = true;
  let persistCalls = 0;
  const proof = evidence(undefined, new Date());
  const canonical = canonicalFinalizeEvidence(proof, options(), new Date());
  const artifact = Object.freeze({
    digest: finalizeEvidenceDigest(proof, options(), new Date()),
    path: verificationEvidencePath(CANDIDATE, proof.token_sha256),
  });
  const dependencies = {
    archiveTransition: async (record, outcome) => {
      assert.equal(record.verification_evidence_sha256, artifact.digest);
      assert.equal(outcome, "committed");
      archived = true;
    },
    assertFinalizableState: async () => undefined,
    persistFinalizeEvidence: async () => {
      persistCalls += 1;
      return artifact;
    },
    persistTransition: async (record) => {
      if (crash) {
        crash = false;
        throw new Error("simulated crash after evidence rename");
      }
      state = record;
    },
    readPersistedFinalizeEvidence: async () => proof,
    readTransition: async () => state,
    transitionExists: async () => true,
  };
  await assert.rejects(() => finalizeRelease(options(), undefined, "", dependencies), {
    code: "CLOUD_RELEASE_EVIDENCE_JSON_INVALID",
  });
  await assert.rejects(
    () => finalizeRelease(options(), undefined, canonical, dependencies),
    /simulated crash/u,
  );
  assert.equal(state.verification_evidence_path, null);
  await finalizeRelease(options(), undefined, canonical, dependencies);
  assert.equal(persistCalls, 2);
  assert.equal(archived, true);
});

test("history records retain evidence with explicit committed or rolled-back authority", () => {
  const proof = evidence();
  const path = verificationEvidencePath(CANDIDATE, proof.token_sha256);
  const bound = updateTransition(awaitingTransition(), {
    verification_evidence_authoritative: true,
    verification_evidence_path: path,
    verification_evidence_sha256: finalizeEvidenceDigest(proof, options(), NOW),
  });
  const committed = prepareArchivedTransition(bound, "committed", NOW);
  assert.equal(committed.outcome, "committed");
  assert.equal(committed.verification_evidence_authoritative, true);
  assert.equal(committed.verification_evidence_path, path);
  const rolledBack = prepareArchivedTransition(bound, "rolled_back", NOW);
  assert.equal(rolledBack.outcome, "rolled_back");
  assert.equal(rolledBack.verification_evidence_authoritative, false);
  assert.equal(rolledBack.verification_evidence_path, path);
  assert.throws(() => prepareArchivedTransition(awaitingTransition(), "committed", NOW), {
    code: "CLOUD_RELEASE_TRANSITION_INVALID",
  });
});

test("recovery keeps prior evidence bound but makes it non-authoritative", async () => {
  const proof = evidence();
  const path = verificationEvidencePath(CANDIDATE, proof.token_sha256);
  const bound = updateTransition(awaitingTransition(), {
    verification_evidence_authoritative: true,
    verification_evidence_path: path,
    verification_evidence_sha256: finalizeEvidenceDigest(proof, options(), NOW),
  });
  let persisted;
  const recovery = await markRecoveryRequired(bound, {
    persistTransition: async (record) => {
      persisted = record;
    },
    readEvidence: async () => proof,
  });
  assert.equal(recovery.phase, "recovery_required");
  assert.equal(recovery.verification_evidence_path, path);
  assert.equal(recovery.verification_evidence_authoritative, false);
  assert.equal(persisted, recovery);
});

test("rollback discovers evidence left by a pre-binding crash and retains it without authority", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-rollback-evidence-test-")));
  const historyRoot = join(root, "history");
  await chmod(root, 0o700);
  await mkdir(historyRoot, { mode: 0o700 });
  try {
    const uid = process.getuid();
    const gid = process.getgid();
    const record = awaitingTransition();
    const proof = evidence();
    const artifact = await persistFinalizeEvidence(record, proof, { gid, now: NOW, root, uid });
    assert.equal(record.verification_evidence_path, null);
    const discoverEvidence = async (unbound) =>
      await discoverUnboundFinalizeEvidence(unbound, { gid, root, uid });

    const recovery = await markRecoveryRequired(record, {
      discoverEvidence,
      persistTransition: async () => undefined,
    });
    assert.equal(recovery.phase, "recovery_required");
    assert.equal(recovery.verification_evidence_authoritative, false);
    assert.equal(recovery.verification_evidence_path, artifact.path);
    assert.equal(recovery.verification_evidence_sha256, artifact.digest);

    const rolledBack = await prepareRollbackArchiveRecord(record, {
      discoverEvidence,
    });
    assert.equal(rolledBack.outcome, "rolled_back");
    assert.equal(rolledBack.verification_evidence_authoritative, false);
    assert.equal(rolledBack.verification_evidence_path, artifact.path);
    assert.equal(rolledBack.verification_evidence_sha256, artifact.digest);

    const transitionPath = join(root, "transition.json");
    await archiveTransition(rolledBack, "rolled_back", {
      gid,
      historyRoot,
      persistTransition: async (archived) => {
        await writeFile(transitionPath, `${JSON.stringify(archived)}\n`, { mode: 0o600 });
        await chmod(transitionPath, 0o600);
      },
      stateRoot: root,
      transitionPath,
      uid,
    });
    await assert.rejects(() => lstat(transitionPath), { code: "ENOENT" });
    await assertRetainedFinalizeEvidence({ gid, historyRoot, stateRoot: root, uid });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rollback evidence discovery fails closed on non-private, ambiguous, or non-canonical files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-rollback-invalid-test-")));
  await chmod(root, 0o700);
  try {
    const uid = process.getuid();
    const gid = process.getgid();
    const record = awaitingTransition();
    const proof = evidence();
    const artifact = await persistFinalizeEvidence(record, proof, { gid, now: NOW, root, uid });
    const path = join(root, artifact.path.split("/").at(-1));
    const discover = async () => await discoverUnboundFinalizeEvidence(record, { gid, root, uid });

    await chmod(path, 0o644);
    await assert.rejects(discover, { code: "CLOUD_RELEASE_EVIDENCE_FILE_INVALID" });
    await chmod(path, 0o600);

    const alias = join(root, "ambiguous-evidence-link");
    await link(path, alias);
    await assert.rejects(discover, { code: "CLOUD_RELEASE_EVIDENCE_FILE_INVALID" });
    await unlink(alias);

    await writeFile(path, `${canonicalFinalizeEvidence(proof, options(), NOW)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    await assert.rejects(discover, { code: "CLOUD_RELEASE_EVIDENCE_NOT_CANONICAL" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("archive persists an explicit outcome before rename and retries that crash point", async () => {
  const proof = evidence();
  const bound = updateTransition(awaitingTransition(), {
    verification_evidence_authoritative: true,
    verification_evidence_path: verificationEvidencePath(CANDIDATE, proof.token_sha256),
    verification_evidence_sha256: finalizeEvidenceDigest(proof, options(), NOW),
  });
  let state = bound;
  let crash = true;
  let renames = 0;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const dependencies = {
    historyRoot: "/private/state/history",
    lstat: async () => {
      throw missing;
    },
    now: NOW,
    open: async () => ({ close: async () => undefined, sync: async () => undefined }),
    persistTransition: async (record) => {
      state = record;
    },
    rename: async () => {
      renames += 1;
      if (crash) {
        crash = false;
        throw new Error("simulated archive crash");
      }
    },
    stateRoot: "/private/state",
    transitionPath: "/private/state/transition.json",
  };
  await assert.rejects(() => archiveTransition(state, "committed", dependencies), {
    message: "simulated archive crash",
  });
  assert.equal(state.outcome, "committed");
  assert.equal(state.verification_evidence_authoritative, true);
  await archiveTransition(state, "committed", dependencies);
  assert.equal(renames, 2);
});

test("retention accepts one-to-one retained evidence and rejects every orphan", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-retention-test-")));
  const historyRoot = join(root, "history");
  await chmod(root, 0o700);
  await mkdir(historyRoot, { mode: 0o700 });
  try {
    const proof = evidence();
    const evidencePath = verificationEvidencePath(CANDIDATE, proof.token_sha256);
    const canonical = canonicalFinalizeEvidence(proof, options(), NOW);
    const localEvidencePath = join(root, evidencePath.split("/").at(-1));
    await writeFile(localEvidencePath, canonical, { mode: 0o600 });
    await chmod(localEvidencePath, 0o600);
    const bound = updateTransition(awaitingTransition(), {
      verification_evidence_authoritative: true,
      verification_evidence_path: evidencePath,
      verification_evidence_sha256: finalizeEvidenceDigest(proof, options(), NOW),
    });
    const archived = prepareArchivedTransition(bound, "rolled_back", NOW);
    const historyPath = join(historyRoot, `${CANDIDATE}-${TOKEN}-rolled_back.json`);
    await writeFile(historyPath, `${JSON.stringify(archived)}\n`, { mode: 0o600 });
    await chmod(historyPath, 0o600);
    const transitionPath = join(root, "transition.json");
    await writeFile(transitionPath, `${JSON.stringify(archived)}\n`, { mode: 0o600 });
    await chmod(transitionPath, 0o600);
    await archiveTransition(archived, "rolled_back", {
      gid: process.getgid(),
      historyRoot,
      persistTransition: async () => assert.fail("duplicate history must not be rewritten"),
      stateRoot: root,
      transitionPath,
      uid: process.getuid(),
    });
    await assert.rejects(() => lstat(transitionPath), { code: "ENOENT" });
    assert.deepEqual(
      await readArchivedTransition(options(), "rolled_back", {
        gid: process.getgid(),
        historyRoot,
        uid: process.getuid(),
      }),
      archived,
    );
    const retentionOptions = {
      gid: process.getgid(),
      historyRoot,
      stateRoot: root,
      uid: process.getuid(),
    };
    await assertRetainedFinalizeEvidence(retentionOptions);
    const orphan = join(root, `verification-${EXPECTED}-${"f".repeat(64)}.json`);
    await writeFile(orphan, canonical, { mode: 0o600 });
    await chmod(orphan, 0o600);
    await assert.rejects(() => assertRetainedFinalizeEvidence(retentionOptions), {
      code: "CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("finalize retry reconciles exact committed history without mutating it", async () => {
  const now = new Date();
  const proof = evidence(undefined, now);
  const bound = updateTransition(
    awaitingTransition(),
    {
      verification_evidence_authoritative: true,
      verification_evidence_path: verificationEvidencePath(CANDIDATE, proof.token_sha256),
      verification_evidence_sha256: finalizeEvidenceDigest(proof, options(), now),
    },
    now,
  );
  const archived = prepareArchivedTransition(bound, "committed", now);
  let stateChecks = 0;
  const reconciled = await finalizeRelease(
    options(),
    undefined,
    canonicalFinalizeEvidence(proof, options(), now),
    {
      archiveTransition: async () => assert.fail("history must not be rewritten"),
      assertFinalizableState: async () => {
        stateChecks += 1;
      },
      persistFinalizeEvidence: async () => assert.fail("evidence must not be replaced"),
      persistTransition: async () => assert.fail("transition must not be recreated"),
      readArchivedTransition: async (identity, outcome) => {
        assert.deepEqual(identity, options());
        assert.equal(outcome, "committed");
        return archived;
      },
      readPersistedFinalizeEvidence: async (record, readOptions) => {
        assert.equal(record, archived);
        assert.equal(readOptions.allowStale, true);
        return proof;
      },
      readTransition: async () => assert.fail("no active transition may be read"),
      syncReleaseHistory: async () => undefined,
      transitionExists: async () => false,
    },
  );
  assert.equal(reconciled, archived);
  assert.equal(stateChecks, 1);
});

test("finalize retry completes an outcome persisted before the history rename", async () => {
  const now = new Date();
  const proof = evidence(undefined, now);
  const archived = prepareArchivedTransition(
    updateTransition(
      awaitingTransition(),
      {
        verification_evidence_authoritative: true,
        verification_evidence_path: verificationEvidencePath(CANDIDATE, proof.token_sha256),
        verification_evidence_sha256: finalizeEvidenceDigest(proof, options(), now),
      },
      now,
    ),
    "committed",
    now,
  );
  let completed = false;
  await finalizeRelease(options(), undefined, canonicalFinalizeEvidence(proof, options(), now), {
    archiveTransition: async (record, outcome) => {
      assert.equal(record, archived);
      assert.equal(outcome, "committed");
      completed = true;
    },
    assertFinalizableState: async () => undefined,
    readPersistedFinalizeEvidence: async () => proof,
    readTransition: async () => archived,
    transitionExists: async () => true,
  });
  assert.equal(completed, true);
});

test("API evidence also fresh-runs against an exact committed retry", async () => {
  const proof = evidence();
  const archived = prepareArchivedTransition(
    updateTransition(awaitingTransition(), {
      verification_evidence_authoritative: true,
      verification_evidence_path: verificationEvidencePath(CANDIDATE, proof.token_sha256),
      verification_evidence_sha256: finalizeEvidenceDigest(proof, options(), NOW),
    }),
    "committed",
    NOW,
  );
  const events = [];
  const result = await collectRemoteApiEvidence(options(), undefined, {
    readArchivedTransition: async () => {
      events.push("history");
      return archived;
    },
    readPersistedFinalizeEvidence: async (_record, readOptions) => {
      events.push("retained");
      assert.equal(readOptions.allowStale, true);
      return proof;
    },
    readReleaseMarker: async () => ({ git_sha: CANDIDATE }),
    runRemoteApiAcceptance: async () => {
      events.push("api");
      return passedApi();
    },
    transitionExists: async () => false,
  });
  assert.deepEqual(result, passedApi());
  assert.deepEqual(events, ["history", "retained", "api"]);
});

test("remote API subprocess is fixed, file-only, bounded and must return all-pass JSON", async () => {
  const api = passedApi();
  let invocation;
  const environment = Object.freeze({
    LANG: "C.UTF-8",
    LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD_FILE: "/fixed/admin-password",
    LAUNDRY_ADR36_DATABASE_ADMIN_URL_FILE: "/fixed/database-admin-url",
    PATH: "/opt/nodejs/bin:/usr/bin:/bin",
  });
  const result = await runRemoteApiAcceptance(undefined, {
    loadEnvironment: async () => environment,
    runCommand: async (file, arguments_, runOptions) => {
      invocation = { arguments_, file, options: runOptions };
      return Object.freeze({ code: 0, stderr: "", stdout: `${JSON.stringify(api)}\n` });
    },
  });
  assert.deepEqual(result, api);
  assert.equal(invocation.file, "/opt/nodejs/bin/node");
  assert.deepEqual(invocation.arguments_, [
    "/opt/laundry-desk/tools/cloud/adr36-web-acceptance.mjs",
    "--machine-json",
  ]);
  assert.equal(invocation.options.cwd, "/opt/laundry-desk");
  assert.equal(Object.hasOwn(invocation.options.environment, "DATABASE_ADMIN_URL"), false);
  assert.equal(Object.hasOwn(invocation.options.environment, "GH_TOKEN"), false);
  assert.equal(
    Object.hasOwn(invocation.options.environment, "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
    false,
  );

  for (const stdout of [
    `${JSON.stringify(api)}\nextra\n`,
    `${JSON.stringify({ ...api, results: [...api.results].reverse() })}\n`,
  ]) {
    await assert.rejects(
      () =>
        runRemoteApiAcceptance(undefined, {
          loadEnvironment: async () => environment,
          runCommand: async () => ({ code: 0, stderr: "", stdout }),
        }),
      { code: "CLOUD_RELEASE_API_EVIDENCE_NOT_PASSED" },
    );
  }
});

test("local collector fresh-runs API then Browser and emits one canonical bound object", async () => {
  const events = [];
  const collected = await collectFinalizeEvidence(
    {
      cwd: "/private/repository",
      environment: { GH_TOKEN: "not-in-child", HOME: "/Users/test", PATH: "/usr/bin:/bin" },
      execute: async () => assert.fail("download wrapper owns execution"),
      knownHostsPath: "/private/known-hosts",
      options: options(),
    },
    {
      now: () => NOW,
      randomUUID: () => "12345678-1234-4123-8123-123456789abc",
      runBrowserEvidence: async ({ environment }) => {
        events.push("browser");
        assert.equal(environment.LAUNDRY_CLOUD_WEB_E2E, "1");
        assert.equal(Object.hasOwn(environment, "GH_TOKEN"), false);
        return passedBrowser();
      },
      runRemoteApiEvidence: async () => {
        events.push("api");
        return { code: 0, stderr: "", stdout: `${JSON.stringify(passedApi())}\n` };
      },
      withDownloadedCredentials: async (_input, operation) =>
        await operation({
          HOME: "/Users/test",
          LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD_FILE: "/private/admin-password",
          LAUNDRY_CLOUD_WEB_E2E: "1",
          LAUNDRY_CLOUD_WEB_MACHINE_JSON: "1",
          PATH: "/usr/bin:/bin",
        }),
    },
  );
  assert.deepEqual(events, ["api", "browser"]);
  assert.deepEqual(JSON.parse(collected.canonical), collected.evidence);
  assert.equal(collected.canonical.includes(TOKEN), false);
});

test("browser subprocess runs resolved Playwright CLI directly and rejects extra stdout", async () => {
  let invocation;
  const browser = passedBrowser();
  const result = await runLocalBrowserEvidence(
    {
      cwd: "/private/repository",
      environment: { LAUNDRY_CLOUD_WEB_E2E: "1", PATH: "/usr/bin:/bin" },
      execute: async (file, arguments_, label, timeoutMs, extra) => {
        invocation = { arguments_, extra, file, label, timeoutMs };
        return { code: 0, stderr: "", stdout: `${JSON.stringify(browser)}\n` };
      },
    },
    { resolvePlaywrightCli: async () => "/private/repository/node_modules/playwright/cli.js" },
  );
  assert.deepEqual(result, browser);
  assert.equal(invocation.file, process.execPath);
  assert.deepEqual(invocation.arguments_.slice(1), [
    "test",
    "-c",
    "/private/repository/apps/web/playwright.cloud.config.ts",
  ]);
  assert.equal(invocation.label, "CLOUD_RELEASE_BROWSER_EVIDENCE");
});

test("finalize orchestration keeps evidence off argv and serializes API/finalize on one lock", async () => {
  const events = [];
  const canonical = canonicalFinalizeEvidence(evidence(), options(), NOW);
  await completeRemoteAction(
    { cwd: "/private/repository", environment: {}, signal: undefined },
    "finalize",
    options(),
    {
      assertExternalHealth: async () => events.push("health"),
      assertRepositoryCandidate: async () => events.push("repository"),
      collectFinalizeEvidence: async (_input, dependencies) => {
        events.push("collect");
        await dependencies.runRemoteApiEvidence();
        return { canonical };
      },
      remoteAction: async (_context, action, _options, _knownHosts, extra = {}) => {
        events.push(action);
        if (action === "api-evidence") {
          return { code: 0, stderr: "", stdout: `${JSON.stringify(passedApi())}\n` };
        }
        assert.equal(extra.input, canonical);
        return { code: 0, stderr: "", stdout: "" };
      },
      withPinnedSshAuthority: async (_execute, operation) =>
        await operation({ path: "/private/known-hosts" }),
    },
  );
  assert.deepEqual(events, ["repository", "health", "collect", "api-evidence", "finalize"]);
  for (const action of ["api-evidence", "finalize", "rollback"]) {
    const arguments_ = remoteStatefulArguments(action, options(), "/private/known-hosts");
    assert.ok(arguments_.includes("/run/lock/laundry-desk-cloud-release.lock"));
    assert.equal(arguments_.includes(canonical), false);
  }
});

test("bounded stdin rejects empty and oversized evidence before state mutation", async () => {
  assert.equal(await readBoundedEvidenceInput(Readable.from(["{}"])), "{}");
  await assert.rejects(
    () => readBoundedEvidenceInput(Readable.from([Buffer.alloc(64 * 1024 + 1)])),
    { code: "CLOUD_RELEASE_EVIDENCE_JSON_INVALID" },
  );
  assert.throws(() => parseRemoteApiEvidenceResult({ code: 0, stderr: "", stdout: "" }), {
    code: "CLOUD_RELEASE_API_EVIDENCE_NOT_PASSED",
  });
});
