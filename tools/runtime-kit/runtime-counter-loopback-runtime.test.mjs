import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcceptanceIdentity } from "./runtime-counter-loopback-core.mjs";
import {
  acquireRuntimeCounterLease,
  assertExactRuntimeResult,
  generateRuntimeSetup,
  loadRuntimeInstanceId,
  optionalRuntimeInstanceId,
} from "./runtime-counter-loopback-runtime.mjs";

const identity = createAcceptanceIdentity("abc12345def0");
const release = "0.1.0-counter.abc12345def0";
const instanceId = "runtime_instance_owned_123456";

async function withState(status, operation) {
  const root = await mkdtemp(join(tmpdir(), "runtime-counter-state-test-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const statePath = join(root, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      status,
      release,
      instance_id: instanceId,
      volumes: identity.volumes,
    }),
    { mode: 0o600 },
  );
  try {
    await operation({ root, statePath });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function readQuarantinedLease(root) {
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("acceptance.lock.release-"),
  );
  assert.equal(entries.length, 1);
  return await readFile(join(root, entries[0].name, "owner.lock"), "utf8");
}

test("generates the exact eight setup fields with distinct stdin secrets", () => {
  const setup = generateRuntimeSetup(identity.runtimeId);
  assert.deepEqual(Object.keys(setup).sort(), [
    "adminDisplayName",
    "adminPassword",
    "adminPin",
    "adminUsername",
    "approverDisplayName",
    "approverPassword",
    "approverPin",
    "approverUsername",
  ]);
  assert.match(setup.adminUsername, /^owner-[a-z0-9]{8,20}$/u);
  assert.match(setup.approverUsername, /^approver-[a-z0-9]{8,20}$/u);
  assert.match(setup.adminPin, /^\d{6}$/u);
  assert.match(setup.approverPin, /^\d{6}$/u);
  assert.notEqual(setup.adminPin, setup.approverPin);
  assert.notEqual(setup.adminPassword, setup.approverPassword);
  assert.ok(setup.adminPassword.length >= 12);
  assert.ok(setup.approverPassword.length >= 12);
});

test("accepts only the exact Runtime lifecycle result", () => {
  assert.doesNotThrow(() =>
    assertExactRuntimeResult(
      { code: 0, stdout: `{"release":"${release}","status":"ready"}\n`, stderr: "" },
      "ready",
      release,
    ),
  );
  for (const result of [
    { code: 1, stdout: "", stderr: "RUNTIME_FAILED\n" },
    { code: 0, stdout: `{"release":"${release}","status":"ready","extra":1}`, stderr: "" },
    { code: 0, stdout: `{"release":"${release}","status":"stopped"}`, stderr: "" },
    { code: 0, stdout: `{"release":"${release}","status":"ready"}`, stderr: "warning" },
  ]) {
    assert.throws(
      () => assertExactRuntimeResult(result, "ready", release),
      /RUNTIME_COUNTER_RUNTIME_OUTPUT_INVALID/u,
    );
  }
});

test("loads only an installed private state during the positive path", async () => {
  await withState("installed", async ({ root, statePath }) => {
    assert.equal(await loadRuntimeInstanceId(root, identity, release), instanceId);
    await chmod(statePath, 0o644);
    await assert.rejects(
      () => loadRuntimeInstanceId(root, identity, release),
      /RUNTIME_COUNTER_STATE_INVALID/u,
    );
  });
  await withState("prepared", async ({ root }) => {
    await assert.rejects(
      () => loadRuntimeInstanceId(root, identity, release),
      /RUNTIME_COUNTER_STATE_INVALID/u,
    );
  });
});

test("cleanup recovers owned instance ids from incomplete install states", async () => {
  for (const status of ["prepared", "finalizing", "installed"]) {
    await withState(status, async ({ root }) => {
      assert.equal(await optionalRuntimeInstanceId(root, identity, release), instanceId);
    });
  }
  assert.equal(
    await optionalRuntimeInstanceId(join(tmpdir(), "runtime-counter-missing"), identity, release),
    null,
  );
  await withState("foreign", async ({ root }) => {
    await assert.rejects(
      () => optionalRuntimeInstanceId(root, identity, release),
      /RUNTIME_COUNTER_STATE_INVALID/u,
    );
  });
});

test("full-flow lease is atomic and rejects a second instance before its build", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-counter-lease-test-"));
  const lockPath = join(root, "acceptance.lock");
  let buildStarted = false;
  try {
    const outcomes = await Promise.allSettled([
      acquireRuntimeCounterLease(lockPath),
      acquireRuntimeCounterLease(lockPath),
    ]);
    const acquired = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(acquired.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /RUNTIME_COUNTER_ACCEPTANCE_BUSY/u);

    await assert.rejects(async () => {
      const lease = await acquireRuntimeCounterLease(lockPath);
      buildStarted = true;
      await lease.release();
    }, /RUNTIME_COUNTER_ACCEPTANCE_BUSY/u);
    assert.equal(buildStarted, false);

    await acquired[0].value.release();
    await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("full-flow lease release refuses a same-token replacement inode", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-counter-lease-owner-test-"));
  const lockPath = join(root, "acceptance.lock");
  try {
    const lease = await acquireRuntimeCounterLease(lockPath);
    const ownerRecord = await readFile(lockPath, "utf8");
    await rm(lockPath);
    await writeFile(lockPath, ownerRecord, { flag: "wx", mode: 0o600 });

    await assert.rejects(() => lease.release(), /RUNTIME_COUNTER_LEASE_OWNERSHIP_LOST/u);
    assert.equal(await readFile(lockPath, "utf8"), ownerRecord);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("full-flow lease release refuses a foreign owner token on its original inode", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-counter-lease-token-test-"));
  const lockPath = join(root, "acceptance.lock");
  const foreignRecord = `${JSON.stringify({ pid: process.pid, token: "foreign", version: 1 })}\n`;
  try {
    const lease = await acquireRuntimeCounterLease(lockPath);
    await writeFile(lockPath, foreignRecord, { mode: 0o600 });

    await assert.rejects(() => lease.release(), /RUNTIME_COUNTER_LEASE_OWNERSHIP_LOST/u);
    assert.equal(await readFile(lockPath, "utf8"), foreignRecord);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("full-flow lease quarantines but never deletes a path swapped after its final check", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-counter-lease-race-test-"));
  const lockPath = join(root, "acceptance.lock");
  let ownerRecord = null;
  try {
    const lease = await acquireRuntimeCounterLease(lockPath, {
      beforeReleaseQuarantine: async () => {
        ownerRecord = await readFile(lockPath, "utf8");
        await rm(lockPath);
        await writeFile(lockPath, ownerRecord, { flag: "wx", mode: 0o600 });
      },
    });

    await assert.rejects(() => lease.release(), /RUNTIME_COUNTER_LEASE_OWNERSHIP_LOST/u);
    await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
    assert.equal(await readQuarantinedLease(root), ownerRecord);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
