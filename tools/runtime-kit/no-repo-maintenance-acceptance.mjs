import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDataFixture, signingKey } from "./no-repo-data-helpers.mjs";
import { registerKeyCleanup, setup, waitForFile } from "./no-repo-helpers.mjs";

registerKeyCleanup(process.argv.slice(2), signingKey);

const secretPattern = /native-acceptance-password|independent-approver-password|86420987|97531864/u;
const scheduledPattern = /^scheduled-\d{8}T\d{6}Z-[A-Za-z0-9_-]{22}$/u;
const exactMaintenanceKeys = Object.freeze([
  "backup_id",
  "corrupt_backups",
  "deleted_backups",
  "lan_status",
  "status",
]);
const exactStateKeys = Object.freeze([
  "corrupt_backups",
  "deleted_backups",
  "last_attempt_at",
  "last_backup_id",
  "last_success_at",
  "phase",
  "version",
]);
const token = () => randomBytes(16).toString("base64url");
const backupID = (prefix, timestamp = "20260101T000000Z") => `${prefix}-${timestamp}-${token()}`;
const listBackups = async (fixture, root, log) => {
  const result = await fixture.run(root, log, ["backup", "list"]);
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_LIST_FAILED");
  return JSON.parse(result.stdout).backups;
};
const cloneBackup = async ({ root, sourceID, targetID, kind, createdAt, parent = "backups" }) => {
  const target = join(root, parent, targetID);
  await mkdir(join(root, parent), { recursive: true, mode: 0o700 });
  await cp(join(root, "backups", sourceID), target, { recursive: true });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, backup_id: targetID, created_at: createdAt, kind }),
    { mode: 0o600 },
  );
  return target;
};
const assertMissing = (path) => assert.rejects(() => stat(path), { code: "ENOENT" });
const stableFailure = (result) =>
  /^RUNTIME_[A-Z0-9_]+\n$/u.test(result.stderr)
    ? result.stderr.trim()
    : "RUNTIME_NONCANONICAL_ERROR";

const fixture = await createDataFixture("laundry-runtime-maintenance");
try {
  const root = fixture.root("primary");
  const log = fixture.log("primary");
  let result = await fixture.run(root, log, ["install", "--manifest", fixture.manifest], setup);
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_INSTALL_FAILED");

  result = await fixture.run(root, log, ["maintenance"]);
  assert.equal(result.code, 0, `RUNTIME_MAINTENANCE_CLI_NOT_READY:${stableFailure(result)}`);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(summary).sort(), exactMaintenanceKeys);
  assert.equal(summary.status, "ready");
  assert.match(summary.backup_id, scheduledPattern);
  assert.equal(summary.corrupt_backups, 0);
  assert.equal(summary.deleted_backups, 0);
  assert.equal(typeof summary.lan_status, "string");

  const statePath = join(root, "maintenance-state.json");
  const stateMetadata = await stat(statePath);
  assert.equal(stateMetadata.mode & 0o777, 0o600);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(Object.keys(state).sort(), exactStateKeys);
  assert.equal(state.version, 1);
  assert.equal(state.phase, "idle");
  assert.equal(state.last_backup_id, summary.backup_id);
  assert.equal("last_failure_at" in state, false);
  assert.equal("last_failure_code" in state, false);
  assert.equal(state.corrupt_backups, 0);
  assert.equal(state.deleted_backups, 0);
  await writeFile(statePath, JSON.stringify({ ...state, phase: "in_progress" }), { mode: 0o600 });
  result = await fixture.run(root, log, ["status"]);
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_INTERRUPTED_DIAGNOSE_FAILED");
  const interrupted = JSON.parse(result.stdout);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.maintenance.ok, false);
  assert.equal(interrupted.maintenance.last_failure_code, "RUNTIME_MAINTENANCE_INTERRUPTED");
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });

  const scheduledRoot = join(root, "backups", summary.backup_id);
  assert.equal((await stat(scheduledRoot)).mode & 0o777, 0o700);
  for (const name of ["database.dump", "manifest.json", "photos.tar"]) {
    assert.equal((await stat(join(scheduledRoot, name))).mode & 0o777, 0o600);
  }

  result = await fixture.run(root, log, ["launchd", "install"]);
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_LAUNCHD_INSTALL_FAILED");
  const maintenancePlist = join(
    fixture.home,
    "Library/LaunchAgents/com.laundry-desk.runtime.maintenance.plist",
  );
  assert.equal((await stat(maintenancePlist)).mode & 0o777, 0o600);
  const plist = await readFile(maintenancePlist, "utf8");
  for (const fragment of [
    "com.laundry-desk.runtime.maintenance",
    "<string>maintenance</string>",
    "<key>Hour</key><integer>3</integer>",
    "<key>Minute</key><integer>0</integer>",
  ]) {
    assert.ok(plist.includes(fragment), `maintenance plist missing ${fragment}`);
  }
  assert.equal(plist.match(/<string>\/dev\/null<\/string>/gu)?.length, 2);
  assert.doesNotMatch(plist, /EnvironmentVariables/u);
  result = await fixture.run(root, log, ["launchd", "uninstall"]);
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_LAUNCHD_UNINSTALL_FAILED");
  await assertMissing(maintenancePlist);

  result = await fixture.run(root, log, ["backup", "create"]);
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_MANUAL_BACKUP_FAILED");
  const manual = JSON.parse(result.stdout);
  const protectedIDs = [manual.backup_id];
  for (const kind of ["pre_restore", "pre_upgrade", "pre_rollback", "pre_transfer"]) {
    const id = backupID("safety");
    await cloneBackup({
      root,
      sourceID: summary.backup_id,
      targetID: id,
      kind,
      createdAt: "2026-01-01T00:00:00Z",
    });
    protectedIDs.push(id);
  }
  const corruptID = backupID("scheduled");
  const corruptRoot = await cloneBackup({
    root,
    sourceID: summary.backup_id,
    targetID: corruptID,
    kind: "scheduled",
    createdAt: "2026-01-01T00:00:00Z",
  });
  await writeFile(join(corruptRoot, "database.dump"), "corrupt", { mode: 0o600 });

  const expiredID = backupID("scheduled", "20200101T000000Z");
  await cloneBackup({
    root,
    sourceID: summary.backup_id,
    targetID: expiredID,
    kind: "scheduled",
    createdAt: "2020-01-01T00:00:00Z",
  });
  result = await fixture.run(root, log, ["maintenance"]);
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_EXPIRED_RETENTION_FAILED");
  assert.ok(JSON.parse(result.stdout).deleted_backups >= 1);
  await assertMissing(join(root, "backups", expiredID));

  const trashID = backupID("scheduled");
  const trashSource = await cloneBackup({
    root,
    sourceID: summary.backup_id,
    targetID: trashID,
    kind: "scheduled",
    createdAt: "2026-01-01T00:00:00Z",
  });
  await mkdir(join(root, "backup-trash"), { recursive: true, mode: 0o700 });
  const trashPath = join(root, "backup-trash", trashID);
  await rename(trashSource, trashPath);
  const stagingID = backupID("scheduled");
  const stagingPath = await cloneBackup({
    root,
    sourceID: summary.backup_id,
    targetID: stagingID,
    kind: "scheduled",
    createdAt: "2026-01-01T00:00:00Z",
    parent: "backup-staging",
  });
  result = await fixture.run(root, log, ["maintenance"]);
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_CRASH_RESUME_FAILED");
  await Promise.all([assertMissing(trashPath), assertMissing(stagingPath)]);

  let retainedAtCapacity = false;
  for (let index = 0; index < 31; index += 1) {
    result = await fixture.run(root, log, ["maintenance"]);
    assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_RETENTION_FAILED");
    retainedAtCapacity ||= JSON.parse(result.stdout).deleted_backups > 0;
  }
  assert.equal(retainedAtCapacity, true);
  const retained = await listBackups(fixture, root, log);
  assert.equal(retained.filter((entry) => entry.kind === "scheduled" && entry.verified).length, 30);
  assert.equal(retained.find((entry) => entry.backup_id === corruptID)?.verified, false);
  for (const id of protectedIDs) {
    assert.equal(retained.find((entry) => entry.backup_id === id)?.verified, true);
  }

  const scheduledBeforeFailure = retained
    .filter((entry) => entry.verified && entry.kind === "scheduled")
    .map((entry) => entry.backup_id)
    .sort();
  await writeFile(`${log}.fail-once`, "pg_dump\n", { mode: 0o600 });
  result = await fixture.run(root, log, ["maintenance"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "RUNTIME_COMMAND_FAILED\n");
  const scheduledAfterFailure = (await listBackups(fixture, root, log))
    .filter((entry) => entry.verified && entry.kind === "scheduled")
    .map((entry) => entry.backup_id)
    .sort();
  assert.deepEqual(scheduledAfterFailure, scheduledBeforeFailure);
  const failedState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(failedState.phase, "failed");
  assert.equal(failedState.last_failure_code, "RUNTIME_COMMAND_FAILED");

  await writeFile(`${log}.pause-once`, "pg_dump\n", { mode: 0o600 });
  const concurrent = fixture.run(root, log, ["maintenance"]);
  await waitForFile(`${log}.paused`);
  result = await fixture.run(root, log, ["maintenance"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "RUNTIME_MAINTENANCE_BUSY\n");
  await writeFile(`${log}.continue`, "continue\n", { mode: 0o600 });
  result = await concurrent;
  assert.equal(result.code, 0, "RUNTIME_MAINTENANCE_LOCK_RELEASE_FAILED");

  result = await fixture.run(root, log, ["maintenance"], "{}");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "RUNTIME_ARGS_INVALID\n");

  const invalidStateOffset = (await readFile(log, "utf8")).trim().split("\n").length;
  await writeFile(join(root, "transfer-state.json"), "invalid\n", { mode: 0o600 });
  result = await fixture.run(root, log, ["maintenance"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "RUNTIME_TRANSFER_STATE_INVALID\n");
  const invalidStateCommands = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .slice(invalidStateOffset)
    .map((line) => JSON.parse(line));
  assert.ok(
    invalidStateCommands.some((entry) =>
      entry.arguments.includes("label=com.docker.compose.service=lan-gateway"),
    ),
  );
  assert.ok(
    invalidStateCommands.some((entry) => entry.arguments.slice(-2).join(" ") === "stop server"),
  );

  const transcript = `${await readFile(log, "utf8")}\n${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(transcript, secretPattern);
  process.stdout.write(
    "RUNTIME_DATA_MAINTENANCE_ACCEPTANCE_OK scheduled=31 retention=bounded crash=clean\n",
  );
} finally {
  await fixture.cleanup();
}
