import { randomUUID as secureRandomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as compose from "./compose.mjs";
import {
  ACCEPTANCE_ADMIN_ENV_KEYS,
  findAcceptanceRecoverySet,
  loadAcceptanceSecretValues,
  runOnlineRecoveryAcceptance,
  runStoppedSupportAcceptance,
  validateSupportBundles,
} from "./acceptance-recovery.mjs";
import { loadLocalConfig } from "./config.mjs";
import { probeHealthEndpoint } from "./health-probe.mjs";
export { ACCEPTANCE_ADMIN_ENV_KEYS };
const FIXED_PORTS = Object.freeze([8543, 8787]);
const API_URL = "http://127.0.0.1:8787";
const HEALTH_URL = `${API_URL}/health`;
const WEB_URL = "http://127.0.0.1:5173";
const WAIT = Object.freeze({ timeoutMs: 90_000, intervalMs: 250 });
const FORBIDDEN_OVERRIDES = Object.freeze(
  "COMPOSE_PROJECT_NAME LAUNDRY_LOCAL_CONFIG_DIR LAUNDRY_MAC_USER_DATA_DIR LAUNDRY_MAC_APP_PATH".split(
    " ",
  ),
);
const PASSTHROUGH_ENV_KEYS = Object.freeze("PATH HOME TMPDIR LANG LC_ALL LC_CTYPE".split(" "));
export class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "AcceptanceError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new AcceptanceError(code);
};
const command = (...args) => Object.freeze({ file: "pnpm", args: Object.freeze(args) });
const COMMANDS = Object.freeze({
  upBootstrap: command("local:up", "--bootstrap"),
  browserE2e: command("local:web:e2e"),
  macBuild: command("local:mac:build"),
  printDispatch: Object.freeze({
    file: process.execPath,
    args: Object.freeze(["tools/local/print-dispatch-acceptance.mjs"]),
  }),
  down: command("local:down"),
  macE2e: command("local:mac:e2e"),
});
function requiredAdministratorEnvironment(environment) {
  const entries = ACCEPTANCE_ADMIN_ENV_KEYS.map((name) => {
    const value = environment[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      fail("ACCEPTANCE_BOOTSTRAP_ENV_INCOMPLETE");
    }
    return [name, value];
  });
  return Object.freeze(Object.fromEntries(entries));
}
function assertUncontrolledEnvironment(environment) {
  for (const name of FORBIDDEN_OVERRIDES) {
    if (environment[name] !== undefined) fail("ACCEPTANCE_ENV_OVERRIDE_FORBIDDEN");
  }
  const endpoints = [
    ["LAUNDRY_API_URL", API_URL],
    ["LAUNDRY_WEB_URL", WEB_URL],
  ];
  for (const [name, expected] of endpoints) {
    const value = environment[name];
    if (value !== undefined && value !== expected) {
      fail("ACCEPTANCE_ENDPOINT_OVERRIDE_INVALID");
    }
  }
}
function allowlistedHostEnvironment(environment) {
  return Object.fromEntries(
    PASSTHROUGH_ENV_KEYS.flatMap((name) => {
      const value = environment[name];
      return typeof value === "string" ? [[name, value]] : [];
    }),
  );
}
function acceptanceProject(randomUUID) {
  const value = randomUUID().replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(value)) fail("ACCEPTANCE_PROJECT_GENERATION_FAILED");
  return `laundry-acceptance-${value.slice(0, 24)}`;
}
function assertOwnedTemporaryRoot(cwd, temporaryBase, temporaryRoot) {
  if (!isAbsolute(temporaryBase) || !isAbsolute(temporaryRoot)) {
    fail("ACCEPTANCE_TEMP_ROOT_INVALID");
  }
  const canonicalBase = resolve(temporaryBase);
  const repositoryRoot = resolve(cwd);
  const candidate = resolve(temporaryRoot);
  const repositoryRelative = relative(repositoryRoot, candidate);
  if (
    dirname(candidate) !== canonicalBase ||
    !basename(candidate).startsWith("laundry-acceptance-") ||
    repositoryRelative === "" ||
    (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative))
  ) {
    fail("ACCEPTANCE_TEMP_ROOT_INVALID");
  }
  return candidate;
}
export async function waitForProbe(options) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((duration) => new Promise((done) => setTimeout(done, duration)));
  const startedAt = now();
  while (now() - startedAt < options.timeoutMs) {
    if (await options.probe()) return;
    await sleep(options.intervalMs);
  }
  options.diagnostic(`${options.label} timed out after ${options.timeoutMs}ms`);
  fail("ACCEPTANCE_WAIT_TIMEOUT");
}
export async function assertLoopbackPortAvailable(port) {
  await new Promise((resolveAvailable, rejectOccupied) => {
    const server = createServer();
    server.once("error", () => rejectOccupied(new AcceptanceError("ACCEPTANCE_PORT_OCCUPIED")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) rejectOccupied(new AcceptanceError("ACCEPTANCE_PORT_CHECK_FAILED"));
        else resolveAvailable();
      });
    });
  });
}
async function probeTcp(port) {
  return await new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (reachable) => {
      socket.destroy();
      resolveProbe(reachable);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
export async function findUniquePackagedApp(releaseRoot) {
  let outputDirectories;
  try {
    outputDirectories = (await readdir(releaseRoot, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && /^mac-[A-Za-z0-9._-]+$/u.test(entry.name),
    );
  } catch {
    fail("ACCEPTANCE_MAC_APP_NOT_UNIQUE");
  }
  const candidates = [];
  for (const output of outputDirectories) {
    const candidate = join(releaseRoot, output.name, "laundry-desk V2.app");
    try {
      const metadata = await lstat(candidate);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) candidates.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") fail("ACCEPTANCE_MAC_APP_NOT_UNIQUE");
    }
  }
  if (candidates.length !== 1) fail("ACCEPTANCE_MAC_APP_NOT_UNIQUE");
  return candidates[0];
}
function validateVolumeLabels({ labels, project, instanceId }) {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
    fail("ACCEPTANCE_VOLUME_LABELS_INVALID");
  }
  const expected = {
    [compose.LOCAL_VOLUME_LABEL_KEYS.managed]: "true",
    [compose.LOCAL_VOLUME_LABEL_KEYS.project]: project,
    [compose.LOCAL_VOLUME_LABEL_KEYS.instance]: instanceId,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (labels[name] !== value) fail("ACCEPTANCE_VOLUME_LABELS_INVALID");
  }
}
function sanitizedFailure(error, fallback) {
  return error instanceof AcceptanceError ? error : new AcceptanceError(fallback);
}
async function runStep(dependencies, code, commandSpec, cwd, env) {
  try {
    await dependencies.run(commandSpec, Object.freeze({ cwd, env }));
  } catch {
    fail(code);
  }
}
async function validateAcceptanceVolume(context, dependencies) {
  const volumeName = compose.postgresVolumeName(context.project);
  const labels = await dependencies.inspectVolumeLabels({
    volumeName,
    project: context.project,
    cwd: context.cwd,
    env: context.baseEnvironment,
  });
  validateVolumeLabels({
    labels,
    project: context.project,
    instanceId: context.instanceId,
  });
  return volumeName;
}
async function cleanup(context, dependencies) {
  let failure = null;
  let stopped = false;
  try {
    await runStep(
      dependencies,
      "ACCEPTANCE_FINAL_DOWN_FAILED",
      COMMANDS.down,
      context.cwd,
      context.baseEnvironment,
    );
    await dependencies.waitForHealth({ expected: "down" });
    stopped = true;
  } catch (error) {
    failure = sanitizedFailure(error, "ACCEPTANCE_FINAL_DOWN_FAILED");
  }
  if (stopped && context.instanceId === null) {
    try {
      context.instanceId = await dependencies.loadInstanceId({
        env: context.baseEnvironment,
      });
    } catch {
      failure ??= new AcceptanceError("ACCEPTANCE_INSTANCE_UNAVAILABLE");
    }
  }
  if (stopped && context.instanceId !== null) {
    try {
      const volumeName = await validateAcceptanceVolume(context, dependencies);
      await dependencies.removeVolume({
        volumeName,
        project: context.project,
        cwd: context.cwd,
        env: context.baseEnvironment,
      });
    } catch (error) {
      failure ??= sanitizedFailure(error, "ACCEPTANCE_VOLUME_CLEANUP_FAILED");
    }
  }
  try {
    await dependencies.removeTree(context.temporaryRoot);
  } catch {
    failure ??= new AcceptanceError("ACCEPTANCE_TEMP_CLEANUP_FAILED");
  }
  return failure;
}
function createDefaultDependencies(cwd) {
  const run = compose.createSpawnRunner();
  const capture = compose.createExecFileCaptureRunner();
  const diagnostic = (line) => process.stderr.write(`[local-acceptance] ${line}\n`);
  return Object.freeze({
    randomUUID: secureRandomUUID,
    checkPort: assertLoopbackPortAvailable,
    resolveTemporaryBase: () => realpath(tmpdir()),
    createTempRoot: (base) => mkdtemp(join(base, "laundry-acceptance-")),
    canonicalizePath: (path) => realpath(path),
    createDirectory: (path) => mkdir(path, { mode: 0o700 }),
    run,
    waitForPostgres: () =>
      waitForProbe({
        label: "PostgreSQL 127.0.0.1:8543",
        timeoutMs: WAIT.timeoutMs,
        intervalMs: WAIT.intervalMs,
        probe: () => probeTcp(8543),
        diagnostic,
      }),
    waitForHealth: ({ expected }) =>
      waitForProbe({
        label: `API health ${expected}`,
        timeoutMs: WAIT.timeoutMs,
        intervalMs: WAIT.intervalMs,
        probe: async () => {
          const state = await probeHealthEndpoint(HEALTH_URL);
          return expected === "up" ? state.ready : !state.reachable;
        },
        diagnostic,
      }),
    loadInstanceId: async ({ env }) => (await loadLocalConfig({ env })).instanceId,
    loadSecretValues: loadAcceptanceSecretValues,
    findRecoverySet: findAcceptanceRecoverySet,
    validateSupportBundles,
    findPackagedApp: () => findUniquePackagedApp(join(cwd, "apps", "edge-agent", "release")),
    inspectVolumeLabels: async ({ project, cwd: commandCwd, env }) => {
      const stdout = await capture(compose.volumeInspectLabelsCommand(project), {
        cwd: commandCwd,
        env,
      });
      try {
        return JSON.parse(stdout);
      } catch {
        fail("ACCEPTANCE_VOLUME_LABELS_INVALID");
      }
    },
    removeVolume: async ({ project, cwd: commandCwd, env }) => {
      await run(compose.volumeRemoveCommand(project), { cwd: commandCwd, env });
    },
    removeTree: (path) => rm(path, { recursive: true, force: true }),
  });
}
export async function runAcceptance(options, providedDependencies) {
  const environment = options.env;
  const credentials = requiredAdministratorEnvironment(environment);
  assertUncontrolledEnvironment(environment);
  const dependencies = providedDependencies ?? createDefaultDependencies(options.cwd);
  for (const port of FIXED_PORTS) {
    try {
      await dependencies.checkPort(port);
    } catch {
      fail("ACCEPTANCE_PORT_OCCUPIED");
    }
  }
  const project = acceptanceProject(dependencies.randomUUID);
  let temporaryRoot;
  try {
    const temporaryBase = await dependencies.resolveTemporaryBase();
    const createdRoot = await dependencies.createTempRoot(temporaryBase);
    const canonicalRoot = await dependencies.canonicalizePath(createdRoot);
    temporaryRoot = assertOwnedTemporaryRoot(options.cwd, temporaryBase, canonicalRoot);
  } catch (error) {
    throw sanitizedFailure(error, "ACCEPTANCE_TEMP_SETUP_FAILED");
  }
  const configDirectory = join(temporaryRoot, "config");
  const userDataDirectory = join(temporaryRoot, "user-data");
  try {
    await dependencies.createDirectory(userDataDirectory);
  } catch {
    try {
      await dependencies.removeTree(temporaryRoot);
    } catch {
      fail("ACCEPTANCE_TEMP_CLEANUP_FAILED");
    }
    fail("ACCEPTANCE_TEMP_SETUP_FAILED");
  }
  const baseEnvironment = Object.freeze({
    ...allowlistedHostEnvironment(environment),
    COMPOSE_PROJECT_NAME: project,
    LAUNDRY_LOCAL_CONFIG_DIR: configDirectory,
    LAUNDRY_MAC_USER_DATA_DIR: userDataDirectory,
    LAUNDRY_LOCAL_ORG_CODE: "local",
    LAUNDRY_LOCAL_STORE_CODE: "main",
    LAUNDRY_API_URL: API_URL,
    LAUNDRY_WEB_URL: WEB_URL,
  });
  const credentialEnvironment = Object.freeze({ ...baseEnvironment, ...credentials });
  const context = {
    cwd: options.cwd,
    project,
    temporaryRoot,
    configDirectory,
    baseEnvironment,
    instanceId: null,
  };
  const execute = (code, commandSpec, env) =>
    runStep(dependencies, code, commandSpec, options.cwd, env);
  let primaryFailure = null;
  try {
    await execute("ACCEPTANCE_BOOTSTRAP_UP_FAILED", COMMANDS.upBootstrap, credentialEnvironment);
    context.instanceId = await dependencies.loadInstanceId({ env: baseEnvironment });
    await dependencies.waitForPostgres();
    await dependencies.waitForHealth({ expected: "up" });
    await execute("ACCEPTANCE_BROWSER_E2E_FAILED", COMMANDS.browserE2e, credentialEnvironment);
    await execute("ACCEPTANCE_MAC_BUILD_FAILED", COMMANDS.macBuild, baseEnvironment);
    await execute("ACCEPTANCE_PRINT_FAILED", COMMANDS.printDispatch, credentialEnvironment);
    await runOnlineRecoveryAcceptance({ execute, dependencies, env: baseEnvironment });
    const appPath = await dependencies.findPackagedApp();
    await execute("ACCEPTANCE_DOWN_FAILED", COMMANDS.down, baseEnvironment);
    await dependencies.waitForHealth({ expected: "down" });
    await validateAcceptanceVolume(context, dependencies);
    await runStoppedSupportAcceptance(context, credentials, dependencies, execute);
    const macEnvironment = Object.freeze({
      ...credentialEnvironment,
      LAUNDRY_MAC_APP_PATH: appPath,
    });
    await execute("ACCEPTANCE_MAC_E2E_FAILED", COMMANDS.macE2e, macEnvironment);
  } catch (error) {
    primaryFailure = sanitizedFailure(error, "ACCEPTANCE_FAILED");
  }
  const cleanupFailure = await cleanup(context, dependencies);
  if (primaryFailure !== null && cleanupFailure !== null) {
    throw new AcceptanceError("ACCEPTANCE_FAILED_WITH_CLEANUP_FAILURE");
  }
  if (primaryFailure !== null) throw primaryFailure;
  if (cleanupFailure !== null) throw cleanupFailure;
}
const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};
if (isMainModule()) {
  void runAcceptance({ cwd: process.cwd(), env: process.env })
    .then(() => process.stdout.write("LOCAL_ACCEPTANCE_OK\n"))
    .catch((error) => {
      process.stderr.write(`${sanitizedFailure(error, "ACCEPTANCE_FAILED").code}\n`);
      process.exitCode = 1;
    });
}
