import { pathToFileURL } from "node:url";

import {
  createDataToolDependencies,
  dataToolErrorCode,
  LocalDataError,
  prepareLocalDataContext,
} from "./data-tools.mjs";
import { createDisasterRecoveryBackup } from "./disaster-recovery.mjs";
import {
  composeStopCommand,
  composeUpCommand,
  createSpawnRunner,
  unwrapPackageManagerArguments,
} from "./compose.mjs";

export const parseBackupArguments = (argv) => {
  if (unwrapPackageManagerArguments(argv).length !== 0) {
    throw new LocalDataError("LOCAL_BACKUP_ARGS_INVALID");
  }
};

const defaultDependencies = () =>
  Object.freeze({
    ...createDataToolDependencies(),
    createDisasterRecoveryBackup,
    run: createSpawnRunner(),
  });

export async function runBackup(options, dependencies = defaultDependencies()) {
  parseBackupArguments(options.argv);
  const context = await prepareLocalDataContext(options, dependencies);
  const commandOptions = Object.freeze({ cwd: options.cwd, env: context.env });
  await dependencies.run(
    composeStopCommand("server", { project: context.project }),
    commandOptions,
  );
  try {
    const backup = await dependencies.createDisasterRecoveryBackup(
      context,
      { cwd: options.cwd, kind: "backup" },
      dependencies,
    );
    options.stdout(
      `Recovery set: ${backup.path}\n` +
        `Confirm SHA-256: ${backup.sha256}\n` +
        `Database SHA-256: ${backup.database_sha256}\n` +
        `Photo files: ${backup.photo_files}\nBytes: ${backup.bytes}\n`,
    );
    return backup;
  } finally {
    await dependencies.run(
      composeUpCommand("server", { project: context.project }),
      commandOptions,
    );
  }
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runBackup({
    argv: Object.freeze(process.argv.slice(2)),
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
  }).catch((error) => {
    process.stderr.write(`${dataToolErrorCode(error, "LOCAL_BACKUP_FAILED")}\n`);
    process.exitCode = 1;
  });
}
