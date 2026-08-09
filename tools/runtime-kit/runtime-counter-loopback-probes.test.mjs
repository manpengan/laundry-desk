import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import test from "node:test";

import {
  assertStagedHealth,
  healthState,
  monitorElectronOutput,
  waitForRuntimeReady,
  windowHealth,
} from "./runtime-counter-loopback-probes.mjs";

function fakeApplication() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return Object.freeze({
    application: Object.freeze({ process: () => ({ stdout, stderr }) }),
    stderr,
    stdout,
  });
}

test("staged health accepts exact ready and unavailable process results", async () => {
  const invocations = [];
  const stagedUserDataRoots = [];
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "runtime-counter-probes-test-"),
  );
  try {
    for (const [expectedReady, result] of [
      [true, { code: 0, stdout: '{"ok":true}\n', stderr: "" }],
      [false, { code: 1, stdout: '{"ok":false}\n', stderr: "" }],
    ]) {
      await assertStagedHealth(
        {
          executable: "/tmp/Counter",
          environment: { PATH: "/usr/bin", TMPDIR: temporaryRoot },
          userDataRoot: "/tmp/counter-user-data",
          run: async (...values) => {
            invocations.push(values);
            const userDataArgument = values[1][1];
            const stagedUserDataRoot = userDataArgument.slice("--user-data-dir=".length);
            stagedUserDataRoots.push(stagedUserDataRoot);
            assert.equal(isAbsolute(stagedUserDataRoot), true);
            assert.equal(stagedUserDataRoot.startsWith(`${temporaryRoot}${sep}`), true);
            assert.notEqual(stagedUserDataRoot, "/tmp/counter-user-data");
            assert.equal((await stat(stagedUserDataRoot)).mode & 0o777, 0o700);
            return result;
          },
        },
        expectedReady,
      );
    }
    assert.deepEqual(
      invocations.map((values) => values[1]),
      stagedUserDataRoots.map((stagedUserDataRoot) => [
        "--laundry-staged-health-check",
        `--user-data-dir=${stagedUserDataRoot}`,
        "--use-mock-keychain",
      ]),
    );
    assert.equal(new Set(stagedUserDataRoots).size, stagedUserDataRoots.length);
    for (const stagedUserDataRoot of stagedUserDataRoots) {
      await assert.rejects(() => stat(stagedUserDataRoot), { code: "ENOENT" });
    }
    await assert.rejects(
      () =>
        assertStagedHealth(
          {
            executable: "/tmp/Counter",
            environment: { TMPDIR: temporaryRoot },
            run: async () => ({ code: 0, stdout: '{"ok":true}\n', stderr: "warning" }),
          },
          true,
        ),
      /RUNTIME_COUNTER_STAGED_HEALTH_INVALID/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("staged health rejects missing, relative, NUL, and non-canonical TMPDIR values", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "runtime-counter-probes-tmpdir-test-"),
  );
  let invocations = 0;
  try {
    for (const environment of [
      {},
      { TMPDIR: "relative" },
      { TMPDIR: `${temporaryRoot}\0suffix` },
      { TMPDIR: `${temporaryRoot}${sep}.` },
    ]) {
      await assert.rejects(
        () =>
          assertStagedHealth(
            {
              executable: "/tmp/Counter",
              environment,
              run: async () => {
                invocations += 1;
                return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
              },
            },
            true,
          ),
        /RUNTIME_COUNTER_STAGED_HEALTH_TMPDIR_INVALID/u,
      );
    }
    assert.equal(invocations, 0);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("staged health fails closed when its isolated user data cannot be cleaned up", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "runtime-counter-probes-cleanup-test-"),
  );
  let displacedUserDataRoot;
  try {
    await assert.rejects(
      () =>
        assertStagedHealth(
          {
            executable: "/tmp/Counter",
            environment: { TMPDIR: temporaryRoot },
            run: async (_executable, arguments_) => {
              const stagedUserDataRoot = arguments_[1].slice("--user-data-dir=".length);
              displacedUserDataRoot = `${stagedUserDataRoot}-displaced`;
              await rename(stagedUserDataRoot, displacedUserDataRoot);
              return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
            },
          },
          true,
        ),
      /RUNTIME_COUNTER_STAGED_HEALTH_CLEANUP_FAILED/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("normal Electron window calls the raw laundryDesktop health bridge", async () => {
  let evaluations = 0;
  const page = {
    evaluate: async (operation) => {
      evaluations += 1;
      assert.equal(typeof operation, "function");
      return { ok: true, data: { status: "ready" } };
    },
  };
  await windowHealth(page, true);
  page.evaluate = async () => ({
    ok: false,
    error: { code: "RESOURCE_UNAVAILABLE", message: "local service unavailable" },
  });
  await windowHealth(page, false);
  assert.equal(evaluations, 1);
});

test("runtime-ready health polling aborts immediately with the stable acceptance code", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let fetchStarted;
  const fetchStartedPromise = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  try {
    globalThis.fetch = async (_url, options) => {
      fetchStarted();
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    };
    const readiness = waitForRuntimeReady(controller.signal);
    await fetchStartedPromise;
    controller.abort(new Error("test interruption"));
    await assert.rejects(readiness, /RUNTIME_COUNTER_ACCEPTANCE_INTERRUPTED/u);
    await assert.rejects(
      () => healthState(controller.signal),
      /RUNTIME_COUNTER_ACCEPTANCE_INTERRUPTED/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hung Electron health evaluation aborts without waiting for the page promise", async () => {
  const controller = new AbortController();
  let evaluationStarted;
  const evaluationStartedPromise = new Promise((resolve) => {
    evaluationStarted = resolve;
  });
  const page = {
    evaluate: async () => {
      evaluationStarted();
      return await new Promise(() => undefined);
    },
  };
  const health = windowHealth(page, true, controller.signal);
  await evaluationStartedPromise;
  controller.abort(new Error("test interruption"));
  await assert.rejects(health, /RUNTIME_COUNTER_ACCEPTANCE_INTERRUPTED/u);
});

test("hung Electron health evaluation fails at its bounded deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const page = {
    evaluate: async () => await new Promise(() => undefined),
  };
  const health = windowHealth(page, true);
  context.mock.timers.tick(10_000);
  await assert.rejects(health, /RUNTIME_COUNTER_WINDOW_HEALTH_TIMEOUT/u);
});

test("Electron output capture is bounded and rejects setup-secret canaries", () => {
  const safe = fakeApplication();
  const safeMonitor = monitorElectronOutput(safe.application, ["stdin-secret"]);
  safe.stdout.emit("data", Buffer.from("safe output"));
  safeMonitor.assertValid();

  const exposed = fakeApplication();
  const exposedMonitor = monitorElectronOutput(exposed.application, ["stdin-secret"]);
  exposed.stderr.emit("data", Buffer.from("leaked stdin-secret"));
  assert.throws(() => exposedMonitor.assertValid(), /RUNTIME_COUNTER_SECRET_EXPOSED/u);

  const excessive = fakeApplication();
  const excessiveMonitor = monitorElectronOutput(excessive.application, ["stdin-secret"]);
  excessive.stdout.emit("data", Buffer.alloc(65_537));
  assert.throws(() => excessiveMonitor.assertValid(), /RUNTIME_COUNTER_ELECTRON_OUTPUT_TOO_LARGE/u);
});
