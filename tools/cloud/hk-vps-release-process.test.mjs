import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudReleaseError } from "./hk-vps-release-core.mjs";
import {
  runCloudCommand,
  runPinnedSshReleaseCommand,
  withCloudSignalCancellation,
} from "./hk-vps-release-process.mjs";
import { parseSafeRemoteReleaseErrorCode } from "./hk-vps-release-remote-error-contract.mjs";

const CLEAN_ENVIRONMENT = Object.freeze({ LANG: "C", PATH: "/usr/bin:/bin" });

function nodeCommand(source, options = {}) {
  return runCloudCommand(process.execPath, ["-e", source], {
    cwd: "/",
    environment: CLEAN_ENVIRONMENT,
    label: "TEST_COMMAND",
    timeoutMs: 5_000,
    ...options,
  });
}

async function waitForPath(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  assert.fail(`timed out waiting for ${path}`);
}

test("bounded command captures separate output and honors accepted exit codes", async () => {
  const result = await nodeCommand(
    'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)',
    { accepting: [7] },
  );
  assert.deepEqual(result, { code: 7, stdout: "out", stderr: "err" });
  await assert.rejects(
    () => nodeCommand("process.exit(7)"),
    (error) => {
      assert.ok(error instanceof CloudReleaseError);
      assert.equal(error.code, "TEST_COMMAND_FAILED");
      return true;
    },
  );
});

test("remote stable errors require an exact allowlisted stderr-only record", () => {
  assert.equal(
    parseSafeRemoteReleaseErrorCode("", "CLOUD_RELEASE_INSTALL_FAILED\n"),
    "CLOUD_RELEASE_INSTALL_FAILED",
  );
  assert.equal(
    parseSafeRemoteReleaseErrorCode("", "CLOUD_RELEASE_BACKUP_RECOVERY_REQUIRED\n"),
    "CLOUD_RELEASE_BACKUP_RECOVERY_REQUIRED",
  );
  for (const code of [
    "CLOUD_RELEASE_LOOPBACK_HEALTH_ABORTED",
    "CLOUD_RELEASE_PUBLIC_HEALTH_ABORTED",
    "CLOUD_RELEASE_PUBLIC_HEALTH_FAILED",
    "CLOUD_RELEASE_PUBLIC_READINESS_TIMEOUT",
    "CLOUD_RELEASE_PUBLIC_SPA_ABORTED",
    "CLOUD_RELEASE_PUBLIC_SPA_FAILED",
  ]) {
    assert.equal(parseSafeRemoteReleaseErrorCode("", `${code}\n`), code);
  }
  for (const [stdout, stderr] of [
    ["", "CLOUD_RELEASE_UNKNOWN_FAILURE\n"],
    ["", "prefix CLOUD_RELEASE_INSTALL_FAILED\n"],
    ["", "CLOUD_RELEASE_INSTALL_FAILED\nsecret=/tmp/value\n"],
    ["", "CLOUD_RELEASE_INSTALL_FAILED"],
    ["CLOUD_RELEASE_INSTALL_FAILED\n", ""],
    ["noise", "CLOUD_RELEASE_INSTALL_FAILED\n"],
  ]) {
    assert.equal(parseSafeRemoteReleaseErrorCode(stdout, stderr), null);
  }
});

test("remote error preservation cannot be enabled outside the pinned SSH boundary", () => {
  assert.throws(
    () =>
      runPinnedSshReleaseCommand(process.execPath, ["-e", "process.exit(1)"], {
        cwd: "/",
        environment: CLEAN_ENVIRONMENT,
        label: "CLOUD_RELEASE_REMOTE_DEPLOY",
      }),
    { code: "CLOUD_RELEASE_COMMAND_INVALID" },
  );
});

test("command boundary rejects relative executables, invalid environment, and pre-abort", () => {
  assert.throws(
    () =>
      runCloudCommand("node", [], {
        cwd: "/",
        environment: CLEAN_ENVIRONMENT,
        label: "TEST_INVALID",
      }),
    { code: "CLOUD_RELEASE_COMMAND_INVALID" },
  );
  assert.throws(() => nodeCommand("", { environment: { "BAD-NAME": "value" } }), {
    code: "CLOUD_RELEASE_COMMAND_INVALID",
  });
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => nodeCommand("", { signal: controller.signal }), {
    code: "TEST_COMMAND_ABORTED",
  });
});

test("combined stdout and stderr output cap terminates the detached group", async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      nodeCommand(
        'process.stdout.write("x".repeat(96)); process.stderr.write("y".repeat(96)); setInterval(() => {}, 1000)',
        { maximumOutputBytes: 128 },
      ),
    { code: "TEST_COMMAND_OUTPUT_TOO_LARGE" },
  );
  assert.ok(Date.now() - started < 4_000);
});

test("timeout remains the local bounded-command label even after safe-looking stderr", async () => {
  await assert.rejects(
    () =>
      nodeCommand(
        'process.stderr.write("CLOUD_RELEASE_INSTALL_FAILED\\n"); setInterval(() => {}, 1000)',
        { timeoutMs: 20 },
      ),
    { code: "TEST_COMMAND_TIMEOUT" },
  );
});

test("abort kills descendants in the detached process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-process-group-"));
  const ready = join(root, "grandchild-started");
  const marker = join(root, "grandchild-survived");
  const controller = new AbortController();
  const grandchild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
    marker,
  )}, "alive"), 500); setInterval(() => {}, 1000)`;
  const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
    grandchild,
  )}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(
    ready,
  )}, "ready"); setInterval(() => {}, 1000)`;
  try {
    const running = nodeCommand(parent, { signal: controller.signal });
    await waitForPath(ready);
    controller.abort();
    await assert.rejects(() => running, { code: "TEST_COMMAND_ABORTED" });
    await assert.rejects(() => access(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signal cancellation aborts once and always removes process listeners", async () => {
  const processObject = new EventEmitter();
  const operation = withCloudSignalCancellation(async (signal) => {
    processObject.emit("SIGTERM");
    processObject.emit("SIGINT");
    assert.equal(signal.aborted, true);
    return "ignored";
  }, processObject);
  await assert.rejects(() => operation, { code: "CLOUD_RELEASE_INTERRUPTED_SIGTERM" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(processObject.listenerCount(signal), 0);
  }
});
