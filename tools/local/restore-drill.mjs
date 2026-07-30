import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  createDataToolDependencies,
  dataToolErrorCode,
  LocalDataError,
  prepareLocalDataContext,
} from "./data-tools.mjs";
import { verifyDisasterRecoveryBackup } from "./disaster-recovery.mjs";
import {
  composeCommand,
  createExecFileCaptureRunner,
  createSpawnRunner,
  unwrapPackageManagerArguments,
} from "./compose.mjs";
import { updateMaintenanceState, withMaintenanceLock } from "./maintenance-state.mjs";

const DRILL_OK = "DRILL_OK";

export function parseRestoreDrillArguments(argv) {
  const args = unwrapPackageManagerArguments(argv);
  if (
    args.length !== 4 ||
    args[0] !== "--file" ||
    args[2] !== "--confirm-sha256" ||
    typeof args[1] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(args[3])
  ) {
    throw new LocalDataError("LOCAL_RESTORE_DRILL_ARGS_INVALID");
  }
  return Object.freeze({ file: args[1], sha256: args[3] });
}

function drillDatabaseName(randomId) {
  const suffix = randomId.replaceAll("-", "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/u.test(suffix)) throw new LocalDataError("LOCAL_RESTORE_DRILL_ID_INVALID");
  return `laundry_v2_drill_${suffix}`;
}

export const drillCreateCommand = (project, database) =>
  composeCommand(
    ["exec", "-T", "--user", "postgres", "postgres", "createdb", "--template=template0", database],
    { project },
  );

export const drillRestoreCommand = (project, database) =>
  composeCommand(
    [
      "exec",
      "-T",
      "--user",
      "postgres",
      "postgres",
      "pg_restore",
      `--dbname=${database}`,
      "--no-owner",
      "--exit-on-error",
      "--single-transaction",
    ],
    { project },
  );

export const drillValidateCommand = (project, database) =>
  composeCommand(
    [
      "exec",
      "-T",
      "--user",
      "postgres",
      "postgres",
      "psql",
      `--dbname=${database}`,
      "--tuples-only",
      "--no-align",
      "--command",
      "SELECT CASE WHEN to_regclass('public.orders') IS NOT NULL AND to_regclass('public.customers') IS NOT NULL AND EXISTS (SELECT 1 FROM laundry_schema_migrations WHERE filename = '0028_customer_privacy_lifecycle.sql') THEN 'DRILL_OK' ELSE 'DRILL_INVALID' END",
    ],
    { project },
  );

export const drillDropCommand = (project, database) =>
  composeCommand(
    ["exec", "-T", "--user", "postgres", "postgres", "dropdb", "--if-exists", database],
    { project },
  );

const defaultDependencies = () =>
  Object.freeze({
    ...createDataToolDependencies(),
    prepareLocalDataContext,
    verifyBackup: verifyDisasterRecoveryBackup,
    open,
    run: createSpawnRunner(),
    capture: createExecFileCaptureRunner(),
    updateMaintenanceState,
    withMaintenanceLock,
  });

export async function runRestoreDrill(options, dependencies = defaultDependencies()) {
  const parsed = parseRestoreDrillArguments(options.argv);
  const context = await dependencies.prepareLocalDataContext(options, dependencies);
  return dependencies.withMaintenanceLock(context.backupDirectory, "restore-drill", async () => {
    const source = await dependencies.verifyBackup(context, parsed.file, parsed.sha256);
    const database = drillDatabaseName(dependencies.randomUUID());
    const commandOptions = Object.freeze({ cwd: options.cwd, env: context.env });
    let created = false;
    let failure;
    try {
      await dependencies.run(drillCreateCommand(context.project, database), commandOptions);
      created = true;
      const handle = await dependencies.open(
        source.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        await dependencies.stream(drillRestoreCommand(context.project, database), {
          ...commandOptions,
          inputFd: handle.fd,
        });
      } finally {
        await handle.close();
      }
      const validation = (
        await dependencies.capture(drillValidateCommand(context.project, database), commandOptions)
      ).trim();
      if (validation !== DRILL_OK)
        throw new LocalDataError("LOCAL_RESTORE_DRILL_VALIDATION_FAILED");
    } catch (error) {
      failure = error;
    } finally {
      if (created) {
        try {
          await dependencies.run(drillDropCommand(context.project, database), commandOptions);
        } catch (cleanupError) {
          failure =
            failure === undefined
              ? cleanupError
              : new AggregateError(
                  [failure, cleanupError],
                  "restore drill and shadow database cleanup both failed",
                );
        }
      }
    }
    if (failure !== undefined) {
      await dependencies
        .updateMaintenanceState(context.backupDirectory, {
          last_failure: {
            operation: "restore-drill",
            code: dataToolErrorCode(failure, "LOCAL_RESTORE_DRILL_FAILED"),
            failed_at: dependencies.now().toISOString(),
          },
        })
        .catch(() => undefined);
      throw failure;
    }
    const completedAt = dependencies.now().toISOString();
    await dependencies.updateMaintenanceState(context.backupDirectory, {
      last_drill: {
        status: "ok",
        completed_at: completedAt,
        file: source.path.split("/").at(-1),
      },
      last_failure: null,
    });
    const result = Object.freeze({ status: "ok", completed_at: completedAt });
    options.stdout(`${JSON.stringify(result)}\n`);
    return result;
  });
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runRestoreDrill({
    argv: Object.freeze(process.argv.slice(2)),
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
  }).catch((error) => {
    process.stderr.write(`${dataToolErrorCode(error, "LOCAL_RESTORE_DRILL_FAILED")}\n`);
    process.exitCode = 1;
  });
}
