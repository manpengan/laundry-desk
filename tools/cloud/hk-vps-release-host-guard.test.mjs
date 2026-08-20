import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RETAINED_RELEASES,
  MINIMUM_RELEASE_FREE_BYTES,
  assertLoopbackBindings,
  assertReleasePreflight,
  assertSharedInfrastructure,
  parseAvailableBytes,
  readReleaseHostSnapshot,
  removeOrphanStaging,
} from "./hk-vps-release-host-guard.mjs";
import { restorePreviousCode } from "./hk-vps-release-remote-system.mjs";
import {
  BACKUP_ROOT,
  HISTORY_ROOT,
  LIVE_ROOT,
  releasePaths,
} from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const TOKEN = "c".repeat(32);

function missing(path) {
  return Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
}

function metadata(type, mode, size = 16, ownership = {}) {
  return {
    dev: 7,
    gid: ownership.gid ?? 0,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
    mode,
    size,
    uid: ownership.uid ?? 0,
  };
}

function preflightFixture({ artifacts = [], backups = [], capacity, history = [] } = {}) {
  const names = new Map([
    ["/opt", artifacts.map((entry) => entry.name)],
    [HISTORY_ROOT, history.map((entry) => entry.name)],
    [BACKUP_ROOT, backups.map((entry) => entry.name)],
  ]);
  const entries = new Map([
    ["/opt", metadata("directory", 0o755)],
    [HISTORY_ROOT, metadata("directory", 0o700)],
    [BACKUP_ROOT, metadata("directory", 0o710, 16, { gid: 123 })],
  ]);
  for (const [root, values] of [
    ["/opt", artifacts],
    [HISTORY_ROOT, history],
    [BACKUP_ROOT, backups],
  ]) {
    for (const entry of values) {
      entries.set(`${root}/${entry.name}`, metadata(entry.type, entry.mode, entry.size));
    }
  }
  const calls = [];
  return {
    calls,
    dependencies: {
      assertRetainedBackups: async ({ postgresGid }) => {
        calls.push({ file: "retained-backups", postgresGid });
      },
      assertRetainedControllers: async () => undefined,
      assertRetainedEvidence: async () => undefined,
      lstat: async (path) => {
        const value = entries.get(path);
        if (value === undefined) throw missing(path);
        return value;
      },
      readdir: async (path) => names.get(path) ?? [],
      realpath: async (path) => path,
      runCloudCommand: async (file, arguments_, options) => {
        calls.push({ arguments_, file, label: options.label });
        if (options.label === "CLOUD_RELEASE_POSTGRES_GID") {
          return { code: 0, stderr: "", stdout: "123\n" };
        }
        return {
          code: 0,
          stderr: "",
          stdout: `Avail\n${capacity ?? MINIMUM_RELEASE_FREE_BYTES}\n`,
        };
      },
    },
  };
}

function historyEntry(index) {
  const sha = index.toString(16).padStart(40, "0");
  return { mode: 0o600, name: `${sha}-${TOKEN}-committed.json`, size: 32, type: "file" };
}

function artifactEntry(index) {
  const sha = index.toString(16).padStart(40, "0");
  return { mode: 0o755, name: `laundry-desk.failed-${sha}`, type: "directory" };
}

function backupEntries(index) {
  const sha = index.toString(16).padStart(40, "0");
  const base = `pre-${sha}-${TOKEN}.dump`;
  return [
    { mode: 0o600, name: base, size: 1024, type: "file" },
    { mode: 0o600, name: `${base}.json`, size: 32, type: "file" },
  ];
}

function restoreFixture(liveSha) {
  const paths = releasePaths(CANDIDATE, EXPECTED);
  const events = [];
  return {
    dependencies: {
      assertDeskHealth: async (sha) => events.push(`health:${sha}`),
      assertOrdinaryDirectory: async (path) => events.push(`directory:${path}`),
      assertSharedInfrastructure: async () => events.push("shared"),
      command: async () => events.push("stop"),
      pathExists: async (path) => {
        events.push(`exists:${path}`);
        return path === LIVE_ROOT;
      },
      readReleaseMarker: async (path) => {
        events.push(`marker:${path}`);
        return { git_sha: liveSha };
      },
      rename: async (source, destination) => events.push(`rename:${source}:${destination}`),
      startDesk: async () => events.push("start"),
      syncDirectory: async (path) => events.push(`sync:${path}`),
    },
    events,
    record: Object.freeze({
      candidate_sha: CANDIDATE,
      expected_sha: EXPECTED,
      failed_path: paths.failed,
      rollback_path: paths.rollback,
    }),
  };
}

test("capacity parser accepts one exact byte result and rejects ambiguous output", () => {
  assert.equal(parseAvailableBytes("Avail\n8589934592\n"), MINIMUM_RELEASE_FREE_BYTES);
  for (const source of ["", "Avail\n8\n9\n", "Available\n8589934592\n", "Avail\n-1\n"]) {
    assert.throws(() => parseAvailableBytes(source), { code: "CLOUD_RELEASE_CAPACITY_INVALID" });
  }
});

test("release preflight checks both fixed filesystems and exact retained sets", async () => {
  const fixture = preflightFixture({
    artifacts: [
      { mode: 0o755, name: `laundry-desk.next-${CANDIDATE}`, type: "directory" },
      {
        mode: 0o755,
        name: "laundry-desk.rollback-pre-ae9808c-20260809T112330Z",
        type: "directory",
      },
      {
        mode: 0o600,
        name: `laundry-desk.incoming-${CANDIDATE}-${TOKEN}.tar`,
        size: 1024,
        type: "file",
      },
    ],
    backups: backupEntries(1),
    history: [historyEntry(1)],
  });
  await assertReleasePreflight(undefined, fixture.dependencies);
  assert.deepEqual(
    fixture.calls
      .filter(({ file }) => file === "/usr/bin/df")
      .map(({ arguments_ }) => arguments_.at(-1)),
    ["/opt", "/var/lib/postgresql"],
  );
  assert.ok(
    fixture.calls
      .filter(({ file }) => file === "/usr/bin/df")
      .every(
        ({ arguments_ }) =>
          arguments_.includes("--block-size=1") && arguments_.includes("--output=avail"),
      ),
  );
  assert.deepEqual(
    fixture.calls.find(({ file }) => file === "retained-backups"),
    { file: "retained-backups", postgresGid: 123 },
  );
});

test("release preflight reserves the eighth slot and never prunes retention", async () => {
  for (const [field, entries, code] of [
    [
      "artifacts",
      Array.from({ length: MAX_RETAINED_RELEASES }, (_, index) => artifactEntry(index)),
      "CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT",
    ],
    [
      "history",
      Array.from({ length: MAX_RETAINED_RELEASES }, (_, index) => historyEntry(index)),
      "CLOUD_RELEASE_HISTORY_RETENTION_LIMIT",
    ],
  ]) {
    const fixture = preflightFixture({ [field]: entries });
    await assert.rejects(() => assertReleasePreflight(undefined, fixture.dependencies), { code });
    assert.equal(
      fixture.calls.some(({ file }) => file === "/usr/bin/rm"),
      false,
    );
  }
});

test("read-only host snapshot reports full retention while prepare keeps its one-slot rule", async () => {
  const full = preflightFixture({
    artifacts: Array.from({ length: MAX_RETAINED_RELEASES }, (_, index) => artifactEntry(index)),
    history: Array.from({ length: MAX_RETAINED_RELEASES }, (_, index) => historyEntry(index)),
  });
  assert.deepEqual(await readReleaseHostSnapshot(undefined, full.dependencies), {
    historyActive: MAX_RETAINED_RELEASES,
    optAvailableBytes: MINIMUM_RELEASE_FREE_BYTES,
    optResident: MAX_RETAINED_RELEASES,
    postgresqlAvailableBytes: MINIMUM_RELEASE_FREE_BYTES,
  });

  for (const field of ["artifacts", "history"]) {
    const entries = Array.from({ length: MAX_RETAINED_RELEASES - 1 }, (_, index) =>
      field === "artifacts" ? artifactEntry(index) : historyEntry(index),
    );
    const prepare = preflightFixture({ [field]: entries });
    await assert.doesNotReject(() => assertReleasePreflight(undefined, prepare.dependencies));
  }
});

test("release preflight fails closed for low space and malformed history names", async () => {
  const low = preflightFixture({ capacity: MINIMUM_RELEASE_FREE_BYTES - 1 });
  await assert.rejects(() => assertReleasePreflight(undefined, low.dependencies), {
    code: "CLOUD_RELEASE_CAPACITY_LOW",
  });

  const malformed = preflightFixture({
    history: [{ mode: 0o600, name: "latest.json", size: 32, type: "file" }],
  });
  await assert.rejects(() => assertReleasePreflight(undefined, malformed.dependencies), {
    code: "CLOUD_RELEASE_HISTORY_RETENTION_INVALID",
  });
});

function sharedInfrastructureCommand(overrides = {}) {
  const calls = [];
  return {
    calls,
    runCloudCommand: async (file, arguments_, options) => {
      calls.push({ arguments_, file, label: options.label });
      const defaults = {
        CLOUD_RELEASE_FAILED_UNITS: "",
        CLOUD_RELEASE_KB_BINDING: "LISTEN 0 4096 127.0.0.1:8700 0.0.0.0:*\n",
        CLOUD_RELEASE_KB_LOOPBACK_HEALTH: "ok\n",
        CLOUD_RELEASE_KB_PUBLIC_HEALTH: "ok\n",
        CLOUD_RELEASE_POSTGRES_BINDING:
          "LISTEN 0 244 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 244 [::1]:5432 [::]:*\n",
      };
      return {
        code: 0,
        stderr: "",
        stdout: overrides[options.label] ?? defaults[options.label] ?? "",
      };
    },
  };
}

test("shared infrastructure requires services, zero failed units, exact KB health, and loopback listeners", async () => {
  const dependencies = sharedInfrastructureCommand();
  await assertSharedInfrastructure(undefined, dependencies);
  const active = dependencies.calls
    .filter(({ label }) => label.endsWith("_ACTIVE"))
    .map(({ arguments_ }) => arguments_.at(-1));
  assert.deepEqual(active, ["kb-web.service", "caddy.service", "postgresql.service"]);
  assert.ok(
    dependencies.calls.some(
      ({ arguments_ }) => arguments_.at(-1) === "http://127.0.0.1:8700/healthz",
    ),
  );
});

test("shared infrastructure rejects failed units, non-exact health, and public listeners", async () => {
  for (const [label, value, code] of [
    [
      "CLOUD_RELEASE_FAILED_UNITS",
      "bad.service loaded failed failed\n",
      "CLOUD_RELEASE_FAILED_UNITS_PRESENT",
    ],
    [
      "CLOUD_RELEASE_KB_LOOPBACK_HEALTH",
      '{"ok":true}\n',
      "CLOUD_RELEASE_KB_LOOPBACK_HEALTH_INVALID",
    ],
    ["CLOUD_RELEASE_KB_PUBLIC_HEALTH", " ok\n", "CLOUD_RELEASE_KB_PUBLIC_HEALTH_INVALID"],
    [
      "CLOUD_RELEASE_KB_BINDING",
      "LISTEN 0 4096 0.0.0.0:8700 0.0.0.0:*\n",
      "CLOUD_RELEASE_KB_BINDING_INVALID",
    ],
  ]) {
    await assert.rejects(
      () => assertSharedInfrastructure(undefined, sharedInfrastructureCommand({ [label]: value })),
      { code },
    );
  }
});

test("loopback parser binds the local-address column rather than matching arbitrary text", () => {
  assert.doesNotThrow(() =>
    assertLoopbackBindings("LISTEN 0 64 [::1]:5432 [::]:*\n", 5432, "INVALID"),
  );
  assert.throws(
    () => assertLoopbackBindings("LISTEN 0 64 0.0.0.0:5432 127.0.0.1:5432\n", 5432, "INVALID"),
    { code: "INVALID" },
  );
});

test("orphan staging cleanup derives one canonical same-filesystem directory and verifies removal", async () => {
  const paths = releasePaths(CANDIDATE, EXPECTED);
  let removed = false;
  const calls = [];
  const dependencies = {
    lstat: async (path) => {
      if (path === "/opt") return metadata("directory", 0o755);
      if (path === paths.staging && !removed) {
        return metadata("directory", 0o755, 16, { gid: 1001, uid: 1001 });
      }
      throw missing(path);
    },
    realpath: async (path) => path,
    runCloudCommand: async (file, arguments_, options) => {
      calls.push({ arguments_, file, label: options.label });
      if (file === "/usr/bin/id") return { code: 0, stderr: "", stdout: "1001\n" };
      removed = true;
      return { code: 0, stderr: "", stdout: "" };
    },
  };
  assert.equal(
    await removeOrphanStaging(
      { candidate_sha: CANDIDATE, expected_sha: EXPECTED, staging_path: paths.staging },
      undefined,
      dependencies,
    ),
    true,
  );
  assert.deepEqual(
    calls.filter(({ file }) => file === "/usr/bin/rm"),
    [
      {
        arguments_: ["-rf", "--one-file-system", "--", paths.staging],
        file: "/usr/bin/rm",
        label: "CLOUD_RELEASE_STAGING_CLEANUP",
      },
    ],
  );
});

test("orphan staging cleanup is idempotent but rejects a non-record path before rm", async () => {
  const paths = releasePaths(CANDIDATE, EXPECTED);
  const noCommands = async () => assert.fail("rm must not run");
  const missingDependencies = {
    lstat: async (path) => {
      throw missing(path);
    },
    runCloudCommand: noCommands,
  };
  assert.equal(
    await removeOrphanStaging(
      { candidate_sha: CANDIDATE, expected_sha: EXPECTED, staging_path: paths.staging },
      undefined,
      missingDependencies,
    ),
    false,
  );
  await assert.rejects(
    () =>
      removeOrphanStaging(
        { candidate_sha: CANDIDATE, expected_sha: EXPECTED, staging_path: "/opt/laundry-desk" },
        undefined,
        missingDependencies,
      ),
    { code: "CLOUD_RELEASE_STAGING_PATH_INVALID" },
  );
});

test("rollback restore checks shared infrastructure when the expected release is already live", async () => {
  const fixture = restoreFixture(EXPECTED);
  await restorePreviousCode(fixture.record, fixture.dependencies);
  assert.deepEqual(fixture.events, [
    "stop",
    `exists:${LIVE_ROOT}`,
    `marker:${LIVE_ROOT}`,
    "start",
    `health:${EXPECTED}`,
    "shared",
  ]);
});

test("rollback restore checks shared infrastructure after restoring the rollback directory", async () => {
  const fixture = restoreFixture(CANDIDATE);
  await restorePreviousCode(fixture.record, fixture.dependencies);
  assert.deepEqual(fixture.events, [
    "stop",
    `exists:${LIVE_ROOT}`,
    `marker:${LIVE_ROOT}`,
    `exists:${fixture.record.failed_path}`,
    `rename:${LIVE_ROOT}:${fixture.record.failed_path}`,
    "sync:/opt",
    `directory:${fixture.record.rollback_path}`,
    `rename:${fixture.record.rollback_path}:${LIVE_ROOT}`,
    "sync:/opt",
    "start",
    `health:${EXPECTED}`,
    "shared",
  ]);
});

test("rollback restore runs its write gate hook after code restore and before service start", async () => {
  const fixture = restoreFixture(CANDIDATE);
  await restorePreviousCode(fixture.record, {
    ...fixture.dependencies,
    beforeStart: async () => fixture.events.push("release-write-gate"),
  });
  assert.ok(
    fixture.events.indexOf(`rename:${fixture.record.rollback_path}:${LIVE_ROOT}`) <
      fixture.events.indexOf("release-write-gate"),
  );
  assert.ok(fixture.events.indexOf("release-write-gate") < fixture.events.indexOf("start"));
});
