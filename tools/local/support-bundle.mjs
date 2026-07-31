import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectDiagnostics,
  collectMigrations,
  collectProduct,
  collectServerLogs,
  collectServices,
} from "./support-bundle-collectors.mjs";
import { collectCups, collectEdgeQueue, collectUpdateState } from "./support-bundle-edge.mjs";
import { createExecFileCaptureRunner, unwrapPackageManagerArguments } from "./compose.mjs";
import { resolveLocalConfigPaths } from "./config.mjs";
import { runDiagnose } from "./diagnose.mjs";
import { probeHealthEndpoint } from "./health-probe.mjs";
import {
  installSupportBundle,
  redactSupportValue,
  SupportBundleError,
} from "./support-bundle-safety.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const EDGE_PACKAGE_ROOT = join(REPOSITORY_ROOT, "apps", "edge-agent");
const MIGRATION_ROOT = join(REPOSITORY_ROOT, "packages", "db", "src", "migrations");
const SECTION_NAMES = Object.freeze([
  "product",
  "diagnostics",
  "services",
  "migrations",
  "server_logs",
  "edge_queue",
  "cups",
  "update_state",
]);

export const SUPPORT_BUNDLE_MANIFEST = Object.freeze({
  format: "laundry-desk-support-bundle",
  sections: SECTION_NAMES,
});

export function parseSupportBundleArguments(argv) {
  if (unwrapPackageManagerArguments(argv).length !== 0) {
    throw new SupportBundleError("LOCAL_SUPPORT_ARGS_INVALID");
  }
}

export function resolveEdgeUserDataPath({ platform = process.platform, homeDir = homedir() } = {}) {
  if (typeof homeDir !== "string" || !homeDir.startsWith("/")) {
    throw new SupportBundleError("LOCAL_SUPPORT_USER_DATA_INVALID");
  }
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "laundry-desk V2");
  }
  if (platform === "linux") {
    return join(homeDir, ".config", "laundry-desk V2");
  }
  throw new SupportBundleError("LOCAL_SUPPORT_PLATFORM_UNSUPPORTED");
}

const defaultDependencies = () =>
  Object.freeze({
    resolveLocalConfigPaths,
    resolveEdgeUserDataPath,
    runDiagnose,
    probeHealthEndpoint,
    capture: createExecFileCaptureRunner(),
    repositoryRoot: REPOSITORY_ROOT,
    edgePackageRoot: EDGE_PACKAGE_ROOT,
    migrationRoot: MIGRATION_ROOT,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    homeDir: homedir(),
    now: () => new Date(),
    randomBytes,
  });

function createContext(options, dependencies) {
  const configPaths = dependencies.resolveLocalConfigPaths({
    env: options.env,
    platform: dependencies.platform,
    homeDir: dependencies.homeDir,
  });
  const edgeUserDataRoot = dependencies.resolveEdgeUserDataPath({
    platform: dependencies.platform,
    homeDir: dependencies.homeDir,
  });
  const redactionRoots = Object.freeze([
    dependencies.homeDir,
    configPaths.directoryPath,
    edgeUserDataRoot,
    dependencies.repositoryRoot,
    options.cwd,
  ]);
  return Object.freeze({
    env: options.env,
    cwd: options.cwd,
    configDirectory: configPaths.directoryPath,
    repositoryRoot: dependencies.repositoryRoot,
    edgePackageRoot: dependencies.edgePackageRoot,
    migrationRoot: dependencies.migrationRoot,
    edgeUserDataRoot,
    edgeStateRoot: join(edgeUserDataRoot, "edge-state"),
    updateRoot: join(edgeUserDataRoot, "updates"),
    redactionRoots,
    nodeVersion: dependencies.nodeVersion,
    platform: dependencies.platform,
    arch: dependencies.arch,
    runDiagnose: dependencies.runDiagnose,
    probeHealthEndpoint: dependencies.probeHealthEndpoint,
    capture: dependencies.capture,
  });
}

async function collectSections(context) {
  const [product, diagnostics, services, migrations, serverLogs, edgeQueue, cups, updateState] =
    await Promise.all([
      collectProduct(context),
      collectDiagnostics(context),
      collectServices(context),
      collectMigrations(context),
      collectServerLogs(context),
      collectEdgeQueue(context),
      collectCups(context),
      collectUpdateState(context),
    ]);
  return Object.freeze({
    product,
    diagnostics,
    services,
    migrations,
    server_logs: serverLogs,
    edge_queue: edgeQueue,
    cups,
    update_state: updateState,
  });
}

function serializeBundle(bundle, redactionRoots) {
  const redacted = redactSupportValue(bundle, redactionRoots);
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  try {
    const parsed = JSON.parse(serialized);
    if (
      parsed.version !== 1 ||
      JSON.stringify(parsed.manifest) !== JSON.stringify(SUPPORT_BUNDLE_MANIFEST) ||
      Object.keys(parsed.sections).join(",") !== SECTION_NAMES.join(",")
    ) {
      throw new Error("invalid bundle shape");
    }
  } catch (error) {
    throw new SupportBundleError("LOCAL_SUPPORT_BUNDLE_INVALID", { cause: error });
  }
  return Buffer.from(serialized, "utf8");
}

export async function runSupportBundle(options, overrides = Object.freeze({})) {
  parseSupportBundleArguments(options.argv);
  const dependencies = Object.freeze({ ...defaultDependencies(), ...overrides });
  const context = createContext(options, dependencies);
  const generatedAt = dependencies.now();
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new SupportBundleError("LOCAL_SUPPORT_CLOCK_INVALID");
  }
  const bundle = Object.freeze({
    version: 1,
    manifest: SUPPORT_BUNDLE_MANIFEST,
    generated_at: generatedAt.toISOString(),
    sections: await collectSections(context),
  });
  const bytes = serializeBundle(bundle, context.redactionRoots);
  const result = await installSupportBundle(context.configDirectory, bytes, {
    now: () => generatedAt,
    randomBytes: dependencies.randomBytes,
  });
  options.stdout(
    `Support bundle: ${result.path}\nSHA-256: ${result.sha256}\nBytes: ${result.bytes}\n`,
  );
  return result;
}

export const supportBundleErrorCode = (error) =>
  error instanceof SupportBundleError ? error.code : "LOCAL_SUPPORT_BUNDLE_FAILED";

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runSupportBundle({
    argv: Object.freeze(process.argv.slice(2)),
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
  }).catch((error) => {
    process.stderr.write(`${supportBundleErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
