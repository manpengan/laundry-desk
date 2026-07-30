import { pathToFileURL } from "node:url";

import {
  createDataToolDependencies,
  dataToolErrorCode,
  LocalDataError,
  prepareLocalDataContext,
} from "./data-tools.mjs";
import { createDisasterRecoveryBackup } from "./disaster-recovery.mjs";
import {
  listRecoverySets,
  rotateRecoverySets,
  updateMaintenanceState,
  withMaintenanceLock,
} from "./maintenance-state.mjs";
import {
  composeStopCommand,
  composeUpCommand,
  createSpawnRunner,
  unwrapPackageManagerArguments,
} from "./compose.mjs";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BACKUPS = 30;

function positiveInteger(value, code) {
  if (typeof value !== "string" || !/^[1-9]\d{0,3}$/u.test(value)) {
    throw new LocalDataError(code);
  }
  return Number(value);
}

export function parseMaintenanceArguments(argv) {
  const args = unwrapPackageManagerArguments(argv);
  let applyRetention = false;
  let retentionDays = DEFAULT_RETENTION_DAYS;
  let maxBackups = DEFAULT_MAX_BACKUPS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply-retention") {
      applyRetention = true;
    } else if (argument === "--retention-days") {
      retentionDays = positiveInteger(args[index + 1], "LOCAL_MAINTENANCE_ARGS_INVALID");
      index += 1;
    } else if (argument === "--max-backups") {
      maxBackups = positiveInteger(args[index + 1], "LOCAL_MAINTENANCE_ARGS_INVALID");
      index += 1;
    } else {
      throw new LocalDataError("LOCAL_MAINTENANCE_ARGS_INVALID");
    }
  }
  return Object.freeze({ applyRetention, retentionDays, maxBackups });
}

const defaultDependencies = () =>
  Object.freeze({
    ...createDataToolDependencies(),
    prepareLocalDataContext,
    createDisasterRecoveryBackup,
    run: createSpawnRunner(),
    listRecoverySets,
    rotateRecoverySets,
    updateMaintenanceState,
    withMaintenanceLock,
  });

export async function runMaintenance(options, dependencies = defaultDependencies()) {
  const parsed = parseMaintenanceArguments(options.argv);
  const context = await dependencies.prepareLocalDataContext(options, dependencies);
  return dependencies.withMaintenanceLock(context.backupDirectory, "backup", async () => {
    const commandOptions = Object.freeze({ cwd: options.cwd, env: context.env });
    try {
      await dependencies.run(
        composeStopCommand("server", { project: context.project }),
        commandOptions,
      );
      let backup;
      try {
        backup = await dependencies.createDisasterRecoveryBackup(
          context,
          { cwd: options.cwd, kind: "backup" },
          dependencies,
        );
      } finally {
        await dependencies.run(
          composeUpCommand("server", { project: context.project }),
          commandOptions,
        );
      }
      const sets = await dependencies.listRecoverySets(context);
      const rotation = await dependencies.rotateRecoverySets(context, sets, {
        apply: parsed.applyRetention,
        retentionDays: parsed.retentionDays,
        maxBackups: parsed.maxBackups,
        now: dependencies.now(),
      });
      const completedAt = dependencies.now().toISOString();
      await dependencies.updateMaintenanceState(context.backupDirectory, {
        last_backup: {
          status: "ok",
          completed_at: completedAt,
          file: backup.path.split("/").at(-1),
          sha256: backup.sha256,
        },
        last_failure: null,
      });
      const result = Object.freeze({ backup, rotation, completed_at: completedAt });
      options.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result;
    } catch (error) {
      await dependencies
        .updateMaintenanceState(context.backupDirectory, {
          last_failure: {
            operation: "backup",
            code: dataToolErrorCode(error, "LOCAL_MAINTENANCE_FAILED"),
            failed_at: dependencies.now().toISOString(),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  });
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runMaintenance({
    argv: Object.freeze(process.argv.slice(2)),
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
  }).catch((error) => {
    process.stderr.write(`${dataToolErrorCode(error, "LOCAL_MAINTENANCE_FAILED")}\n`);
    process.exitCode = 1;
  });
}
