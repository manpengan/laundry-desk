import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { createDataFixture, signingKey } from "./no-repo-data-helpers.mjs";
import { registerKeyCleanup, setup, waitForFile } from "./no-repo-helpers.mjs";

registerKeyCleanup(process.argv.slice(2), signingKey);

const transferPassword = "transfer-password-canary-2026";
const transferPattern = /^TRANSFER-[0-9A-F]{12}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const portableChunkBytes = 1_048_576;
const maximumPlaintextBytes = 137_438_953_472;
const maximumArchiveBytes =
  maximumPlaintextBytes + 56 + Math.ceil(maximumPlaintextBytes / portableChunkBytes) * (4 + 16);
const exportKeys = Object.freeze([
  "backup_id",
  "bytes",
  "confirmation",
  "export_id",
  "release",
  "sha256",
  "status",
]);
const inspectKeys = Object.freeze([
  "backup_id",
  "bytes",
  "compatible",
  "confirmation",
  "export_id",
  "migration_head",
  "release",
  "source_instance_id",
  "status",
]);
const importKeys = Object.freeze([
  "export_id",
  "lan_status",
  "release",
  "safety_backup_id",
  "source_instance_id",
  "status",
]);
const secretPattern = new RegExp(
  [
    transferPassword,
    "native-acceptance-password",
    "independent-approver-password",
    "86420987",
    "97531864",
  ].join("|"),
  "u",
);
const parse = (result) => JSON.parse(result.stdout);
const assertSuccess = (result, code) => {
  if (result.code !== 0) {
    const failure = /^RUNTIME_[A-Z0-9_]+\n$/u.test(result.stderr)
      ? result.stderr.trim()
      : "RUNTIME_NONCANONICAL_ERROR";
    assert.fail(`${code}:${failure}`);
  }
  assert.equal(result.stderr, "", code);
};
const assertRejected = (result, code) => {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${code}\n`);
};

const fixture = await createDataFixture("laundry-runtime-transfer");
try {
  const sourceRoot = fixture.root("source");
  const sourceLog = fixture.log("source");
  const destinationRoot = fixture.root("destination");
  const destinationLog = fixture.log("destination");
  const additionalLogs = [];
  for (const [root, log] of [
    [sourceRoot, sourceLog],
    [destinationRoot, destinationLog],
  ]) {
    const installed = await fixture.run(
      root,
      log,
      ["install", "--manifest", fixture.manifest],
      setup,
    );
    assertSuccess(installed, "RUNTIME_TRANSFER_INSTALL_FAILED");
  }

  const sourceState = JSON.parse(await readFile(`${sourceRoot}/state.json`, "utf8"));
  const destinationState = JSON.parse(await readFile(`${destinationRoot}/state.json`, "utf8"));
  assert.notEqual(sourceState.instance_id, destinationState.instance_id);

  let result = await fixture.run(sourceRoot, sourceLog, ["transfer", "self-test"]);
  assertSuccess(result, "RUNTIME_TRANSFER_SELF_TEST_NOT_READY");
  assert.equal(result.stderr, "");
  assert.deepEqual(parse(result), {
    calibration_in_range: true,
    chunk_count: 3,
    known_answer: true,
    negative_cases: 8,
    round_trip: true,
    status: "passed",
  });

  result = await fixture.run(sourceRoot, sourceLog, ["transfer", "payload-self-test"]);
  assertSuccess(result, "RUNTIME_TRANSFER_PAYLOAD_SELF_TEST_NOT_READY");
  assert.equal(result.stderr, "");
  assert.deepEqual(parse(result), {
    database_exact_set: true,
    database_sanitized: true,
    negative_cases: 16,
    photo_archive: true,
    status: "passed",
  });
  result = await fixture.run(sourceRoot, sourceLog, ["transfer", "photo-consistency-self-test"]);
  assertSuccess(result, "RUNTIME_PHOTO_CONSISTENCY_SELF_TEST_NOT_READY");
  assert.deepEqual(parse(result), { negative_cases: 3, status: "passed" });

  result = await fixture.run(sourceRoot, sourceLog, ["transfer", "gate-self-test"]);
  assertSuccess(result, "RUNTIME_TRANSFER_GATE_SELF_TEST_NOT_READY");
  assert.deepEqual(parse(result), {
    allowed_operations: [
      "stop",
      "lan_disable",
      "support_create",
      "backup_list",
      "backup_verify",
      "diagnose",
      "exact_pre_transfer_restore",
    ],
    blocked_operations: [
      "install",
      "recover",
      "commission",
      "backup_create",
      "maintenance",
      "upgrade",
      "rollback",
      "start",
      "restart",
      "lan_configure",
      "lan_enable",
      "launchd_install",
      "transfer_export",
      "transfer_inspect",
      "transfer_import",
    ],
    exact_restore_recovery: true,
    invalid_state_fail_closed: true,
    safe_recovery: true,
    starting_fail_closed: true,
    status: "passed",
  });

  result = await fixture.run(sourceRoot, sourceLog, ["backup", "create"]);
  assertSuccess(result, "RUNTIME_TRANSFER_BACKUP_FAILED");
  const backup = parse(result);
  const lowCapacityPath = fixture.path("low-capacity.laundry-transfer");
  result = await fixture.run(
    sourceRoot,
    sourceLog,
    ["transfer", "export"],
    JSON.stringify({
      backup_id: backup.backup_id,
      password: transferPassword,
      path: lowCapacityPath,
    }),
    { LAUNDRY_RUNTIME_TEST_EXTERNAL_CAPACITY_BYTES: "1" },
  );
  assertRejected(result, "RUNTIME_TRANSFER_CAPACITY_LOW");
  await assert.rejects(() => stat(lowCapacityPath), { code: "ENOENT" });

  const transferPath = fixture.path("store-move.laundry-transfer");
  const exportInput = JSON.stringify({
    backup_id: backup.backup_id,
    password: transferPassword,
    path: transferPath,
  });
  result = await fixture.run(sourceRoot, sourceLog, ["transfer", "export"], exportInput);
  assertSuccess(result, "RUNTIME_TRANSFER_CLI_NOT_READY");
  const exported = parse(result);
  assert.deepEqual(Object.keys(exported).sort(), exportKeys);
  assert.equal(exported.status, "exported");
  assert.equal(exported.backup_id, backup.backup_id);
  assert.equal(exported.release, sourceState.release);
  assert.match(exported.export_id, /^[A-Za-z0-9_-]{22}$/u);
  assert.match(exported.sha256, digestPattern);
  assert.match(exported.confirmation, transferPattern);
  const transferMetadata = await stat(transferPath);
  assert.equal(transferMetadata.mode & 0o777, 0o600);
  assert.equal(exported.bytes, transferMetadata.size);
  assert.equal(
    exported.sha256,
    createHash("sha256")
      .update(await readFile(transferPath))
      .digest("hex"),
  );

  result = await fixture.run(
    sourceRoot,
    sourceLog,
    ["transfer", "export"],
    JSON.stringify({
      backup_id: backup.backup_id,
      password: transferPassword,
      path: transferPath,
    }),
  );
  assertRejected(result, "RUNTIME_TRANSFER_PATH_INVALID");
  for (const input of [
    JSON.stringify({ backup_id: backup.backup_id, password: "short", path: transferPath }),
    JSON.stringify({ backup_id: backup.backup_id, password: transferPassword, path: "relative" }),
    JSON.stringify({
      backup_id: backup.backup_id,
      password: transferPassword,
      path: fixture.path("unknown.laundry-transfer"),
      unknown: true,
    }),
    "x".repeat(4_097),
  ]) {
    result = await fixture.run(sourceRoot, sourceLog, ["transfer", "export"], input);
    assertRejected(result, "RUNTIME_TRANSFER_STDIN_INVALID");
  }

  await writeFile(`${sourceLog}.pause-once`, "pg_dump\n", { mode: 0o600 });
  const concurrentBackup = fixture.run(sourceRoot, sourceLog, ["backup", "create"]);
  await waitForFile(`${sourceLog}.paused`);
  result = await fixture.run(
    sourceRoot,
    sourceLog,
    ["transfer", "export"],
    JSON.stringify({
      backup_id: backup.backup_id,
      password: transferPassword,
      path: fixture.path("busy.laundry-transfer"),
    }),
  );
  assertRejected(result, "RUNTIME_MAINTENANCE_BUSY");
  await writeFile(`${sourceLog}.continue`, "continue\n", { mode: 0o600 });
  assertSuccess(await concurrentBackup, "RUNTIME_TRANSFER_LOCK_RELEASE_FAILED");

  const inspect = (password = transferPassword, path = transferPath, environment = {}) =>
    fixture.run(
      destinationRoot,
      destinationLog,
      ["transfer", "inspect"],
      JSON.stringify({ password, path }),
      environment,
    );
  result = await inspect(transferPassword, transferPath, {
    LAUNDRY_RUNTIME_TEST_ROOT_CAPACITY_BYTES: "1",
  });
  assertRejected(result, "RUNTIME_TRANSFER_CAPACITY_LOW");
  result = await inspect("different-valid-password");
  assertRejected(result, "RUNTIME_TRANSFER_INVALID");
  const archive = await readFile(transferPath);
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 1] ^= 1;
  const tamperedPath = fixture.path("tampered.laundry-transfer");
  await writeFile(tamperedPath, tampered, { mode: 0o600 });
  result = await inspect(transferPassword, tamperedPath);
  assertRejected(result, "RUNTIME_TRANSFER_INVALID");
  const appendedPath = fixture.path("appended.laundry-transfer");
  await writeFile(appendedPath, Buffer.concat([archive, Buffer.from([0])]), { mode: 0o600 });
  result = await inspect(transferPassword, appendedPath);
  assertRejected(result, "RUNTIME_TRANSFER_INVALID");

  const symlinkPath = fixture.path("symlink.laundry-transfer");
  await symlink(transferPath, symlinkPath);
  result = await inspect(transferPassword, symlinkPath);
  assertRejected(result, "RUNTIME_TRANSFER_PATH_INVALID");
  await unlink(symlinkPath);
  const realParent = fixture.path("real-transfer-parent");
  const linkedParent = fixture.path("linked-transfer-parent");
  await mkdir(realParent, { mode: 0o700 });
  await writeFile(join(realParent, "nested.laundry-transfer"), archive, { mode: 0o600 });
  await symlink(realParent, linkedParent, "dir");
  result = await inspect(transferPassword, join(linkedParent, "nested.laundry-transfer"));
  assertRejected(result, "RUNTIME_TRANSFER_PATH_INVALID");
  await unlink(linkedParent);
  const hardlinkSource = fixture.path("hardlink-source.laundry-transfer");
  const hardlinkPath = fixture.path("hardlink.laundry-transfer");
  await writeFile(hardlinkSource, archive, { mode: 0o600 });
  await link(hardlinkSource, hardlinkPath);
  result = await inspect(transferPassword, hardlinkPath);
  assertRejected(result, "RUNTIME_TRANSFER_PATH_INVALID");
  await Promise.all([unlink(hardlinkPath), unlink(hardlinkSource)]);
  const directoryPath = fixture.path("directory.laundry-transfer");
  await mkdir(directoryPath, { mode: 0o700 });
  result = await inspect(transferPassword, directoryPath);
  assertRejected(result, "RUNTIME_TRANSFER_PATH_INVALID");
  const exactMaximumPath = fixture.path("exact-maximum.laundry-transfer");
  await writeFile(exactMaximumPath, Buffer.alloc(1), { mode: 0o600 });
  await truncate(exactMaximumPath, maximumArchiveBytes);
  result = await inspect(transferPassword, exactMaximumPath);
  assertRejected(result, "RUNTIME_TRANSFER_INVALID");
  const aboveMaximumPath = fixture.path("above-maximum.laundry-transfer");
  await writeFile(aboveMaximumPath, Buffer.alloc(1), { mode: 0o600 });
  await truncate(aboveMaximumPath, maximumArchiveBytes + 1);
  result = await inspect(transferPassword, aboveMaximumPath);
  assertRejected(result, "RUNTIME_TRANSFER_PATH_INVALID");

  const inspectInput = JSON.stringify({ password: transferPassword, path: transferPath });
  result = await fixture.run(
    destinationRoot,
    destinationLog,
    ["transfer", "inspect"],
    inspectInput,
  );
  assertSuccess(result, "RUNTIME_TRANSFER_INSPECT_FAILED");
  const inspected = parse(result);
  assert.deepEqual(Object.keys(inspected).sort(), inspectKeys);
  assert.equal(inspected.status, "valid");
  assert.equal(inspected.compatible, true);
  assert.equal(inspected.backup_id, backup.backup_id);
  assert.equal(inspected.export_id, exported.export_id);
  assert.equal(inspected.source_instance_id, sourceState.instance_id);
  assert.equal(inspected.bytes, transferMetadata.size);
  assert.equal(inspected.confirmation, exported.confirmation);
  assert.deepEqual(await readdir(join(destinationRoot, "transfer-staging")), []);

  result = await fixture.run(
    destinationRoot,
    destinationLog,
    ["transfer", "import"],
    JSON.stringify({
      confirmation: "TRANSFER-000000000000",
      password: transferPassword,
      path: transferPath,
    }),
  );
  assertRejected(result, "RUNTIME_TRANSFER_CONFIRMATION_INVALID");
  await assert.rejects(() => stat(join(destinationRoot, "transfer-state.json")), {
    code: "ENOENT",
  });

  const importInput = JSON.stringify({
    confirmation: inspected.confirmation,
    password: transferPassword,
    path: transferPath,
  });
  result = await fixture.run(destinationRoot, destinationLog, ["transfer", "import"], importInput, {
    LAUNDRY_RUNTIME_TEST_ROOT_CAPACITY_BYTES: "1",
  });
  assertRejected(result, "RUNTIME_TRANSFER_CAPACITY_LOW");
  await assert.rejects(() => stat(join(destinationRoot, "transfer-state.json")), {
    code: "ENOENT",
  });

  const databaseCapacityRoot = fixture.root("database-capacity");
  const databaseCapacityLog = fixture.log("database-capacity");
  additionalLogs.push(databaseCapacityLog);
  result = await fixture.run(
    databaseCapacityRoot,
    databaseCapacityLog,
    ["install", "--manifest", fixture.manifest],
    setup,
  );
  assertSuccess(result, "RUNTIME_TRANSFER_DATABASE_CAPACITY_FIXTURE_INSTALL_FAILED");
  result = await fixture.run(
    databaseCapacityRoot,
    databaseCapacityLog,
    ["transfer", "import"],
    importInput,
    { LAUNDRY_RUNTIME_TEST_DATABASE_CAPACITY_BYTES: "1" },
  );
  assertRejected(result, "RUNTIME_TRANSFER_CAPACITY_LOW");
  const databaseCapacityRecovery = JSON.parse(
    await readFile(join(databaseCapacityRoot, "transfer-state.json"), "utf8"),
  );
  assert.equal(databaseCapacityRecovery.phase, "failed");
  assert.equal(databaseCapacityRecovery.fault_code, "RUNTIME_TRANSFER_CAPACITY_LOW");
  const databaseCapacityCommands = (await readFile(databaseCapacityLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const databaseCapacityCheck = databaseCapacityCommands.findIndex((entry) =>
    entry.arguments.includes("/bin/df"),
  );
  assert.ok(databaseCapacityCheck >= 0);
  assert.equal(
    databaseCapacityCommands
      .slice(databaseCapacityCheck + 1)
      .some(
        (entry) =>
          entry.arguments.includes("--username=laundry_restore") ||
          entry.arguments.some(
            (argument) =>
              typeof argument === "string" && argument.includes("DROP SCHEMA IF EXISTS public"),
          ),
      ),
    false,
  );
  const databaseCapacityStop = databaseCapacityCommands.findLastIndex(
    (entry) => entry.arguments.slice(-2).join(" ") === "stop server",
  );
  assert.ok(databaseCapacityStop > databaseCapacityCheck);
  assert.equal(
    databaseCapacityCommands
      .slice(databaseCapacityStop + 1)
      .some((entry) => entry.arguments.includes("up") && entry.arguments.includes("server")),
    false,
  );

  result = await fixture.run(destinationRoot, destinationLog, ["transfer", "import"], importInput);
  assertSuccess(result, "RUNTIME_TRANSFER_IMPORT_FAILED");
  const imported = parse(result);
  assert.deepEqual(Object.keys(imported).sort(), importKeys);
  assert.equal(imported.status, "ready");
  assert.equal(imported.export_id, exported.export_id);
  assert.equal(imported.source_instance_id, sourceState.instance_id);
  assert.match(imported.safety_backup_id, /^safety-/u);
  result = await fixture.run(destinationRoot, destinationLog, ["backup", "list"]);
  assertSuccess(result, "RUNTIME_TRANSFER_SAFETY_LIST_FAILED");
  const safety = parse(result).backups.find(
    (entry) => entry.backup_id === imported.safety_backup_id,
  );
  assert.equal(safety.kind, "pre_transfer");
  assert.equal(safety.verified, true);

  const destinationStateAfter = JSON.parse(await readFile(`${destinationRoot}/state.json`, "utf8"));
  assert.equal(destinationStateAfter.instance_id, destinationState.instance_id);
  assert.notEqual(destinationStateAfter.instance_id, sourceState.instance_id);

  const failureRoot = fixture.root("failed-import");
  const failureLog = fixture.log("failed-import");
  result = await fixture.run(
    failureRoot,
    failureLog,
    ["install", "--manifest", fixture.manifest],
    setup,
  );
  assertSuccess(result, "RUNTIME_TRANSFER_FAILURE_FIXTURE_INSTALL_FAILED");
  const failureInstance = JSON.parse(
    await readFile(`${failureRoot}/state.json`, "utf8"),
  ).instance_id;
  result = await fixture.run(failureRoot, failureLog, ["maintenance"]);
  assertSuccess(result, "RUNTIME_TRANSFER_FAILURE_FIXTURE_MAINTENANCE_FAILED");
  await writeFile(`${failureLog}.fail-once`, "--username=laundry_restore\n", { mode: 0o600 });
  result = await fixture.run(failureRoot, failureLog, ["transfer", "import"], importInput);
  assertRejected(result, "RUNTIME_COMMAND_FAILED");
  const recovery = JSON.parse(await readFile(join(failureRoot, "transfer-state.json"), "utf8"));
  assert.equal(recovery.phase, "failed");
  assert.equal(recovery.fault_code, "RUNTIME_COMMAND_FAILED");
  assert.match(recovery.safety_backup_id, /^safety-/u);
  result = await fixture.run(failureRoot, failureLog, ["status"]);
  assertSuccess(result, "RUNTIME_TRANSFER_FAILURE_DIAGNOSE_FAILED");
  const diagnosis = parse(result);
  assert.equal(diagnosis.ok, false);
  assert.equal(diagnosis.transfer_phase, "failed");
  assert.equal(diagnosis.transfer_fault_code, "RUNTIME_COMMAND_FAILED");
  result = await fixture.run(failureRoot, failureLog, ["start"]);
  assertRejected(result, "RUNTIME_TRANSFER_RECOVERY_REQUIRED");
  result = await fixture.run(failureRoot, failureLog, ["backup", "list"]);
  assertSuccess(result, "RUNTIME_TRANSFER_FAILURE_SAFETY_LIST_FAILED");
  const failureSafety = parse(result).backups.find(
    (entry) => entry.backup_id === recovery.safety_backup_id,
  );
  assert.equal(failureSafety.kind, "pre_transfer");
  assert.equal(failureSafety.verified, true);
  assert.equal(
    JSON.parse(await readFile(`${failureRoot}/state.json`, "utf8")).instance_id,
    failureInstance,
  );
  assert.ok((await readdir(join(failureRoot, "transfer-staging"))).length > 0);
  const failureCommands = (await readFile(failureLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failedRestore = failureCommands.findIndex((entry) =>
    entry.arguments.includes("--username=laundry_restore"),
  );
  const finalServerStop = failureCommands.findLastIndex(
    (entry) => entry.arguments.slice(-2).join(" ") === "stop server",
  );
  assert.ok(failedRestore >= 0 && finalServerStop > failedRestore);
  assert.equal(
    failureCommands
      .slice(finalServerStop + 1)
      .some((entry) => entry.arguments.includes("up") && entry.arguments.includes("server")),
    false,
  );

  const recoveryPath = join(failureRoot, "transfer-state.json");
  const blockedCommands = [
    { arguments: ["backup", "create"], input: "" },
    { arguments: ["upgrade", "--manifest", fixture.manifest], input: "" },
    {
      arguments: ["rollback"],
      input: JSON.stringify({ confirmation: "ROLLBACK-0.1.0" }),
    },
  ];
  for (const phase of ["failed", "restoring_database"]) {
    await writeFile(recoveryPath, JSON.stringify({ ...recovery, phase }), { mode: 0o600 });
    for (const command of blockedCommands) {
      const before = (await readFile(failureLog, "utf8")).trim().split("\n").length;
      result = await fixture.run(failureRoot, failureLog, command.arguments, command.input);
      assertRejected(result, "RUNTIME_TRANSFER_RECOVERY_REQUIRED");
      const additions = (await readFile(failureLog, "utf8"))
        .trim()
        .split("\n")
        .slice(before)
        .map((line) => JSON.parse(line));
      assert.equal(
        additions.some(
          (entry) =>
            (entry.arguments.includes("server") &&
              (entry.arguments.includes("up") || entry.arguments.includes("start"))) ||
            (entry.arguments[0] === "volume" && ["create", "rm"].includes(entry.arguments[1])) ||
            entry.arguments.includes("--mount") ||
            entry.arguments.includes("--clean") ||
            entry.arguments.includes("--username=laundry_restore") ||
            entry.arguments.includes("--extract"),
        ),
        false,
        `${command.arguments.join(" ")} mutated runtime data`,
      );
      assert.equal(
        additions.some((entry) => entry.arguments.slice(-2).join(" ") === "stop server"),
        true,
        `${command.arguments.join(" ")} did not stop server fail-closed`,
      );
    }
  }
  await writeFile(recoveryPath, JSON.stringify(recovery), { mode: 0o600 });

  result = await fixture.run(
    failureRoot,
    failureLog,
    ["backup", "restore"],
    JSON.stringify({ backup_id: backup.backup_id, confirmation: backup.confirmation }),
  );
  assertRejected(result, "RUNTIME_TRANSFER_RECOVERY_REQUIRED");
  const wrongRecoveryCommands = (await readFile(failureLog, "utf8"))
    .trim()
    .split("\n")
    .slice(failureCommands.length)
    .map((line) => JSON.parse(line));
  assert.equal(
    wrongRecoveryCommands.some(
      (entry) =>
        entry.arguments.includes("--username=laundry_restore") ||
        entry.arguments.includes("--extract"),
    ),
    false,
  );
  assert.equal(
    JSON.parse(await readFile(join(failureRoot, "transfer-state.json"), "utf8")).phase,
    "failed",
  );

  result = await fixture.run(
    failureRoot,
    failureLog,
    ["backup", "restore"],
    JSON.stringify({
      backup_id: failureSafety.backup_id,
      confirmation: failureSafety.confirmation,
    }),
  );
  assertSuccess(result, "RUNTIME_TRANSFER_SAFETY_RECOVERY_FAILED");
  await assert.rejects(() => stat(join(failureRoot, "transfer-state.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(join(failureRoot, "transfer-staging")), []);
  result = await fixture.run(failureRoot, failureLog, ["start"]);
  assertSuccess(result, "RUNTIME_TRANSFER_RECOVERED_START_FAILED");
  result = await fixture.run(failureRoot, failureLog, ["status"]);
  assertSuccess(result, "RUNTIME_TRANSFER_RECOVERED_STATUS_FAILED");
  const recoveredDiagnosis = parse(result);
  assert.equal(recoveredDiagnosis.ok, true);
  assert.equal("transfer_phase" in recoveredDiagnosis, false);
  assert.equal("transfer_fault_code" in recoveredDiagnosis, false);
  assert.equal(
    JSON.parse(await readFile(`${failureRoot}/state.json`, "utf8")).instance_id,
    failureInstance,
  );

  for (const [name, failureToken, failureCode] of [
    ["volume", "volume", "RUNTIME_COMMAND_FAILED"],
    ["image", "{{json .Config.Labels}}", "RUNTIME_COMMAND_FAILED"],
    ["lan", "label=com.docker.compose.service=lan-gateway", "RUNTIME_LAN_STOP_FAILED"],
  ]) {
    const preflightRoot = fixture.root(`managed-preflight-${name}`);
    const preflightLog = fixture.log(`managed-preflight-${name}`);
    additionalLogs.push(preflightLog);
    result = await fixture.run(
      preflightRoot,
      preflightLog,
      ["install", "--manifest", fixture.manifest],
      setup,
    );
    assertSuccess(result, `RUNTIME_MANAGED_PREFLIGHT_${name.toUpperCase()}_INSTALL_FAILED`);
    result = await fixture.run(preflightRoot, preflightLog, ["maintenance"]);
    assertSuccess(result, `RUNTIME_MANAGED_PREFLIGHT_${name.toUpperCase()}_BACKUP_FAILED`);
    const backupID = parse(result).backup_id;
    result = await fixture.run(preflightRoot, preflightLog, ["backup", "list"]);
    const selected = parse(result).backups.find((entry) => entry.backup_id === backupID);
    await writeFile(`${preflightLog}.fail-once`, `${failureToken}\n`, { mode: 0o600 });
    result = await fixture.run(
      preflightRoot,
      preflightLog,
      ["backup", "restore"],
      JSON.stringify({ backup_id: selected.backup_id, confirmation: selected.confirmation }),
    );
    assertRejected(result, failureCode);
    assert.deepEqual(await readdir(join(preflightRoot, "payload-validation-staging")), []);
    await assert.rejects(() => stat(join(preflightRoot, "transfer-state.json")), {
      code: "ENOENT",
    });
  }

  for (const failureToken of ["--list", "stop"]) {
    const suffix = failureToken === "stop" ? "stop" : "validation";
    const managedRoot = fixture.root(`managed-${suffix}`);
    const managedLog = fixture.log(`managed-${suffix}`);
    additionalLogs.push(managedLog);
    result = await fixture.run(
      managedRoot,
      managedLog,
      ["install", "--manifest", fixture.manifest],
      setup,
    );
    assertSuccess(result, `RUNTIME_MANAGED_${suffix.toUpperCase()}_INSTALL_FAILED`);
    result = await fixture.run(managedRoot, managedLog, ["maintenance"]);
    assertSuccess(result, `RUNTIME_MANAGED_${suffix.toUpperCase()}_BACKUP_FAILED`);
    const maintenance = parse(result);
    result = await fixture.run(managedRoot, managedLog, ["backup", "list"]);
    assertSuccess(result, `RUNTIME_MANAGED_${suffix.toUpperCase()}_LIST_FAILED`);
    const selected = parse(result).backups.find(
      (entry) => entry.backup_id === maintenance.backup_id,
    );
    assert.equal(selected.verified, true);
    await writeFile(`${managedLog}.fail-once`, "--username=laundry_restore\n", {
      mode: 0o600,
    });
    result = await fixture.run(
      managedRoot,
      managedLog,
      ["backup", "restore"],
      JSON.stringify({ backup_id: selected.backup_id, confirmation: selected.confirmation }),
    );
    assertRejected(result, "RUNTIME_COMMAND_FAILED");
    const managedState = JSON.parse(
      await readFile(join(managedRoot, "transfer-state.json"), "utf8"),
    );
    assert.equal(managedState.phase, "failed");
    assert.equal(managedState.export_id, "managed-restore-v1");
    result = await fixture.run(managedRoot, managedLog, ["backup", "list"]);
    assertSuccess(result, `RUNTIME_MANAGED_${suffix.toUpperCase()}_LIST_FAILED`);
    const safety = parse(result).backups.find(
      (entry) => entry.backup_id === managedState.safety_backup_id,
    );
    assert.equal(safety.kind, "pre_restore");
    const beforeExact = (await readFile(managedLog, "utf8")).trim().split("\n").length;
    await writeFile(`${managedLog}.fail-once`, `${failureToken}\n`, { mode: 0o600 });
    result = await fixture.run(
      managedRoot,
      managedLog,
      ["backup", "restore"],
      JSON.stringify({ backup_id: safety.backup_id, confirmation: safety.confirmation }),
    );
    assertRejected(
      result,
      failureToken === "--list"
        ? "RUNTIME_TRANSFER_PAYLOAD_DATABASE_LIST_INVALID"
        : "RUNTIME_LAN_STOP_FAILED",
    );
    const exactCommands = (await readFile(managedLog, "utf8"))
      .trim()
      .split("\n")
      .slice(beforeExact)
      .map((line) => JSON.parse(line));
    assert.equal(
      exactCommands.some(
        (entry) =>
          entry.arguments.includes("--username=laundry_restore") ||
          entry.arguments.includes("--extract"),
      ),
      false,
    );
    assert.equal(
      exactCommands.some(
        (entry) =>
          entry.arguments.includes("server") &&
          (entry.arguments.includes("up") || entry.arguments.includes("start")),
      ),
      false,
    );
    assert.equal(
      JSON.parse(await readFile(join(managedRoot, "transfer-state.json"), "utf8")).phase,
      "failed",
    );
  }

  const lateRoot = fixture.root("late-phase-failure");
  const lateLog = fixture.log("late-phase-failure");
  result = await fixture.run(lateRoot, lateLog, ["install", "--manifest", fixture.manifest], setup);
  assertSuccess(result, "RUNTIME_TRANSFER_LATE_FIXTURE_INSTALL_FAILED");
  await writeFile(`${lateLog}.fail-nth.json`, JSON.stringify({ occurrence: 2, token: "verify" }), {
    mode: 0o600,
  });
  result = await fixture.run(lateRoot, lateLog, ["transfer", "import"], importInput);
  assertRejected(result, "RUNTIME_COMMAND_FAILED");
  const lateRecovery = JSON.parse(await readFile(join(lateRoot, "transfer-state.json"), "utf8"));
  assert.equal(lateRecovery.phase, "failed");
  assert.equal(lateRecovery.fault_code, "RUNTIME_COMMAND_FAILED");
  await Promise.all([stat(`${lateLog}.restored-database`), stat(`${lateLog}.restored-photos`)]);
  const lateCommands = (await readFile(lateLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const lateServerStop = lateCommands.findLastIndex(
    (entry) => entry.arguments.slice(-2).join(" ") === "stop server",
  );
  assert.ok(lateServerStop >= 0);
  assert.equal(
    lateCommands
      .slice(lateServerStop + 1)
      .some((entry) => entry.arguments.includes("up") && entry.arguments.includes("server")),
    false,
  );

  const transcript = [
    await readFile(sourceLog, "utf8"),
    await readFile(destinationLog, "utf8"),
    await readFile(failureLog, "utf8"),
    await readFile(lateLog, "utf8"),
    ...(await Promise.all(additionalLogs.map((log) => readFile(log, "utf8")))),
    JSON.stringify(exported),
    JSON.stringify(inspected),
    JSON.stringify(imported),
  ].join("\n");
  assert.doesNotMatch(transcript, secretPattern);
  assert.doesNotMatch(
    transcript,
    new RegExp(transferPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
  for (const log of [sourceLog, destinationLog, failureLog, lateLog, ...additionalLogs]) {
    const entries = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      entries.some((entry) => JSON.stringify(entry.arguments).includes(transferPassword)),
      false,
    );
    assert.equal(
      entries.some((entry) => JSON.stringify(entry.environment ?? {}).includes(transferPassword)),
      false,
    );
  }

  process.stdout.write(
    "RUNTIME_DATA_TRANSFER_ACCEPTANCE_OK roots=2 identity=destination-preserved\n",
  );
} finally {
  await fixture.cleanup();
}
