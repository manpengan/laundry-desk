import assert from "node:assert/strict";
import { constants } from "node:fs";
import test from "node:test";

import { migrationLedgerDigest } from "./hk-vps-release-remote-db-evidence.mjs";
import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";
import {
  MIGRATION_SCRIPT,
  applyMigrations,
  createDump,
  createVerifiedBackup,
  ensureBackupRoot,
  freezeDatabaseWrites,
  readCatalogEvidence,
  restorePrivateBackup,
} from "./hk-vps-release-remote-db.mjs";
import {
  backupFailureRequiresRecovery,
  enterWriteFreeze,
  freezeAndPrepareStaging,
} from "./hk-vps-release-remote.mjs";
import {
  BACKUP_ROOT,
  assertPrivateBackupFile,
  createTransition,
} from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const TOKEN = "c".repeat(32);
const BACKUP_PATH = `${BACKUP_ROOT}/pre-${CANDIDATE}-${TOKEN}.dump`;
const LEDGER = Object.freeze([
  Object.freeze({ filename: "0045_cloud_auth.sql", checksum: "1".repeat(64) }),
]);
const CATALOG = Object.freeze({ entries: 9, sha256: "2".repeat(64) });

function directoryMetadata({ gid = 0, mode = 0o755, symlink = false, uid = 0 } = {}) {
  return Object.freeze({
    gid,
    isDirectory: () => true,
    isSymbolicLink: () => symlink,
    mode,
    uid,
  });
}

function fileMetadata({ gid = 0, mode = 0o600, size = 2048, uid = 0 } = {}) {
  return Object.freeze({
    gid,
    isFile: () => true,
    isSymbolicLink: () => false,
    mode,
    size,
    uid,
  });
}

function missing() {
  const error = new Error("missing");
  error.code = "ENOENT";
  return error;
}

test("backup root is created under root-owned parents with root:postgres 0710 authority", async () => {
  const events = [];
  let rootCreated = false;
  const dependencies = {
    postgresGid: async () => 777,
    lstat: async (path) => {
      events.push(`lstat:${path}`);
      if (path === BACKUP_ROOT && !rootCreated) throw missing();
      return path === BACKUP_ROOT
        ? directoryMetadata({ gid: 777, mode: 0o710 })
        : directoryMetadata();
    },
    realpath: async (path) => path,
    mkdir: async (path, options) => {
      events.push(`mkdir:${path}:${options.mode.toString(8)}`);
      rootCreated = true;
    },
    chown: async (path, uid, gid) => events.push(`chown:${path}:${uid}:${gid}`),
    chmod: async (path, mode) => events.push(`chmod:${path}:${mode.toString(8)}`),
  };
  await ensureBackupRoot(dependencies);
  assert.deepEqual(events.slice(-4), [
    `mkdir:${BACKUP_ROOT}:700`,
    `chown:${BACKUP_ROOT}:0:777`,
    `chmod:${BACKUP_ROOT}:710`,
    `lstat:${BACKUP_ROOT}`,
  ]);
});

test("backup root rejects replaceable parents and postgres-owned final directories", async () => {
  let changed = false;
  const dependencies = (metadataFor) => ({
    postgresGid: async () => 777,
    lstat: async (path) => metadataFor(path),
    realpath: async (path) => path,
    mkdir: async () => {
      changed = true;
    },
    chown: async () => {
      changed = true;
    },
    chmod: async () => {
      changed = true;
    },
  });
  await assert.rejects(
    () =>
      ensureBackupRoot(
        dependencies((path) =>
          path === "/var/lib"
            ? directoryMetadata({ symlink: true })
            : directoryMetadata({ gid: 777, mode: 0o710 }),
        ),
      ),
    { code: "CLOUD_RELEASE_BACKUP_ROOT_INVALID" },
  );
  await assert.rejects(
    () =>
      ensureBackupRoot(
        dependencies((path) =>
          path === BACKUP_ROOT
            ? directoryMetadata({ gid: 777, mode: 0o710, uid: 999 })
            : directoryMetadata(),
        ),
      ),
    { code: "CLOUD_RELEASE_BACKUP_ROOT_INVALID" },
  );
  assert.equal(changed, false);
});

test("dump target is root O_EXCL, briefly handed to postgres, and reclaimed on success", async () => {
  const events = [];
  const metadata = fileMetadata();
  const result = await createDump(BACKUP_PATH, undefined, {
    open: async (path, flags, mode) => {
      events.push({ kind: "open", path, flags, mode });
      return { close: async () => events.push({ kind: "close" }) };
    },
    runCloudCommand: async (_file, _arguments, options) => events.push(options.label),
    lstat: async () => metadata,
    syncPath: async () => events.push("sync"),
  });
  assert.equal(result, metadata);
  const opened = events[0];
  assert.equal(opened.mode, 0o600);
  assert.equal((opened.flags & constants.O_EXCL) !== 0, true);
  assert.equal((opened.flags & constants.O_NOFOLLOW) !== 0, true);
  assert.deepEqual(events.slice(2), [
    "CLOUD_RELEASE_DUMP_HANDOFF",
    "CLOUD_RELEASE_DATABASE_DUMP",
    "CLOUD_RELEASE_DUMP_RECLAIM",
    "sync",
  ]);
});

test("dump failure still reclaims the temporary file before propagating", async () => {
  const events = [];
  await assert.rejects(
    () =>
      createDump(BACKUP_PATH, undefined, {
        open: async () => ({ close: async () => undefined }),
        runCloudCommand: async (_file, _arguments, options) => {
          events.push(options.label);
          if (options.label === "CLOUD_RELEASE_DATABASE_DUMP") throw new Error("dump failed");
        },
        lstat: async () => fileMetadata(),
        syncPath: async () => undefined,
      }),
    /dump failed/u,
  );
  assert.deepEqual(events, [
    "CLOUD_RELEASE_DUMP_HANDOFF",
    "CLOUD_RELEASE_DATABASE_DUMP",
    "CLOUD_RELEASE_DUMP_RECLAIM",
  ]);
});

test("published backup evidence rejects postgres-owned dump or manifest metadata", () => {
  assert.doesNotThrow(() => assertPrivateBackupFile(fileMetadata()));
  assert.throws(() => assertPrivateBackupFile(fileMetadata({ gid: 777, uid: 999 })), {
    code: "CLOUD_RELEASE_BACKUP_INVALID",
  });
});

test("shadow restore streams a root-private dump instead of opening it as postgres", async () => {
  let invocation;
  await restorePrivateBackup(BACKUP_PATH, `laundry_release_verify_${TOKEN}`, undefined, {
    runCloudCommand: async (file, arguments_, options) => {
      invocation = { arguments_, file, options };
      return { code: 0, stderr: "", stdout: "" };
    },
  });
  assert.equal(invocation.file, "/bin/bash");
  assert.deepEqual(invocation.arguments_.slice(-3), [
    "laundry-release-shadow-restore",
    `laundry_release_verify_${TOKEN}`,
    BACKUP_PATH,
  ]);
  assert.match(invocation.arguments_[3], /pg_restore[^<]+< "\$2"$/u);
  assert.doesNotMatch(invocation.arguments_[3], /pg_restore[^<]+"\$2"/u);
  assert.equal(invocation.options.label, "CLOUD_RELEASE_SHADOW_RESTORE");
});

test("database freeze terminates sessions before reading the final ledger and catalog", async () => {
  const events = [];
  const result = await freezeDatabaseWrites(undefined, {
    activateWriteGate: async () => {
      events.push("terminate-and-verify");
      return { terminatedSessions: 2 };
    },
    readMigrationLedger: async () => {
      events.push("ledger");
      return LEDGER;
    },
    readCatalogEvidence: async (_database, _signal, state) => {
      events.push(`catalog:${state}`);
      return CATALOG;
    },
    now: () => new Date("2026-08-10T01:02:03.000Z"),
  });
  assert.deepEqual(events, ["terminate-and-verify", "ledger", "catalog:write_frozen"]);
  assert.equal(result.terminatedSessions, 2);
  assert.equal(result.ledger, LEDGER);
  assert.equal(result.verifiedAt, "2026-08-10T01:02:03.000Z");
});

test("catalog query forwards an explicit stable or write_frozen cluster contract", async () => {
  const states = [];
  for (const state of ["write_frozen", "stable"]) {
    const evidence = await readCatalogEvidence("laundry_v2", undefined, state, {
      parseCatalogEvidence: (source, policy, clusterState) => {
        assert.equal(source, "catalog rows\n");
        assert.equal(policy, undefined);
        states.push(clusterState);
        return CATALOG;
      },
      postgresCommand: async () => ({ stdout: "catalog rows\n" }),
    });
    assert.equal(evidence, CATALOG);
  }
  assert.deepEqual(states, ["write_frozen", "stable"]);
});

test("write gate intent precedes NOLOGIN and write_frozen follows final evidence", async () => {
  const events = [];
  const targetLedger = Object.freeze([
    ...LEDGER,
    Object.freeze({ filename: "0046_cloud_primary.sql", checksum: "4".repeat(64) }),
  ]);
  const record = createTransition({
    archiveDigest: "5".repeat(64),
    candidateSha: CANDIDATE,
    controllerDigest: "6".repeat(64),
    controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
    expectedSha: EXPECTED,
    migrationHead: "0046_cloud_primary.sql",
    token: TOKEN,
  });
  const evidence = Object.freeze({
    catalog: CATALOG,
    ledger: LEDGER,
    terminatedSessions: 2,
    verifiedAt: "2026-08-10T01:02:03.000Z",
  });
  const result = await enterWriteFreeze(
    record,
    targetLedger,
    [
      {
        decision: "ADR-37",
        from_migration: "0045_cloud_auth.sql",
        old_code_compatible: true,
        to_migration: "0046_cloud_primary.sql",
      },
    ],
    undefined,
    {
      inspectWriteGate: async () => events.push("inspect-role"),
      stopDesk: async () => events.push("stop"),
      freezeDatabaseWrites: async () => {
        events.push("nologin-and-database-evidence");
        return evidence;
      },
      persistTransition: async (transition) =>
        events.push(`persist:${transition.phase}:${transition.write_gate_state}`),
    },
  );
  assert.deepEqual(events, [
    "stop",
    "inspect-role",
    "persist:staged:intent",
    "nologin-and-database-evidence",
    "persist:write_frozen:active",
  ]);
  assert.equal(result.record.pre_migration_ledger_sha256, migrationLedgerDigest(LEDGER));
  assert.equal(result.record.source_catalog_sha256, CATALOG.sha256);
  assert.equal(result.record.write_freeze_terminated_sessions, 2);

  const failedEvents = [];
  await assert.rejects(
    () =>
      enterWriteFreeze(record, targetLedger, [], undefined, {
        inspectWriteGate: async () => failedEvents.push("inspect-role"),
        stopDesk: async () => {
          failedEvents.push("stop");
          throw new Error("stop failed");
        },
        freezeDatabaseWrites: async () => failedEvents.push("database-evidence"),
        persistTransition: async () => failedEvents.push("persist"),
      }),
    /stop failed/u,
  );
  assert.deepEqual(failedEvents, ["stop"]);
});

test("write freeze never attempts NOLOGIN when intent durability fails", async () => {
  const events = [];
  const record = createTransition({
    archiveDigest: "5".repeat(64),
    candidateSha: CANDIDATE,
    controllerDigest: "6".repeat(64),
    controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
    expectedSha: EXPECTED,
    migrationHead: "0046_cloud_primary.sql",
    token: TOKEN,
  });
  await assert.rejects(
    () =>
      enterWriteFreeze(record, LEDGER, [], undefined, {
        freezeDatabaseWrites: async () => events.push("nologin"),
        inspectWriteGate: async () => events.push("inspect"),
        persistTransition: async (next) => {
          events.push(`persist:${next.write_gate_state}`);
          throw new Error("intent fsync failed");
        },
        stopDesk: async () => events.push("stop"),
      }),
    /intent fsync failed/u,
  );
  assert.deepEqual(events, ["stop", "inspect", "persist:intent"]);
});

test("write freeze leaves durable intent when activation fails after ALTER ROLE", async () => {
  const events = [];
  const record = createTransition({
    archiveDigest: "5".repeat(64),
    candidateSha: CANDIDATE,
    controllerDigest: "6".repeat(64),
    controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
    expectedSha: EXPECTED,
    migrationHead: "0046_cloud_primary.sql",
    token: TOKEN,
  });
  await assert.rejects(
    () =>
      enterWriteFreeze(record, LEDGER, [], undefined, {
        freezeDatabaseWrites: async () => {
          events.push("altered-to-nologin");
          throw new Error("crash before active persistence");
        },
        inspectWriteGate: async () => events.push("inspect"),
        persistTransition: async (next) => events.push(`persist:${next.write_gate_state}`),
        stopDesk: async () => events.push("stop"),
      }),
    /crash before active persistence/u,
  );
  assert.deepEqual(events, ["stop", "inspect", "persist:intent", "altered-to-nologin"]);
});

test("shadow locator and pending manifest persist before drill, and drill failure is recoverable", async () => {
  const events = [];
  let failure;
  try {
    await createVerifiedBackup(
      { candidateSha: CANDIDATE, expectedSha: EXPECTED, token: TOKEN },
      { catalog: CATALOG, ledger: LEDGER },
      async (artifact) => events.push(`locator:${artifact.shadow}`),
      undefined,
      {
        ensureBackupRoot: async () => events.push("root"),
        createBackupPath: () => BACKUP_PATH,
        createDump: async () => events.push("dump"),
        publishBackup: async () => {
          events.push("publish-dump");
          return { size: 2048 };
        },
        sha256File: async () => "3".repeat(64),
        publishManifest: async (_path, manifest) =>
          events.push(`manifest:${manifest.shadow_restore}`),
        drillBackup: async () => {
          events.push("drill-drop-failed");
          throw new Error("drop failed");
        },
        unlink: async (path) => events.push(`unlink:${path}`),
        now: () => new Date("2026-08-10T01:02:03.000Z"),
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "CLOUD_RELEASE_BACKUP_RECOVERY_REQUIRED");
  assert.equal(backupFailureRequiresRecovery(failure), true);
  assert.deepEqual(events.slice(0, 6), [
    "root",
    "dump",
    "publish-dump",
    "manifest:pending",
    `locator:laundry_release_verify_${TOKEN}`,
    "drill-drop-failed",
  ]);
  assert.deepEqual(
    events.filter((event) => event.startsWith("unlink:")),
    [`unlink:${BACKUP_PATH}.tmp-${TOKEN}`],
  );
});

test("migration runner sources secrets locally and passes only an explicit clean environment", () => {
  assert.doesNotMatch(MIGRATION_SCRIPT, /set -a|set \+a/u);
  assert.match(MIGRATION_SCRIPT, /^\. "\$env_file"$/mu);
  assert.match(MIGRATION_SCRIPT, /exec \/usr\/bin\/env -i/u);
  for (const name of [
    "LANG",
    "LC_ALL",
    "PATH",
    "HOME",
    "TMPDIR",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
  ]) {
    assert.match(MIGRATION_SCRIPT, new RegExp(`${name}=`, "u"));
  }
  assert.doesNotMatch(MIGRATION_SCRIPT, /LAUNDRY_PUBLIC_ORIGIN|JWT_SECRET|TWILIO|OPENAI/u);
});

test("Desk stop and durable write-gate intent precede every staging ownership handoff", async () => {
  const events = [];
  const record = createTransition({
    archiveDigest: "5".repeat(64),
    candidateSha: CANDIDATE,
    controllerDigest: "6".repeat(64),
    controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
    expectedSha: EXPECTED,
    migrationHead: LEDGER[0].filename,
    token: TOKEN,
  });
  const result = await freezeAndPrepareStaging(
    record,
    "/opt/candidate",
    CANDIDATE,
    LEDGER[0].filename,
    LEDGER,
    [],
    undefined,
    {
      captureMigrationAuthority: async () => {
        events.push("capture-authority");
        return Object.freeze({ marker: "trusted" });
      },
      freezeDatabaseWrites: async () => {
        events.push("activate-write-gate");
        return Object.freeze({
          catalog: CATALOG,
          ledger: LEDGER,
          terminatedSessions: 0,
          verifiedAt: "2026-08-10T01:02:03.000Z",
        });
      },
      inspectWriteGate: async () => events.push("inspect-role"),
      persistTransition: async (next) =>
        events.push(`persist:${next.phase}:${next.write_gate_state}`),
      prepareStaging: async () => events.push("chown-install-build"),
      stopDesk: async () => events.push("stop-desk"),
    },
  );
  assert.deepEqual(events, [
    "stop-desk",
    "inspect-role",
    "persist:staged:intent",
    "activate-write-gate",
    "persist:write_frozen:active",
    "capture-authority",
    "chown-install-build",
  ]);
  assert.deepEqual(result.authority, { marker: "trusted" });
});

test("migration execution enters only through the digest-bound private controller", async () => {
  const record = createTransition({
    archiveDigest: "5".repeat(64),
    candidateSha: CANDIDATE,
    controllerDigest: "6".repeat(64),
    controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
    expectedSha: EXPECTED,
    migrationHead: LEDGER[0].filename,
    token: TOKEN,
  });
  const authority = Object.freeze({
    migrations: LEDGER,
    runner_sha256: "7".repeat(64),
    schema: "laundry.cloud-release.migration-authority",
    version: 1,
  });
  let invocation;
  await applyMigrations(record, authority, undefined, {
    runCloudCommand: async (file, arguments_, options) => {
      invocation = { arguments_, file, options };
    },
  });
  assert.equal(invocation.file, "/opt/nodejs/bin/node");
  assert.deepEqual(invocation.arguments_, [
    `${record.controller_path}/tools/cloud/hk-vps-release-migration-executor.mjs`,
  ]);
  assert.doesNotMatch(JSON.stringify(invocation.arguments_), /tools\/compose\/migrate-v2\.sh/u);
  assert.equal(JSON.parse(invocation.options.input).controller_sha256, record.controller_sha256);
});
