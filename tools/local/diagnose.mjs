import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  composeCommand,
  createExecFileCaptureRunner,
  resolveComposeProject,
  unwrapPackageManagerArguments,
} from "./compose.mjs";
import { loadLocalConfig, resolveLocalConfigPaths, toLocalConfigEnvironment } from "./config.mjs";
import { probeHealthEndpoint } from "./health-probe.mjs";
import { dataToolErrorCode, LocalDataError } from "./data-tools.mjs";
import { inspectMaintenanceHealth } from "./maintenance-state.mjs";

export const parseDiagnoseArguments = (argv) => {
  if (unwrapPackageManagerArguments(argv).length !== 0) {
    throw new LocalDataError("LOCAL_DIAGNOSE_ARGS_INVALID");
  }
};

const defaultDependencies = () =>
  Object.freeze({
    loadLocalConfig,
    resolveLocalConfigPaths,
    toLocalConfigEnvironment,
    capture: createExecFileCaptureRunner(),
    probeHealthEndpoint,
    statfs,
    inspectMaintenanceHealth,
    now: () => new Date(),
  });

async function directorySummary(path) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null) return Object.freeze({ exists: false, entries: 0 });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return Object.freeze({ exists: true, valid: false, entries: 0 });
  }
  const entries = await readdir(path).catch(() => []);
  return Object.freeze({
    exists: true,
    valid: (metadata.mode & 0o7777) === 0o700,
    entries: entries.length,
  });
}

export async function runDiagnose(options, dependencies = defaultDependencies()) {
  parseDiagnoseArguments(options.argv);
  const project = resolveComposeProject(options.env);
  const config = await dependencies.loadLocalConfig({ env: options.env });
  const paths = dependencies.resolveLocalConfigPaths({ env: options.env });
  const env = Object.freeze({
    ...options.env,
    ...dependencies.toLocalConfigEnvironment(config),
  });
  let composeServices = null;
  try {
    composeServices = await dependencies.capture(
      composeCommand(["ps", "--format", "json"], { project }),
      { cwd: options.cwd, env },
    );
  } catch {
    composeServices = null;
  }
  const health = await dependencies.probeHealthEndpoint("http://127.0.0.1:8787/health");
  const filesystem = await dependencies.statfs(paths.directoryPath);
  const maintenance = await dependencies.inspectMaintenanceHealth(
    join(paths.directoryPath, "backups"),
    { now: dependencies.now(), maxAgeSeconds: 26 * 60 * 60 },
  );
  const report = Object.freeze({
    ok: health.ready && composeServices !== null && maintenance.ok,
    project,
    config: Object.freeze({ valid: true, instance_id: config.instanceId }),
    api: Object.freeze({ reachable: health.reachable, ready: health.ready }),
    compose: Object.freeze({
      reachable: composeServices !== null,
      services_reported: composeServices?.trim().length > 0,
    }),
    storage: Object.freeze({
      free_bytes: filesystem.bavail * filesystem.bsize,
      photos: await directorySummary(join(paths.directoryPath, "photos")),
      backups: await directorySummary(join(paths.directoryPath, "backups")),
    }),
    maintenance,
  });
  options.stdout(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runDiagnose({
    argv: Object.freeze(process.argv.slice(2)),
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
  }).catch((error) => {
    process.stderr.write(`${dataToolErrorCode(error, "LOCAL_DIAGNOSE_FAILED")}\n`);
    process.exitCode = 1;
  });
}
