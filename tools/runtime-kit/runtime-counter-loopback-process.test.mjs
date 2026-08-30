import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { selectHostEnvironment } from "./runtime-counter-loopback-core.mjs";
import { runRuntimeCounterAcceptanceLifecycle } from "./runtime-counter-loopback-acceptance.mjs";
import {
  runBoundedCommand,
  runWithProcessSignalCancellation,
} from "./runtime-counter-loopback-process.mjs";

const environment = selectHostEnvironment(process.env);
const processModuleUrl = new URL("./runtime-counter-loopback-process.mjs", import.meta.url).href;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessId(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(path, "utf8");
      if (/^[1-9][0-9]*$/u.test(contents)) {
        const processId = Number(contents);
        if (Number.isSafeInteger(processId) && processId > 1) return processId;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(20);
  }
  throw new Error("RUNTIME_COUNTER_TEST_PID_TIMEOUT");
}

async function waitForProcessExit(processId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(processId)) return;
    await delay(20);
  }
  throw new Error("RUNTIME_COUNTER_TEST_PROCESS_STILL_ALIVE");
}

function killIfAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 1 || !processExists(processId)) return;
  process.kill(processId, "SIGKILL");
}

async function waitForReady(child) {
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("RUNTIME_COUNTER_TEST_READY_TIMEOUT")), 5_000);
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("close", onClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("READY\n")) finish();
    };
    const onClose = (code, signal) =>
      finish(new Error(`RUNTIME_COUNTER_TEST_EARLY_CLOSE_${code ?? signal ?? "UNKNOWN"}`));
    child.stdout.on("data", onData);
    child.once("close", onClose);
  });
}

async function assertStubbornProcessGroupIsKilled(trigger) {
  const root = await mkdtemp(join(tmpdir(), "runtime-counter-process-group-test-"));
  const grandchildPath = join(root, "grandchild.pid");
  let grandchildPid = null;
  const grandchildSource = `
    const { writeFileSync } = require("node:fs");
    writeFileSync(process.argv[1], String(process.pid), { flag: "wx" });
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1_000);
  `;
  const leaderSource = `
    const { existsSync } = require("node:fs");
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}, process.argv[1]], {
      detached: false,
      stdio: "ignore",
    });
    process.on("SIGTERM", () => process.exit(0));
    if (process.argv[2] === "cap") {
      const timer = setInterval(() => {
        if (!existsSync(process.argv[1])) return;
        clearInterval(timer);
        process.stdout.write("x".repeat(2_048));
      }, 10);
    }
    setInterval(() => undefined, 1_000);
  `;
  try {
    await assert.rejects(
      () =>
        runBoundedCommand(process.execPath, ["-e", leaderSource, grandchildPath, trigger], {
          environment,
          label: `RUNTIME_COUNTER_TEST_GROUP_${trigger.toUpperCase()}`,
          maximumOutputBytes: trigger === "cap" ? 1_024 : 4_096,
          timeoutMs: trigger === "timeout" ? 500 : 5_000,
        }),
      new RegExp(
        `RUNTIME_COUNTER_TEST_GROUP_${trigger.toUpperCase()}_(?:TIMEOUT|OUTPUT_TOO_LARGE)`,
        "u",
      ),
    );
    grandchildPid = await waitForProcessId(grandchildPath);
    await waitForProcessExit(grandchildPid);
  } finally {
    killIfAlive(grandchildPid);
    await rm(root, { force: true, recursive: true });
  }
}

test("bounded executor sends input through stdin without adding argv", async () => {
  const result = await runBoundedCommand(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    {
      environment,
      input: "stdin-only-canary",
      label: "RUNTIME_COUNTER_TEST_STDIN",
      timeoutMs: 5_000,
    },
  );
  assert.equal(result.stdout, "stdin-only-canary");
  assert.equal(result.stderr, "");
});

test("bounded executor fails closed when combined output exceeds its cap", async () => {
  await assert.rejects(
    () =>
      runBoundedCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], {
        environment,
        label: "RUNTIME_COUNTER_TEST_CAP",
        maximumOutputBytes: 1_024,
        timeoutMs: 5_000,
      }),
    /RUNTIME_COUNTER_TEST_CAP_OUTPUT_TOO_LARGE/u,
  );
});

test("bounded executor maps non-zero and timeout results to stable codes", async () => {
  await assert.rejects(
    () =>
      runBoundedCommand(process.execPath, ["-e", "process.exit(7)"], {
        environment,
        label: "RUNTIME_COUNTER_TEST_EXIT",
        timeoutMs: 5_000,
      }),
    /RUNTIME_COUNTER_TEST_EXIT_FAILED/u,
  );
  await assert.rejects(
    () =>
      runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        environment,
        label: "RUNTIME_COUNTER_TEST_TIMEOUT",
        timeoutMs: 25,
      }),
    /RUNTIME_COUNTER_TEST_TIMEOUT_TIMEOUT/u,
  );
});

test("bounded executor always SIGKILLs a stopped process group after its leader closes", async () => {
  await assertStubbornProcessGroupIsKilled("timeout");
  await assertStubbornProcessGroupIsKilled("cap");
});

test("bounded executor never treats a signal as an accepted numeric exit", async () => {
  await assert.rejects(
    () =>
      runBoundedCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], {
        accepting: [1],
        environment,
        label: "RUNTIME_COUNTER_TEST_SIGNAL",
        timeoutMs: 5_000,
      }),
    /RUNTIME_COUNTER_TEST_SIGNAL_FAILED/u,
  );
});

test("actual acceptance lifecycle cancels its command before unified temp and lease cleanup", async () => {
  for (const orchestratorSignal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const root = await mkdtemp(join(tmpdir(), "runtime-counter-lifecycle-test-"));
    const leasePath = join(root, "acceptance.lock");
    const activePidPath = join(root, "active.pid");
    const processEvents = new EventEmitter();
    let activePid = null;
    let acceptanceTemporaryRoot = null;
    let ready;
    const activeSource = `
      const { writeFileSync } = require("node:fs");
      writeFileSync(process.argv[1], String(process.pid), { flag: "wx" });
      setInterval(() => undefined, 1_000);
    `;
    const readyPromise = new Promise((resolve) => {
      ready = resolve;
    });
    const lifecycle = runWithProcessSignalCancellation(
      (abortSignal) =>
        runRuntimeCounterAcceptanceLifecycle(
          { signal: abortSignal },
          {
            acceptanceScenario: async ({ run, temporaryRoot }) => {
              acceptanceTemporaryRoot = temporaryRoot;
              const signingKeyPath = join(temporaryRoot, "runtime-test-signing-private.pem");
              await writeFile(signingKeyPath, "acceptance-owned-key", {
                flag: "wx",
                mode: 0o600,
              });
              assert.equal((await stat(signingKeyPath)).mode & 0o777, 0o600);
              const activeCommand = run(process.execPath, ["-e", activeSource, activePidPath], {
                label: "RUNTIME_COUNTER_TEST_LIFECYCLE_ACTIVE",
                timeoutMs: 60_000,
              });
              ready();
              await activeCommand;
            },
            leasePath,
          },
        ),
      processEvents,
    );
    try {
      await readyPromise;
      activePid = await waitForProcessId(activePidPath);
      processEvents.emit(orchestratorSignal);
      await assert.rejects(lifecycle, /RUNTIME_COUNTER_TEST_LIFECYCLE_ACTIVE_ABORTED/u);
      await waitForProcessExit(activePid);
      await assert.rejects(() => stat(leasePath), { code: "ENOENT" });
      assert.equal(typeof acceptanceTemporaryRoot, "string");
      await assert.rejects(() => stat(acceptanceTemporaryRoot), { code: "ENOENT" });
    } finally {
      processEvents.emit(orchestratorSignal);
      killIfAlive(activePid);
      if (typeof acceptanceTemporaryRoot === "string") {
        await rm(acceptanceTemporaryRoot, { force: true, recursive: true });
      }
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("orchestrator signals cancel the active command and await its isolated cleanup", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const root = await mkdtemp(join(tmpdir(), "runtime-counter-signal-test-"));
    const cleanupPath = join(root, "cleanup.marker");
    const activePidPath = join(root, "active.pid");
    let activePid = null;
    let child = null;
    const activeSource = `
      const { writeFileSync } = require("node:fs");
      writeFileSync(process.argv[1], String(process.pid), { flag: "wx" });
      setInterval(() => undefined, 1_000);
    `;
    const orchestratorSource = `
      import { writeFile } from "node:fs/promises";
      import {
        runBoundedCommand,
        runWithProcessSignalCancellation,
      } from ${JSON.stringify(processModuleUrl)};
      const [cleanupPath, activePidPath] = process.argv.slice(1);
      try {
        await runWithProcessSignalCancellation(async (abortSignal) => {
          const activeCommand = runBoundedCommand(
            process.execPath,
            ["-e", ${JSON.stringify(activeSource)}, activePidPath],
            {
              environment: {},
              label: "RUNTIME_COUNTER_TEST_ACTIVE",
              signal: abortSignal,
              timeoutMs: 60_000,
            },
          );
          process.stdout.write("READY\\n");
          try {
            await activeCommand;
          } finally {
            await writeFile(cleanupPath, "cleaned", { flag: "wx", mode: 0o600 });
          }
        });
      } catch {
        process.exitCode = 1;
      }
    `;
    try {
      child = spawn(
        process.execPath,
        ["--input-type=module", "-e", orchestratorSource, cleanupPath, activePidPath],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = new Promise((resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, closeSignal })),
      );
      await waitForReady(child);
      activePid = await waitForProcessId(activePidPath);
      assert.equal(child.kill(signal), true);
      const result = await closed;
      assert.deepEqual(result, { code: 1, closeSignal: null });
      assert.equal(await readFile(cleanupPath, "utf8"), "cleaned");
      await waitForProcessExit(activePid);
    } finally {
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      killIfAlive(activePid);
      await rm(root, { force: true, recursive: true });
    }
  }
});
