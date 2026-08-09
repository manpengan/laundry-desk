import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { commissionSetup, setup } from "./no-repo-helpers.mjs";

const commandsSince = async (log, offset) =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .slice(offset)
    .map((line) => JSON.parse(line));

export async function runLegacyCommissionAcceptance({
  execute,
  manifest,
  temporary,
  upgradeManifest,
  upgradeRelease,
}) {
  const root = join(temporary, "config-legacy-upgrade");
  const log = join(temporary, "legacy-upgrade-runner.jsonl");
  let result = await execute(root, log, ["install", "--manifest", manifest], setup);
  assert.equal(result.code, 0, result.stderr);
  await writeFile(`${log}.commission-required`, "required\n", { mode: 0o600 });

  result = await execute(root, log, ["upgrade", "--manifest", upgradeManifest]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).release, upgradeRelease);
  result = await execute(root, log, ["status"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).commission_required, true);
  result = await execute(root, log, ["start"]);
  assert.equal(result.code, 0, result.stderr);

  result = await execute(root, log, ["commission"], commissionSetup, {
    LAUNDRY_RUNTIME_TEST_FAIL_PRIVATE_WRITE: "bootstrap-approver-password",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_PRIVATE_PATH_INVALID/u);
  for (const name of [
    "bootstrap-approver-username",
    "bootstrap-approver-display-name",
    "bootstrap-approver-password",
    "bootstrap-approver-pin",
  ]) {
    await assert.rejects(() => stat(join(root, "secrets", name)), { code: "ENOENT" });
  }

  let offset = (await readFile(log, "utf8")).trim().split("\n").length;
  await writeFile(`${log}.fail-once`, "commission", { mode: 0o600 });
  result = await execute(root, log, ["commission"], commissionSetup);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
  let commands = await commandsSince(log, offset);
  const failedCommission = commands.findIndex((entry) => entry.arguments.includes("commission"));
  assert.ok(failedCommission > 0);
  assert.ok(
    commands
      .slice(0, failedCommission)
      .some((entry) => entry.arguments.includes("stop") && entry.arguments.includes("server")),
  );
  assert.equal(
    commands
      .slice(failedCommission + 1)
      .some((entry) => entry.arguments.includes("up") && entry.arguments.includes("server")),
    false,
  );

  offset = (await readFile(log, "utf8")).trim().split("\n").length;
  result = await execute(root, log, ["commission"], commissionSetup);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "commissioned");
  commands = await commandsSince(log, offset);
  const strictVerify = commands.findIndex((entry) =>
    entry.arguments.includes("verify-commissioned"),
  );
  const serverStart = commands.findIndex(
    (entry, index) =>
      index > strictVerify && entry.arguments.includes("up") && entry.arguments.includes("server"),
  );
  assert.ok(strictVerify >= 0 && serverStart > strictVerify);
  for (const name of [
    "bootstrap-approver-username",
    "bootstrap-approver-display-name",
    "bootstrap-approver-password",
    "bootstrap-approver-pin",
  ]) {
    await assert.rejects(() => stat(join(root, "secrets", name)), { code: "ENOENT" });
  }
  result = await execute(root, log, ["status"]);
  assert.equal(JSON.parse(result.stdout).commission_required, false);

  result = await execute(root, log, ["commission"], commissionSetup);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
  assert.doesNotMatch(await readFile(log, "utf8"), /legacy-approver-password|753186/u);
}
