import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { _electron as electron } from "@playwright/test";

import {
  SOFTWARE_ONLY_MARKER,
  RuntimeCounterAcceptanceError,
  assertOwnedTemporaryRoot,
  assertSecretsNotExposed,
  createAcceptanceIdentity,
  createRuntimeArguments,
  fail,
  resolveLocalDockerEndpoint,
  selectHostEnvironment,
  stableFailure,
} from "./runtime-counter-loopback-core.mjs";
import {
  buildAcceptanceArtifacts,
  firstExecutable,
} from "./runtime-counter-loopback-artifacts.mjs";
import { createDockerOperations } from "./runtime-counter-loopback-docker.mjs";
import {
  closeCounterApplication,
  firstCounterWindow,
  launchCounterApplication,
} from "./runtime-counter-loopback-electron.mjs";
import {
  assertFixedPortsAvailable,
  assertStagedHealth,
  waitForRuntimeReady,
  waitForRuntimeStopped,
  windowHealth,
} from "./runtime-counter-loopback-probes.mjs";
import {
  BUILD_COMMAND_TIMEOUT_MS,
  runBoundedCommand,
  runWithProcessSignalCancellation,
} from "./runtime-counter-loopback-process.mjs";
import {
  acquireRuntimeCounterLease,
  assertExactRuntimeResult,
  generateRuntimeSetup,
  loadRuntimeInstanceId,
  optionalRuntimeInstanceId,
} from "./runtime-counter-loopback-runtime.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const kitRoot = join(repositoryRoot, "tools/runtime-kit");
const acceptanceLeasePath = "/private/tmp/laundry-runtime-counter-loopback.acceptance.lock";
const dockerCandidates = Object.freeze([
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
]);
const pnpmCandidates = Object.freeze([
  "/opt/homebrew/bin/pnpm",
  "/usr/local/bin/pnpm",
  "/usr/bin/pnpm",
]);

async function prepareAcceptanceContext(identity) {
  const temporaryBase = await realpath(tmpdir());
  const createdRoot = await mkdtemp(join(temporaryBase, "laundry-runtime-counter-"));
  const ownedRoot = assertOwnedTemporaryRoot(temporaryBase, resolve(createdRoot));
  try {
    const temporaryRoot = assertOwnedTemporaryRoot(temporaryBase, await realpath(ownedRoot));
    const counterHome = join(temporaryRoot, "counter-home");
    const runtimeAppOutputRoot = join(temporaryRoot, "runtime-app");
    const userDataRoot = join(temporaryRoot, "counter-user-data");
    await mkdir(counterHome, { mode: 0o700 });
    await mkdir(runtimeAppOutputRoot, { mode: 0o700 });
    await mkdir(userDataRoot, { mode: 0o700 });
    const setup = generateRuntimeSetup(identity.runtimeId);
    const secrets = Object.freeze([
      setup.adminPassword,
      setup.adminPin,
      setup.approverPassword,
      setup.approverPin,
    ]);
    return Object.freeze({
      baseEnvironment: selectHostEnvironment(process.env, { TMPDIR: temporaryRoot }),
      configRoot: join(temporaryRoot, "runtime"),
      counterEnvironment: selectHostEnvironment(process.env, {
        HOME: counterHome,
        TMPDIR: temporaryRoot,
      }),
      secrets,
      setup,
      runtimeAppOutputRoot,
      signingKeyPath: join(temporaryRoot, "runtime-test-signing-private.pem"),
      temporaryRoot,
      userDataRoot,
    });
  } catch (error) {
    try {
      await chmod(ownedRoot, 0o700);
      await rm(ownedRoot, { force: true, recursive: true });
    } catch {
      fail("RUNTIME_COUNTER_TEMP_SETUP_CLEANUP_FAILED");
    }
    throw error;
  }
}

export async function runRuntimeCounterAcceptance(options = {}) {
  if (process.argv.length !== 2 || process.platform !== "darwin") {
    fail("RUNTIME_COUNTER_ACCEPTANCE_PLATFORM_INVALID");
  }
  await runRuntimeCounterAcceptanceLifecycle(options);
}

export async function runRuntimeCounterAcceptanceLifecycle(options = {}, dependencies = {}) {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    fail("RUNTIME_COUNTER_ACCEPTANCE_OPTIONS_INVALID");
  }
  const acceptanceScenario = dependencies.acceptanceScenario ?? null;
  const leasePath = dependencies.leasePath ?? acceptanceLeasePath;
  if (
    Reflect.ownKeys(dependencies).some(
      (key) => key !== "acceptanceScenario" && key !== "leasePath",
    ) ||
    (acceptanceScenario !== null && typeof acceptanceScenario !== "function") ||
    typeof leasePath !== "string"
  ) {
    fail("RUNTIME_COUNTER_ACCEPTANCE_OPTIONS_INVALID");
  }
  const identity = createAcceptanceIdentity(randomBytes(6).toString("hex"));
  let acceptanceLease = null;
  let context = null;
  let artifacts = null;
  let application = null;
  let electronMonitor = null;
  let instanceId = null;
  let dockerClaimed = false;
  let dockerOperations = null;
  let primaryFailure = null;
  let cleanupFailure = null;
  let cleaningUp = false;

  const run = async (file, arguments_, commandOptions = {}) => {
    if (context === null) fail("RUNTIME_COUNTER_CONTEXT_INVALID");
    const environment = commandOptions.environment ?? context.baseEnvironment;
    assertSecretsNotExposed({ file, arguments: arguments_, environment }, context.secrets);
    try {
      const result = await runBoundedCommand(file, arguments_, {
        ...commandOptions,
        cwd: commandOptions.cwd ?? repositoryRoot,
        environment,
        signal: cleaningUp ? undefined : options.signal,
      });
      assertSecretsNotExposed({ stdout: result.stdout, stderr: result.stderr }, context.secrets);
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (/^[A-Z][A-Z0-9_]{1,127}$/u.test(code)) {
        throw new RuntimeCounterAcceptanceError(code);
      }
      throw error;
    }
  };

  const cleanupStep = async (operation, fallback) => {
    try {
      await operation();
    } catch (error) {
      cleanupFailure ??= stableFailure(error, fallback);
    }
  };

  try {
    if (options.signal?.aborted) fail("RUNTIME_COUNTER_ACCEPTANCE_INTERRUPTED");
    acceptanceLease = await acquireRuntimeCounterLease(leasePath);
    if (options.signal?.aborted) fail("RUNTIME_COUNTER_ACCEPTANCE_INTERRUPTED");
    context = await prepareAcceptanceContext(identity);
    if (options.signal?.aborted) fail("RUNTIME_COUNTER_ACCEPTANCE_INTERRUPTED");
    if (acceptanceScenario !== null) {
      await acceptanceScenario(Object.freeze({ run, temporaryRoot: context.temporaryRoot }));
    }
    if (acceptanceScenario === null) {
      const dockerEndpoint = await resolveLocalDockerEndpoint();
      const docker = await firstExecutable(dockerCandidates, "RUNTIME_COUNTER_DOCKER_UNAVAILABLE");
      const pnpm = await firstExecutable(pnpmCandidates, "RUNTIME_COUNTER_PNPM_UNAVAILABLE");
      dockerOperations = createDockerOperations({
        docker,
        endpoint: dockerEndpoint,
        environment: context.baseEnvironment,
        identity,
        run,
      });
      await assertFixedPortsAvailable();
      await dockerOperations.assertVacant();
      dockerClaimed = true;
      artifacts = await buildAcceptanceArtifacts({
        identity,
        kitRoot,
        pnpm,
        repositoryRoot,
        report: (phase) => process.stdout.write(`runtime-counter: ${phase}\n`),
        run,
        runDocker: dockerOperations.execute,
        runtimeAppOutputRoot: context.runtimeAppOutputRoot,
        signingKeyPath: context.signingKeyPath,
        temporaryRoot: context.temporaryRoot,
      });
      const runtimeRun = async (command, input = "") =>
        run(
          artifacts.runtimeExecutable,
          createRuntimeArguments(identity, context.configRoot, identity.imageTag, command),
          {
            input,
            label: "RUNTIME_COUNTER_RUNTIME_CLI",
            timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
          },
        );

      await assertFixedPortsAvailable();
      process.stdout.write("runtime-counter: install\n");
      let result = await runtimeRun(
        ["install", "--manifest", artifacts.manifestPath],
        JSON.stringify(context.setup),
      );
      assertExactRuntimeResult(result, "ready", artifacts.release);
      instanceId = await loadRuntimeInstanceId(context.configRoot, identity, artifacts.release);
      await waitForRuntimeReady(options.signal);
      await dockerOperations.assertRuntimeOwnership(instanceId);
      await assertStagedHealth(
        { executable: artifacts.counter.executable, environment: context.counterEnvironment, run },
        true,
      );

      const launched = await launchCounterApplication(electron, {
        environment: context.counterEnvironment,
        executable: artifacts.counter.executable,
        secrets: context.secrets,
        userDataRoot: context.userDataRoot,
      });
      application = launched.application;
      electronMonitor = launched.monitor;
      const page = await firstCounterWindow(application);
      await windowHealth(page, true, options.signal);

      process.stdout.write("runtime-counter: stop-start-restart\n");
      result = await runtimeRun(["stop"]);
      assertExactRuntimeResult(result, "stopped", artifacts.release);
      await waitForRuntimeStopped(options.signal);
      await assertStagedHealth(
        { executable: artifacts.counter.executable, environment: context.counterEnvironment, run },
        false,
      );
      await windowHealth(page, false, options.signal);

      result = await runtimeRun(["start"]);
      assertExactRuntimeResult(result, "ready", artifacts.release);
      await waitForRuntimeReady(options.signal);
      await windowHealth(page, true, options.signal);

      result = await runtimeRun(["restart"]);
      assertExactRuntimeResult(result, "ready", artifacts.release);
      await waitForRuntimeReady(options.signal);
      await dockerOperations.assertRuntimeOwnership(instanceId);
      await assertStagedHealth(
        { executable: artifacts.counter.executable, environment: context.counterEnvironment, run },
        true,
      );
      await windowHealth(page, true, options.signal);
    }
  } catch (error) {
    primaryFailure = stableFailure(error);
  } finally {
    cleaningUp = true;
    await cleanupStep(
      () => closeCounterApplication(application),
      "RUNTIME_COUNTER_ELECTRON_CLEANUP_FAILED",
    );
    await cleanupStep(
      async () => electronMonitor?.assertValid(),
      "RUNTIME_COUNTER_ELECTRON_OUTPUT_INVALID",
    );
    if (artifacts !== null) {
      await cleanupStep(async () => {
        await run(
          artifacts.runtimeExecutable,
          createRuntimeArguments(identity, context.configRoot, identity.imageTag, ["stop"]),
          {
            accepting: [0, 1],
            label: "RUNTIME_COUNTER_FINAL_STOP",
            timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
          },
        );
      }, "RUNTIME_COUNTER_FINAL_STOP_FAILED");
      await cleanupStep(async () => {
        instanceId ??= await optionalRuntimeInstanceId(
          context.configRoot,
          identity,
          artifacts.release,
        );
      }, "RUNTIME_COUNTER_STATE_CLEANUP_FAILED");
    }
    if (dockerClaimed && dockerOperations !== null) {
      await cleanupStep(
        () =>
          dockerOperations.cleanup({
            imageId: artifacts?.imageId ?? null,
            instanceId,
          }),
        "RUNTIME_COUNTER_DOCKER_CLEANUP_FAILED",
      );
    }
    if (context !== null) {
      await cleanupStep(async () => {
        await chmod(context.temporaryRoot, 0o700).catch(() => undefined);
        await rm(context.temporaryRoot, { force: true, recursive: true });
        try {
          await stat(context.temporaryRoot);
          fail("RUNTIME_COUNTER_TEMP_CLEANUP_INCOMPLETE");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
      }, "RUNTIME_COUNTER_TEMP_CLEANUP_FAILED");
    }
    if (acceptanceLease !== null) {
      await cleanupStep(() => acceptanceLease.release(), "RUNTIME_COUNTER_LEASE_CLEANUP_FAILED");
    }
  }
  if (primaryFailure !== null && cleanupFailure !== null) {
    fail("RUNTIME_COUNTER_FAILED_WITH_CLEANUP_FAILURE");
  }
  if (primaryFailure !== null) throw primaryFailure;
  if (cleanupFailure !== null) throw cleanupFailure;
  process.stdout.write(`${SOFTWARE_ONLY_MARKER}\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  runWithProcessSignalCancellation((signal) => runRuntimeCounterAcceptance({ signal })).catch(
    (error) => {
      process.stderr.write(`${stableFailure(error).code}\n`);
      process.exitCode = 1;
    },
  );
}
