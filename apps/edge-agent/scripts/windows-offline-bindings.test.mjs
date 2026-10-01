import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  boundEntryTrust,
  boundRuntimeResult,
  createControllerGate,
} from "../e2e/windows-offline-bindings.mjs";

const source = "a".repeat(40);
const manifest = "b".repeat(64);
const result = Object.freeze({
  status: "running",
  assurance: "development_only",
  source_git_sha: source,
  manifest_sha256: manifest,
  migration_head: "0050",
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("offline acceptance consumes only exact current development Runtime responses", () => {
  assert.deepEqual(boundRuntimeResult(JSON.stringify(result), "status", source, manifest), result);
  assert.deepEqual(boundRuntimeResult(JSON.stringify(result), "start", source, manifest), result);
  const stopped = { ...result, status: "stopped" };
  assert.deepEqual(boundRuntimeResult(JSON.stringify(stopped), "stop", source, manifest), stopped);
  for (const changed of [
    { source_git_sha: "c".repeat(40) },
    { manifest_sha256: "c".repeat(64) },
    { assurance: "production" },
    { status: "maintenance_required" },
    { private_path: "secret" },
    { migration_head: null },
  ])
    assert.throws(
      () =>
        boundRuntimeResult(JSON.stringify({ ...result, ...changed }), "status", source, manifest),
      { message: "WINDOWS_OFFLINE_RUNTIME_BINDING_INVALID" },
    );
});

test("offline acceptance rejects duplicate, noncanonical, oversized, and secret-bearing native JSON", () => {
  const compact = JSON.stringify(result);
  for (const raw of [
    `${compact.slice(0, -1)},"status":"running"}`,
    JSON.stringify(result, null, 2),
    `${compact}\n`,
    " ".repeat(65_537),
    "{private-password-is-not-json}",
  ])
    assert.throws(() => boundRuntimeResult(raw, "status", source, manifest), {
      message: "WINDOWS_OFFLINE_RUNTIME_BINDING_INVALID",
    });
  assert.throws(() => boundRuntimeResult(compact, "stop", source, manifest), {
    message: "WINDOWS_OFFLINE_RUNTIME_BINDING_INVALID",
  });
});

test("offline acceptance reuses exactly the verified production no-follow trust implementation", async () => {
  const bytes = await readFile(
    new URL("../../../tools/windows-runtime/runtime-entry-trust.ps1", import.meta.url),
  );
  const trust = boundEntryTrust(bytes, digest(bytes));
  assert.match(trust, /HoldDirectoryPath/u);
  assert.match(trust, /OpenVerified/u);
  assert.match(trust, /AssertPrivateDirectory/u);
  assert.throws(() => boundEntryTrust(bytes, "0".repeat(64)), {
    message: "WINDOWS_OFFLINE_ENTRY_TRUST_INVALID",
  });
  for (const invalid of [
    Buffer.concat([bytes, bytes]),
    Buffer.from("secret entry text"),
    Buffer.alloc(262_145),
  ]) {
    assert.throws(() => boundEntryTrust(invalid, digest(invalid)), {
      message: "WINDOWS_OFFLINE_ENTRY_TRUST_INVALID",
    });
  }
});

test("an ambiguous controller exit permanently closes all subsequent Runtime actions", async () => {
  const calls = [];
  const controller = createControllerGate(async (verb) => {
    calls.push(verb);
    if (verb === "stop") throw new Error("private native stderr");
    return result;
  });
  await controller.action("status");
  await assert.rejects(controller.action("stop"), {
    message: "WINDOWS_OFFLINE_CONTROLLER_UNCONFIRMED",
  });
  assert.equal(controller.recoveryRequired(), true);
  for (const verb of ["start", "stop", "status"]) {
    await assert.rejects(controller.action(verb), { message: "WINDOWS_OFFLINE_RECOVERY_REQUIRED" });
  }
  assert.deepEqual(calls, ["status", "stop"]);
});

test("a running controller rejects overlap and only a successful result reopens the action gate", async () => {
  let finish;
  const controller = createControllerGate(
    async () =>
      await new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const active = controller.action("status");
  await assert.rejects(controller.action("start"), {
    message: "WINDOWS_OFFLINE_RECOVERY_REQUIRED",
  });
  finish(result);
  await active;
  assert.equal(controller.recoveryRequired(), false);
});
