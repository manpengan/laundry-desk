import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { commissionSetup, setup } from "./no-repo-helpers.mjs";

const projectLabel = "label=com.docker.compose.project=laundry-desk-runtime";
const gatewayLabel = "label=com.docker.compose.service=lan-gateway";
const secretPattern =
  /native-acceptance-password|independent-approver-password|legacy-approver-password|86420987|97531864|753186/u;
const approverSecretNames = Object.freeze([
  "bootstrap-approver-username",
  "bootstrap-approver-display-name",
  "bootstrap-approver-password",
  "bootstrap-approver-pin",
]);

const parse = (result) => JSON.parse(result.stdout);
const commandIsGatewayQuery = (entry) =>
  entry.arguments[0] === "ps" &&
  entry.arguments.includes(projectLabel) &&
  entry.arguments.includes(gatewayLabel);
const commandIsGatewayStart = (entry) =>
  entry.arguments.includes("up") && entry.arguments.includes("lan-gateway");
const commandIsServerStart = (entry) =>
  entry.arguments.includes("up") && entry.arguments.includes("server");
const commandIsBaseServerStop = (entry) =>
  entry.arguments.slice(-2).join(" ") === "stop server" &&
  entry.arguments.filter((argument) => argument === "--file").length === 1;

const commands = async (log) => {
  const text = await readFile(log, "utf8");
  return text.trim() === ""
    ? []
    : text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
};
const commandsSince = async (log, offset) => (await commands(log)).slice(offset);
const assertMissing = (path) => assert.rejects(() => stat(path), { code: "ENOENT" });
const assertNoCredentials = async (log) => {
  assert.doesNotMatch(await readFile(log, "utf8"), secretPattern);
};
const assertLanDisabled = async (run) => {
  const result = await run(["lan", "status"]);
  assert.equal(result.code, 0, result.stderr);
  const status = parse(result);
  assert.equal(status.configured, true);
  assert.equal(status.enabled, false);
  assert.equal("fault_code" in status, false);
};
const assertFinalStops = (entries, failureIndex) => {
  const serverStop = entries.findLastIndex(commandIsBaseServerStop);
  const gatewayStop = entries.findLastIndex(commandIsGatewayQuery);
  assert.ok(serverStop > failureIndex && gatewayStop > serverStop);
  assert.equal(
    entries
      .slice(serverStop + 1)
      .some((entry) => commandIsServerStart(entry) || commandIsGatewayStart(entry)),
    false,
  );
};

export async function runLanMaintenanceAcceptance({
  runAt,
  executable,
  manifest,
  upgradeManifest,
  configureInput,
  temporary,
}) {
  const fixture = async (name, { enabled = true, legacy = false } = {}) => {
    const root = join(temporary, `maintenance-${name}`);
    const log = join(temporary, `maintenance-${name}.jsonl`);
    const run = (args, input = "", environment = {}) =>
      runAt(executable, root, log, args, input, environment);
    let result = await run(["install", "--manifest", manifest], setup);
    assert.equal(result.code, 0, result.stderr);
    if (legacy) {
      await writeFile(`${log}.commission-required`, "required\n", { mode: 0o600 });
    }
    result = await run(["lan", "configure"], configureInput);
    assert.equal(result.code, 0, result.stderr);
    const generation = parse(result).generation;
    if (enabled) {
      result = await run(["lan", "enable"]);
      assert.equal(result.code, 0, result.stderr);
    }
    return Object.freeze({ root, log, run, generation });
  };

  const neverConfiguredRoot = join(temporary, "maintenance-never-configured");
  const neverConfiguredLog = join(temporary, "maintenance-never-configured.jsonl");
  const runNeverConfigured = (args, input = "", environment = {}) =>
    runAt(executable, neverConfiguredRoot, neverConfiguredLog, args, input, environment);
  let result = await runNeverConfigured(["install", "--manifest", manifest], setup);
  assert.equal(result.code, 0, result.stderr);
  result = await runNeverConfigured(["lan", "disable"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_PROFILE_MISSING/u);
  assert.deepEqual(parse(await runNeverConfigured(["lan", "status"])), {
    configured: false,
    enabled: false,
  });
  for (const name of [
    "state.json",
    "state-commit-uncertain.json",
    "physical-state-uncertain.json",
  ]) {
    await assertMissing(join(neverConfiguredRoot, "lan", name));
  }
  result = await runNeverConfigured(["backup", "create"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).lan_status, "not_configured");

  for (const token of ["ps", "-f"]) {
    const current = await fixture(`stop-failure-${token === "ps" ? "query" : "remove"}`);
    await writeFile(`${current.log}.fail-once`, `${token}\n`, { mode: 0o600 });
    result = await current.run(["lan", "enable"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /RUNTIME_LAN_STOP_FAILED/u);
    assert.deepEqual(parse(await current.run(["lan", "status"])), {
      configured: false,
      enabled: false,
      fault_code: "RUNTIME_LAN_PHYSICAL_STATE_UNCERTAIN",
    });
    const offset = (await commands(current.log)).length;
    result = await current.run(["start"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /RUNTIME_LAN_STOP_FAILED/u);
    assert.equal((await commandsSince(current.log, offset)).some(commandIsGatewayStart), false);
  }

  const escalated = await fixture("state-commit-stop-failure", { enabled: false });
  await writeFile(`${escalated.log}.fail-once`, "-f\n", { mode: 0o600 });
  result = await escalated.run(["lan", "enable"], "", {
    LAUNDRY_RUNTIME_TEST_FAIL_ATOMIC_WRITE: "lan/state.json",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_STOP_FAILED/u);
  assert.deepEqual(parse(await escalated.run(["lan", "status"])), {
    configured: false,
    enabled: false,
    fault_code: "RUNTIME_LAN_PHYSICAL_STATE_UNCERTAIN",
  });
  await assertMissing(join(escalated.root, "lan/state-commit-uncertain.json"));

  const assertTamperedDisable = async (name, pathFor, expectedCode) => {
    const current = await fixture(`tampered-${name}`);
    const path = pathFor(current);
    const original = await readFile(path);
    await writeFile(path, "{}", { mode: 0o600 });
    result = await current.run(["lan", "disable"]);
    assert.equal(result.code, expectedCode);
    const lanState = JSON.parse(await readFile(join(current.root, "lan/state.json"), "utf8"));
    assert.equal(lanState.status, "disabled");
    await writeFile(path, original, { mode: 0o600 });
    const offset = (await commands(current.log)).length;
    result = await current.run(["start"]);
    assert.equal(result.code, 0, result.stderr);
    await assertLanDisabled(current.run);
    assert.equal((await commandsSince(current.log, offset)).some(commandIsGatewayStart), false);
  };
  await assertTamperedDisable("runtime-state", ({ root }) => join(root, "state.json"), 0);
  await assertTamperedDisable(
    "runtime-manifest",
    ({ root }) => join(root, "runtime-manifest.json"),
    0,
  );
  await assertTamperedDisable(
    "profile",
    ({ root, generation }) => join(root, "lan/generations", generation, "profile.json"),
    1,
  );

  const backup = await fixture("backup");
  result = await backup.run(["backup", "create"]);
  assert.equal(result.code, 0, result.stderr);
  const manualBackup = parse(result);
  assert.equal(manualBackup.lan_status, "enabled");
  assert.equal("lan_fault_code" in manualBackup, false);
  await writeFile(`${backup.log}.fail-once`, "pg_dump\n", { mode: 0o600 });
  result = await backup.run(["backup", "create"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
  assert.equal(parse(await backup.run(["lan", "status"])).enabled, true);
  await stat(`${backup.log}.lan-running`);

  const restoreInput = JSON.stringify({
    backup_id: manualBackup.backup_id,
    confirmation: manualBackup.confirmation,
  });
  result = await backup.run(["backup", "restore"], restoreInput);
  assert.equal(result.code, 0, result.stderr);
  const restored = parse(result);
  assert.equal(restored.lan_status, "enabled");
  assert.equal("lan_fault_code" in restored, false);
  const restoreOffset = (await commands(backup.log)).length;
  await writeFile(
    `${backup.log}.fail-nth.json`,
    JSON.stringify({ token: "http://127.0.0.1:8787/health", occurrence: 1 }),
    { mode: 0o600 },
  );
  result = await backup.run(["backup", "restore"], restoreInput);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
  const failedRestoreCommands = await commandsSince(backup.log, restoreOffset);
  const restoreMutation = failedRestoreCommands.findIndex((entry) =>
    entry.arguments.includes("--username=laundry_restore"),
  );
  const restoreHealth = failedRestoreCommands.findLastIndex((entry) =>
    entry.arguments.includes("http://127.0.0.1:8787/health"),
  );
  assert.ok(restoreMutation >= 0 && restoreHealth > restoreMutation);
  assertFinalStops(failedRestoreCommands, restoreHealth);
  await assertLanDisabled(backup.run);
  await assertMissing(`${backup.log}.lan-running`);

  const authorityFailure = await fixture("commission-authority-failure", { legacy: true });
  const authorityOffset = (await commands(authorityFailure.log)).length;
  await writeFile(
    `${authorityFailure.log}.fail-nth.json`,
    JSON.stringify({ token: "http://127.0.0.1:8787/health", occurrence: 1 }),
    { mode: 0o600 },
  );
  result = await authorityFailure.run(["commission"], commissionSetup);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
  const authorityCommands = await commandsSince(authorityFailure.log, authorityOffset);
  const authorityMutation = authorityCommands.findIndex((entry) =>
    entry.arguments.includes("commission"),
  );
  const authorityHealth = authorityCommands.findLastIndex((entry) =>
    entry.arguments.includes("http://127.0.0.1:8787/health"),
  );
  assert.ok(authorityMutation >= 0 && authorityHealth > authorityMutation);
  assertFinalStops(authorityCommands, authorityHealth);
  await assertLanDisabled(authorityFailure.run);
  await assertMissing(`${authorityFailure.log}.lan-running`);
  await assertNoCredentials(authorityFailure.log);

  for (const phase of ["unlink", "fsync"]) {
    const cleanup = await fixture(`commission-cleanup-${phase}`, { legacy: true });
    const offset = (await commands(cleanup.log)).length;
    result = await cleanup.run(["commission"], commissionSetup, {
      LAUNDRY_RUNTIME_TEST_FAIL_COMMISSION_SECRET_CLEANUP: `${phase}:2`,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /RUNTIME_COMMISSION_SECRET_CLEANUP_FAILED/u);
    const cleanupCommands = await commandsSince(cleanup.log, offset);
    assertFinalStops(cleanupCommands, -1);
    await assertLanDisabled(cleanup.run);
    await assertMissing(`${cleanup.log}.lan-running`);
    await assertNoCredentials(cleanup.log);
    assert.doesNotMatch(result.stdout + result.stderr, secretPattern);
    for (const name of approverSecretNames) {
      await assertMissing(join(cleanup.root, "secrets", name));
    }
  }

  const commissioned = await fixture("commission-success", { legacy: true });
  result = await commissioned.run(["commission"], commissionSetup);
  assert.equal(result.code, 0, result.stderr);
  const commissionResult = parse(result);
  assert.equal(commissionResult.status, "commissioned");
  assert.equal(commissionResult.lan_status, "enabled");
  assert.equal("lan_fault_code" in commissionResult, false);
  assert.equal(parse(await commissioned.run(["lan", "status"])).enabled, true);
  await assertNoCredentials(commissioned.log);

  const release = await fixture("release-recovery");
  await writeFile(`${release.log}.fail-once`, "verify\n", { mode: 0o600 });
  await writeFile(
    `${release.log}.fail-nth.json`,
    JSON.stringify({ token: "http://127.0.0.1:8787/health", occurrence: 1 }),
    { mode: 0o600 },
  );
  const releaseOffset = (await commands(release.log)).length;
  result = await release.run(["upgrade", "--manifest", upgradeManifest]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_RELEASE_RECOVERY_REQUIRED/u);
  const releaseCommands = await commandsSince(release.log, releaseOffset);
  const lateHealth = releaseCommands.findLastIndex((entry) =>
    entry.arguments.includes("http://127.0.0.1:8787/health"),
  );
  assertFinalStops(releaseCommands, lateHealth);
  await assertLanDisabled(release.run);
  await assertMissing(`${release.log}.lan-running`);

  for (const current of [authorityFailure, commissioned]) {
    for (const name of approverSecretNames) {
      await assertMissing(join(current.root, "secrets", name));
    }
  }
  process.stdout.write("RUNTIME_NATIVE_NO_REPO_LAN_MAINTENANCE_ACCEPTANCE_OK scenarios=16\n");
}
