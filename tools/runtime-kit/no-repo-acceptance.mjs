import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLegacyCommissionAcceptance } from "./no-repo-commissioning.mjs";
import { registerKeyCleanup, setup, waitForFile } from "./no-repo-helpers.mjs";
const kitRoot = dirname(fileURLToPath(import.meta.url));
const builtApp = join(kitRoot, "dist/Laundry Desk Runtime Test.app");
const privateKeyPath = join(kitRoot, "dist/test-signing-private.pem");
registerKeyCleanup(process.argv.slice(2), privateKeyPath);
const temporary = await mkdtemp(join(tmpdir(), "laundry-runtime-native-"));
const emptyCwd = join(temporary, "empty-cwd");
const copiedApp = join(temporary, "Laundry Desk Runtime Test.app");
await mkdir(emptyCwd);
await cp(builtApp, copiedApp, { recursive: true });
const executable = join(copiedApp, "Contents/MacOS/Laundry Desk Runtime");
const compose = await readFile(join(copiedApp, "Contents/Resources/docker-compose.runtime.yml"));
const checksum = (value) => createHash("sha256").update(value).digest("hex");
const repeated = (value) => value.repeat(64);
const payload = Object.freeze({
  schema_version: 1,
  product: "laundry-desk-runtime",
  release: "0.1.0",
  contracts_major: 2,
  contracts_sha256: repeated("a"),
  server_version: "0.1.0",
  web_bundle_sha256: repeated("b"),
  minimum_app_version: "0.1.0",
  database_schema_sha256: repeated("c"),
  migrations_sha256: repeated("d"),
  migration_head: "0033_offline_grant_replay.sql",
  maximum_compatible_schema: "0033_offline_grant_replay.sql",
  rollback_target: null,
  compose_sha256: checksum(compose),
  server_image: Object.freeze({
    index: `registry.example/laundry/server@sha256:${repeated("e")}`,
    linux_arm64: `sha256:${repeated("f")}`,
    linux_amd64: `sha256:${repeated("1")}`,
  }),
  postgres_major: 16,
  postgres_image: `docker.io/library/postgres@sha256:${repeated("2")}`,
});
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
};
const key = createPrivateKey(await readFile(privateKeyPath));
const signPayload = (value) =>
  sign(null, Buffer.from(JSON.stringify(canonical(value))), key).toString("base64url");
const writeManifest = async (name, value, signature = signPayload(value)) => {
  const path = join(temporary, name);
  await writeFile(path, JSON.stringify({ payload: value, signature }), { mode: 0o600 });
  return path;
};
const signature = signPayload(payload);
const manifest = await writeManifest("runtime-manifest.json", payload, signature);
const testingCapacity = Object.freeze({
  LAUNDRY_RUNTIME_TEST_ROOT_CAPACITY_BYTES: "1073741824",
});
const execute = (configRoot, runnerLog, args, input = "", extraEnvironment = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      executable,
      ["--test-config-root", configRoot, "--test-runner-log", runnerLog, ...args],
      {
        cwd: emptyCwd,
        env: { PATH: "", ...testingCapacity, ...extraEnvironment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = [],
      errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      const stdout = Buffer.concat(output).toString("utf8");
      const stderr = Buffer.concat(errors).toString("utf8");
      if (stdout.length > 16_384 || stderr.length > 16_384) {
        rejectRun(new Error("acceptance output exceeded bound"));
      } else resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
const assertManifestRejected = async (name, candidate, expected) => {
  const configRoot = join(temporary, `config-manifest-${name}`);
  const runnerLog = join(temporary, `manifest-${name}-runner.jsonl`);
  const result = await execute(configRoot, runnerLog, ["install", "--manifest", candidate], setup);
  assert.equal(result.code, 1);
  assert.match(result.stderr, expected);
  await assert.rejects(() => stat(configRoot), { code: "ENOENT" });
  await assert.rejects(() => stat(runnerLog), { code: "ENOENT" });
};
const tamperPhotoVolume = async (runnerLog) => {
  const path = `${runnerLog}.volumes.json`;
  const original = await readFile(path);
  const volumes = JSON.parse(original.toString("utf8"));
  assert.deepEqual(Object.keys(volumes).sort(), [
    "laundry-desk-runtime_pgdata-v2",
    "laundry-desk-runtime_photos",
  ]);
  volumes["laundry-desk-runtime_photos"] = {
    ...volumes["laundry-desk-runtime_photos"],
    "com.laundry-desk.instance": "foreign-instance",
  };
  await writeFile(path, JSON.stringify(volumes), { mode: 0o600 });
  return async () => writeFile(path, original, { mode: 0o600 });
};
const tamperedManifest = await writeManifest(
  "runtime-manifest-tampered.json",
  { ...payload, web_bundle_sha256: repeated("9") },
  signature,
);
const newerAppManifest = await writeManifest("runtime-manifest-newer-app.json", {
  ...payload,
  minimum_app_version: "0.2.0",
});
const contractsMismatchManifest = await writeManifest("runtime-manifest-contracts-mismatch.json", {
  ...payload,
  contracts_major: 3,
});
const invalidRollbackManifest = await writeManifest("runtime-manifest-invalid-rollback.json", {
  ...payload,
  rollback_target: {
    release: payload.release,
    server_image_index: payload.server_image.index,
    maximum_compatible_schema: payload.migration_head,
  },
});
const unpinnedPostgresManifest = await writeManifest("runtime-manifest-unpinned-postgres.json", {
  ...payload,
  postgres_image: "postgres:16",
});
const upgradePayload = Object.freeze({
  ...payload,
  release: "0.2.0",
  server_version: "0.2.0",
  web_bundle_sha256: repeated("3"),
  database_schema_sha256: repeated("4"),
  migrations_sha256: repeated("5"),
  maximum_compatible_schema: "0034_release_transition.sql",
  rollback_target: Object.freeze({
    release: payload.release,
    server_image_index: payload.server_image.index,
    maximum_compatible_schema: payload.maximum_compatible_schema,
  }),
  server_image: Object.freeze({
    index: `registry.example/laundry/server@sha256:${repeated("6")}`,
    linux_arm64: `sha256:${repeated("7")}`,
    linux_amd64: `sha256:${repeated("8")}`,
  }),
});
const upgradeManifest = await writeManifest("runtime-manifest-0.2.0.json", upgradePayload);
const upgradeWithoutRollbackManifest = await writeManifest(
  "runtime-manifest-upgrade-without-rollback.json",
  { ...upgradePayload, rollback_target: null },
);
const upgradeWrongTargetManifest = await writeManifest(
  "runtime-manifest-upgrade-wrong-target.json",
  {
    ...upgradePayload,
    rollback_target: {
      ...upgradePayload.rollback_target,
      server_image_index: upgradePayload.server_image.index,
    },
  },
);
const upgradeIncompatibleSchemaManifest = await writeManifest(
  "runtime-manifest-upgrade-incompatible-schema.json",
  {
    ...upgradePayload,
    migration_head: "0034_release_transition.sql",
  },
);
const belowAcceptedFloorManifest = await writeManifest("runtime-manifest-0.1.5.json", {
  ...upgradePayload,
  release: "0.1.5",
  server_version: "0.1.5",
});
for (const [name, candidate, expected] of [
  ["tampered", tamperedManifest, /RUNTIME_MANIFEST_SIGNATURE_INVALID/u],
  ["newer-app", newerAppManifest, /RUNTIME_MANIFEST_INCOMPATIBLE/u],
  ["contracts-mismatch", contractsMismatchManifest, /RUNTIME_MANIFEST_INCOMPATIBLE/u],
  ["invalid-rollback", invalidRollbackManifest, /RUNTIME_MANIFEST_INVALID/u],
  ["unpinned-postgres", unpinnedPostgresManifest, /RUNTIME_MANIFEST_INVALID/u],
]) {
  await assertManifestRejected(name, candidate, expected);
}
const preexistingRoot = join(temporary, "config-preexisting-photo");
const preexistingLog = join(temporary, "preexisting-runner.jsonl");
await writeFile(
  `${preexistingLog}.volumes.json`,
  JSON.stringify({
    "laundry-desk-runtime_photos": {
      "com.laundry-desk.managed": "true",
      "com.laundry-desk.project": "laundry-desk-runtime",
      "com.laundry-desk.instance": "foreign-instance",
    },
  }),
  { mode: 0o600 },
);
let result = await execute(
  preexistingRoot,
  preexistingLog,
  ["install", "--manifest", manifest],
  setup,
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RECOVERY_REQUIRED/u);
await assert.rejects(() => stat(join(preexistingRoot, "state.json")), { code: "ENOENT" });
const wrongDigestRoot = join(temporary, "config-wrong-index");
const wrongDigestLog = join(temporary, "wrong-index-runner.jsonl");
await writeFile(
  `${wrongDigestLog}.repo-digests.json`,
  JSON.stringify([`registry.example/laundry/server@${payload.server_image.linux_arm64}`]),
  { mode: 0o600 },
);
result = await execute(wrongDigestRoot, wrongDigestLog, ["install", "--manifest", manifest], setup);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_IMAGE_METADATA_INVALID/u);
const primaryRoot = join(temporary, "config-primary");
const primaryLog = join(temporary, "primary-runner.jsonl");
result = await execute(primaryRoot, primaryLog, ["install", "--manifest", manifest], setup);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).status, "ready");
result = await execute(primaryRoot, primaryLog, ["restart"]);
assert.equal(result.code, 0, result.stderr);
result = await execute(primaryRoot, primaryLog, ["status"]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).ok, true);
assert.equal(JSON.parse(result.stdout).commission_required, false);
const restorePrimaryVolumes = await tamperPhotoVolume(primaryLog);
result = await execute(primaryRoot, primaryLog, ["start"]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RECOVERY_REQUIRED/u);
result = await execute(primaryRoot, primaryLog, ["stop"]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RECOVERY_REQUIRED/u);
result = await execute(primaryRoot, primaryLog, ["diagnose"]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).fault_code, "RUNTIME_RECOVERY_REQUIRED");
await restorePrimaryVolumes();
result = await execute(primaryRoot, primaryLog, ["status"]);
assert.equal(JSON.parse(result.stdout).ok, true);
assert.deepEqual((await readdir(join(primaryRoot, "secrets"))).sort(), [
  "access-token-secret",
  "app-password",
  "csrf-proof-secret",
  "database-admin-url",
  "database-url",
  "postgres-password",
]);
await runLegacyCommissionAcceptance({
  execute,
  manifest,
  temporary,
  upgradeManifest,
  upgradeRelease: upgradePayload.release,
});
result = await execute(primaryRoot, primaryLog, ["backup", "list"]);
assert.equal(result.code, 0, result.stderr);
assert.deepEqual(JSON.parse(result.stdout).backups, []);
result = await execute(primaryRoot, primaryLog, ["backup", "create"]);
assert.equal(result.code, 0, result.stderr);
const manualBackup = JSON.parse(result.stdout);
assert.equal(manualBackup.kind, "manual");
assert.equal(manualBackup.verified, true);
assert.match(manualBackup.backup_id, /^manual-\d{8}T\d{6}Z-[A-Za-z0-9_-]{22}$/u);
assert.match(manualBackup.confirmation, /^RESTORE-[0-9A-F]{12}$/u);
const backupRoot = join(primaryRoot, "backups");
const manualRoot = join(backupRoot, manualBackup.backup_id);
const databaseBackup = join(manualRoot, "database.dump");
const photoBackup = join(manualRoot, "photos.tar");
const backupManifest = join(manualRoot, "manifest.json");
for (const path of [primaryRoot, backupRoot, manualRoot]) {
  assert.equal((await stat(path)).mode & 0o777, 0o700);
}
for (const path of [databaseBackup, photoBackup, backupManifest]) {
  assert.equal((await stat(path)).mode & 0o777, 0o600);
}
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "verify"],
  JSON.stringify({ backup_id: manualBackup.backup_id }),
);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).manifest_sha256, manualBackup.manifest_sha256);
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "verify"],
  JSON.stringify({ backup_id: "../../outside" }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_BACKUP_STDIN_INVALID/u);
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "verify"],
  JSON.stringify({ backup_id: manualBackup.backup_id, path: databaseBackup }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_BACKUP_STDIN_INVALID/u);
const originalDatabaseBackup = await readFile(databaseBackup);
await writeFile(databaseBackup, "corrupt", { mode: 0o600 });
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "verify"],
  JSON.stringify({ backup_id: manualBackup.backup_id }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_BACKUP_INVALID/u);
await writeFile(databaseBackup, originalDatabaseBackup, { mode: 0o600 });
const outsideHardlink = join(temporary, "database-hardlink");
await link(databaseBackup, outsideHardlink);
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "verify"],
  JSON.stringify({ backup_id: manualBackup.backup_id }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_BACKUP_INVALID/u);
await unlink(outsideHardlink);
await chmod(photoBackup, 0o644);
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "verify"],
  JSON.stringify({ backup_id: manualBackup.backup_id }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_BACKUP_INVALID/u);
await chmod(photoBackup, 0o600);

const originalBackupManifest = await readFile(backupManifest);
const manifestWithUnknownField = {
  ...JSON.parse(originalBackupManifest.toString("utf8")),
  external_path: "/tmp/forbidden",
};
await writeFile(backupManifest, JSON.stringify(manifestWithUnknownField), { mode: 0o600 });
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "verify"],
  JSON.stringify({ backup_id: manualBackup.backup_id }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_BACKUP_INVALID/u);
await writeFile(backupManifest, originalBackupManifest, { mode: 0o600 });

result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "restore"],
  JSON.stringify({ backup_id: manualBackup.backup_id, confirmation: "RESTORE-000000000000" }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RESTORE_CONFIRMATION_INVALID/u);
assert.deepEqual((await readdir(backupRoot)).sort(), [manualBackup.backup_id]);

await writeFile(`${primaryLog}.fake-database`, "database-mutated-before-restore", {
  mode: 0o600,
});
await writeFile(`${primaryLog}.fake-photos`, "fake-photo-tar-v2", { mode: 0o600 });
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "restore"],
  JSON.stringify({
    backup_id: manualBackup.backup_id,
    confirmation: manualBackup.confirmation,
  }),
);
assert.equal(result.code, 0, result.stderr);
const successfulRestore = JSON.parse(result.stdout);
assert.equal(successfulRestore.backup_id, manualBackup.backup_id);
assert.match(successfulRestore.safety_backup_id, /^safety-/u);
assert.equal(await readFile(`${primaryLog}.restored-database`, "utf8"), "BEGIN;\nCOMMIT;\n");
assert.equal(await readFile(`${primaryLog}.restored-photos`, "utf8"), "fake-photo-tar-v1");
result = await execute(primaryRoot, primaryLog, ["backup", "list"]);
assert.equal(result.code, 0, result.stderr);
let listedBackups = JSON.parse(result.stdout).backups;
assert.equal(listedBackups.length, 2);
assert.equal(
  listedBackups.find((entry) => entry.backup_id === successfulRestore.safety_backup_id).kind,
  "pre_restore",
);

await writeFile(`${primaryLog}.fake-database`, "database-before-failed-restore", { mode: 0o600 });
await writeFile(`${primaryLog}.fake-photos`, "fake-photo-tar-v2", { mode: 0o600 });
const logCountBeforeFailure = (await readFile(primaryLog, "utf8")).trim().split("\n").length;
await writeFile(`${primaryLog}.fail-once`, "--username=laundry_restore", { mode: 0o600 });
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "restore"],
  JSON.stringify({
    backup_id: manualBackup.backup_id,
    confirmation: manualBackup.confirmation,
  }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
const failureCommands = (await readFile(primaryLog, "utf8"))
  .trim()
  .split("\n")
  .slice(logCountBeforeFailure)
  .map((line) => JSON.parse(line));
assert.ok(failureCommands.some((entry) => entry.arguments.includes("--username=laundry_restore")));
const restoreFailureIndex = failureCommands.findIndex((entry) =>
  entry.arguments.includes("--username=laundry_restore"),
);
const postRestoreFailure = failureCommands.slice(restoreFailureIndex + 1);
const serverStopIndex = postRestoreFailure.findLastIndex(
  (entry) =>
    entry.arguments.slice(-2).join(" ") === "stop server" &&
    entry.arguments.filter((argument) => argument === "--file").length === 1,
);
assert.ok(
  serverStopIndex >= 0 &&
    !postRestoreFailure
      .slice(serverStopIndex + 1)
      .some((entry) => entry.arguments.includes("up") && entry.arguments.includes("server")),
);
result = await execute(primaryRoot, primaryLog, ["backup", "list"]);
assert.equal(result.code, 0, result.stderr);
listedBackups = JSON.parse(result.stdout).backups;
assert.equal(listedBackups.length, 3);
assert.equal(listedBackups.filter((entry) => entry.kind === "pre_restore").length, 2);
const failedRestoreSafety = listedBackups.find(
  (entry) => entry.kind === "pre_restore" && entry.backup_id !== successfulRestore.safety_backup_id,
);
assert.ok(failedRestoreSafety);
result = await execute(
  primaryRoot,
  primaryLog,
  ["backup", "restore"],
  JSON.stringify({
    backup_id: failedRestoreSafety.backup_id,
    confirmation: failedRestoreSafety.confirmation,
  }),
);
assert.equal(result.code, 0, result.stderr);
await assert.rejects(() => stat(join(primaryRoot, "transfer-state.json")), { code: "ENOENT" });

await writeFile(`${primaryLog}.pause-once`, "pg_dump", { mode: 0o600 });
const concurrentBackup = execute(primaryRoot, primaryLog, ["backup", "create"]);
await waitForFile(`${primaryLog}.paused`);
result = await execute(primaryRoot, primaryLog, ["backup", "list"]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_MAINTENANCE_BUSY/u);
result = await execute(primaryRoot, primaryLog, ["start"]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_MAINTENANCE_BUSY/u);
await writeFile(`${primaryLog}.continue`, "continue\n", { mode: 0o600 });
result = await concurrentBackup;
assert.equal(result.code, 0, result.stderr);
assert.equal((await stat(join(primaryRoot, ".maintenance.lock"))).mode & 0o777, 0o600);

result = await execute(primaryRoot, primaryLog, ["backup", "restore"], "x".repeat(513));
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_BACKUP_STDIN_INVALID/u);

for (const [candidate, expected] of [
  [upgradeWithoutRollbackManifest, /RUNTIME_UPGRADE_INCOMPATIBLE/u],
  [upgradeWrongTargetManifest, /RUNTIME_UPGRADE_INCOMPATIBLE/u],
  [upgradeIncompatibleSchemaManifest, /RUNTIME_MANIFEST_INVALID/u],
]) {
  result = await execute(primaryRoot, primaryLog, ["upgrade", "--manifest", candidate]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, expected);
}

result = await execute(primaryRoot, primaryLog, ["upgrade", "--manifest", upgradeManifest]);
assert.equal(result.code, 0, result.stderr);
const upgraded = JSON.parse(result.stdout);
assert.equal(upgraded.status, "ready");
assert.equal(upgraded.release, "0.2.0");
assert.equal(upgraded.previous_release, "0.1.0");
assert.match(upgraded.safety_backup_id, /^safety-/u);
assert.equal(JSON.parse(await readFile(join(primaryRoot, "state.json"), "utf8")).release, "0.2.0");
assert.equal(
  JSON.parse(await readFile(join(primaryRoot, "release-history.json"), "utf8"))
    .highest_accepted_release,
  "0.2.0",
);
result = await execute(
  primaryRoot,
  primaryLog,
  ["rollback"],
  JSON.stringify({ confirmation: "ROLLBACK-0.0.1" }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_ROLLBACK_INCOMPATIBLE/u);
result = await execute(
  primaryRoot,
  primaryLog,
  ["rollback"],
  JSON.stringify({ confirmation: "ROLLBACK-0.1.0" }),
);
assert.equal(result.code, 0, result.stderr);
const rolledBack = JSON.parse(result.stdout);
assert.equal(rolledBack.status, "ready");
assert.equal(rolledBack.release, "0.1.0");
assert.equal(rolledBack.rolled_back_from, "0.2.0");
assert.match(rolledBack.recovery_backup_id, /^safety-/u);
const rolledBackHistory = JSON.parse(
  await readFile(join(primaryRoot, "release-history.json"), "utf8"),
);
assert.deepEqual(rolledBackHistory, {
  highest_accepted_release: "0.2.0",
  version: 1,
});
await assert.rejects(() => stat(join(primaryRoot, "previous-runtime-manifest.json")), {
  code: "ENOENT",
});
result = await execute(primaryRoot, primaryLog, [
  "upgrade",
  "--manifest",
  belowAcceptedFloorManifest,
]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_UPGRADE_INCOMPATIBLE/u);

const failedUpgradeRoot = join(temporary, "config-failed-upgrade");
const failedUpgradeLog = join(temporary, "failed-upgrade-runner.jsonl");
result = await execute(
  failedUpgradeRoot,
  failedUpgradeLog,
  ["install", "--manifest", manifest],
  setup,
);
assert.equal(result.code, 0, result.stderr);
await writeFile(`${failedUpgradeLog}.fail-once`, "migrate", { mode: 0o600 });
result = await execute(failedUpgradeRoot, failedUpgradeLog, [
  "upgrade",
  "--manifest",
  upgradeManifest,
]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_UPGRADE_ROLLED_BACK/u);
result = await execute(failedUpgradeRoot, failedUpgradeLog, ["status"]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).release, "0.1.0");
for (const name of ["pending-runtime-manifest.json", "release-transition.json"]) {
  await assert.rejects(() => stat(join(failedUpgradeRoot, name)), { code: "ENOENT" });
}

const atomicCrashEnvironment = (boundary) => ({
  LAUNDRY_RUNTIME_TEST_CRASH_AFTER_ATOMIC_WRITE: boundary,
});
const assertRecoveredPreState = async (root, log, expectedRelease, command, input = "") => {
  const recovered = await execute(root, log, command, input);
  assert.equal(recovered.code, 1);
  assert.match(recovered.stderr, /RUNTIME_RELEASE_TRANSITION_RECOVERED/u);
  const status = await execute(root, log, ["status"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).release, expectedRelease);
  await assert.rejects(() => stat(join(root, "release-transition.json")), { code: "ENOENT" });
};

for (const [index, boundary] of [
  "release-transition.json:1",
  "release-transition.json:2",
  "release-transition.json:3",
  "previous-runtime-manifest.json:1",
  "runtime-manifest.json:1",
  "state.json:1",
  "release-history.json:1",
].entries()) {
  const root = join(temporary, `config-upgrade-atomic-${index}`);
  const log = join(temporary, `upgrade-atomic-${index}.jsonl`);
  result = await execute(root, log, ["install", "--manifest", manifest], setup);
  assert.equal(result.code, 0, result.stderr);
  result = await execute(
    root,
    log,
    ["upgrade", "--manifest", upgradeManifest],
    "",
    atomicCrashEnvironment(boundary),
  );
  assert.equal(result.code, 86, `${boundary}: ${result.stderr}`);
  await assertRecoveredPreState(root, log, payload.release, [
    "upgrade",
    "--manifest",
    upgradeManifest,
  ]);
  assert.equal(
    JSON.parse(await readFile(join(root, "release-history.json"))).highest_accepted_release,
    payload.release,
  );
  await assert.rejects(() => stat(join(root, "previous-runtime-manifest.json")), {
    code: "ENOENT",
  });
}

for (const [index, boundary] of [
  "release-transition.json:1",
  "release-transition.json:2",
  "release-transition.json:3",
  "runtime-manifest.json:1",
  "state.json:1",
  "release-history.json:1",
].entries()) {
  const root = join(temporary, `config-rollback-atomic-${index}`);
  const log = join(temporary, `rollback-atomic-${index}.jsonl`);
  result = await execute(root, log, ["install", "--manifest", manifest], setup);
  assert.equal(result.code, 0, result.stderr);
  result = await execute(root, log, ["upgrade", "--manifest", upgradeManifest]);
  assert.equal(result.code, 0, result.stderr);
  const rollbackInput = JSON.stringify({ confirmation: "ROLLBACK-0.1.0" });
  result = await execute(root, log, ["rollback"], rollbackInput, atomicCrashEnvironment(boundary));
  assert.equal(result.code, 86, `${boundary}: ${result.stderr}`);
  await assertRecoveredPreState(root, log, upgradePayload.release, ["rollback"], rollbackInput);
  const history = JSON.parse(await readFile(join(root, "release-history.json")));
  assert.equal(history.highest_accepted_release, upgradePayload.release);
  assert.equal(history.previous_release, payload.release);
  assert.equal(
    JSON.parse(await readFile(join(root, "previous-runtime-manifest.json"))).payload.release,
    payload.release,
  );
}

const recoveryFaults = [
  {
    kind: "upgrade",
    boundaries: ["runtime-manifest.json:1", "state.json:1", "release-history.json:1"],
    command: ["upgrade", "--manifest", upgradeManifest],
    input: "",
    expected: payload.release,
  },
  {
    kind: "rollback",
    boundaries: [
      "runtime-manifest.json:1",
      "state.json:1",
      "release-history.json:1",
      "previous-runtime-manifest.json:1",
    ],
    command: ["rollback"],
    input: JSON.stringify({ confirmation: "ROLLBACK-0.1.0" }),
    expected: upgradePayload.release,
  },
];
for (const fault of recoveryFaults) {
  for (const [index, boundary] of fault.boundaries.entries()) {
    const root = join(temporary, `config-${fault.kind}-recovery-${index}`);
    const log = join(temporary, `${fault.kind}-recovery-${index}.jsonl`);
    result = await execute(root, log, ["install", "--manifest", manifest], setup);
    assert.equal(result.code, 0, result.stderr);
    if (fault.kind === "rollback") {
      result = await execute(root, log, ["upgrade", "--manifest", upgradeManifest]);
      assert.equal(result.code, 0, result.stderr);
    }
    result = await execute(
      root,
      log,
      fault.command,
      fault.input,
      atomicCrashEnvironment("runtime-manifest.json:1"),
    );
    assert.equal(result.code, 86, result.stderr);
    result = await execute(root, log, fault.command, fault.input, atomicCrashEnvironment(boundary));
    assert.equal(result.code, 86, `${boundary}: ${result.stderr}`);
    await assertRecoveredPreState(root, log, fault.expected, fault.command, fault.input);
  }
}
const removeCrashEnvironment = (boundary) => ({
  LAUNDRY_RUNTIME_TEST_CRASH_AFTER_PRIVATE_REMOVE: boundary,
});
for (const kind of ["upgrade", "rollback"]) {
  const root = join(temporary, `config-${kind}-commit-remove`);
  const log = join(temporary, `${kind}-commit-remove.jsonl`);
  result = await execute(root, log, ["install", "--manifest", manifest], setup);
  assert.equal(result.code, 0, result.stderr);
  if (kind === "rollback") {
    result = await execute(root, log, ["upgrade", "--manifest", upgradeManifest]);
    assert.equal(result.code, 0, result.stderr);
  }
  const command = kind === "upgrade" ? ["upgrade", "--manifest", upgradeManifest] : ["rollback"];
  const input = kind === "rollback" ? JSON.stringify({ confirmation: "ROLLBACK-0.1.0" }) : "";
  result = await execute(
    root,
    log,
    command,
    input,
    removeCrashEnvironment("release-transition.json:1"),
  );
  assert.equal(result.code, 86, result.stderr);
  const status = await execute(root, log, ["status"]);
  assert.equal(JSON.parse(status.stdout).release, kind === "upgrade" ? "0.2.0" : "0.1.0");
}
const rollbackRemoveRoot = join(temporary, "config-rollback-previous-remove");
const rollbackRemoveLog = join(temporary, "rollback-previous-remove.jsonl");
result = await execute(
  rollbackRemoveRoot,
  rollbackRemoveLog,
  ["install", "--manifest", manifest],
  setup,
);
assert.equal(result.code, 0, result.stderr);
result = await execute(rollbackRemoveRoot, rollbackRemoveLog, [
  "upgrade",
  "--manifest",
  upgradeManifest,
]);
assert.equal(result.code, 0, result.stderr);
const rollbackInput = JSON.stringify({ confirmation: "ROLLBACK-0.1.0" });
result = await execute(
  rollbackRemoveRoot,
  rollbackRemoveLog,
  ["rollback"],
  rollbackInput,
  removeCrashEnvironment("previous-runtime-manifest.json:1"),
);
assert.equal(result.code, 86, result.stderr);
await assertRecoveredPreState(
  rollbackRemoveRoot,
  rollbackRemoveLog,
  upgradePayload.release,
  ["rollback"],
  rollbackInput,
);
const runnerText = await readFile(primaryLog, "utf8");
assert.doesNotMatch(
  runnerText,
  /native-acceptance-password|86420987|independent-approver-password|97531864|legacy-approver-password|753186|RESTORE-[0-9A-F]{12}|\.dump|\.tar|backup_id|pnpm/u,
);

const statePath = join(primaryRoot, "state.json");
const hardlinkPath = join(primaryRoot, "state-hardlink");
await link(statePath, hardlinkPath);
result = await execute(primaryRoot, primaryLog, ["diagnose"]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).fault_code, "RUNTIME_RECOVERY_REQUIRED");
await unlink(hardlinkPath);
result = await execute(primaryRoot, primaryLog, ["status"]);
assert.equal(JSON.parse(result.stdout).ok, true);

const faultRoot = join(temporary, "config-fault");
const faultLog = join(temporary, "fault-runner.jsonl");
await writeFile(`${faultLog}.fail-once`, "verify", { mode: 0o600 });
result = await execute(faultRoot, faultLog, ["install", "--manifest", manifest], setup);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
const restoreFaultVolumes = await tamperPhotoVolume(faultLog);
result = await execute(faultRoot, faultLog, ["recover", "--manifest", manifest]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RECOVERY_REQUIRED/u);
await restoreFaultVolumes();
result = await execute(faultRoot, faultLog, ["recover", "--manifest", manifest]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).status, "ready");

const invalidRoot = join(temporary, "config-invalid-pin");
result = await execute(
  invalidRoot,
  join(temporary, "invalid-runner.jsonl"),
  ["install", "--manifest", manifest],
  JSON.stringify({ ...JSON.parse(setup), adminPin: "123456789" }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_SETUP_INVALID/u);
await assert.rejects(() => stat(invalidRoot), { code: "ENOENT" });

const oversizedRoot = join(temporary, "config-oversized");
result = await execute(
  oversizedRoot,
  join(temporary, "oversized-runner.jsonl"),
  ["install", "--manifest", manifest],
  "x".repeat(4_097),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_SETUP_STDIN_INVALID/u);
await assert.rejects(() => stat(oversizedRoot), { code: "ENOENT" });

process.stdout.write("RUNTIME_NATIVE_NO_REPO_ACCEPTANCE_OK scenarios=73 manifest_negatives=8\n");
