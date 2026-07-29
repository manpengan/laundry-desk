import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  createDataToolDependencies,
  createDatabaseBackup,
  dataToolErrorCode,
  LocalDataError,
  postgresRestoreCommand,
  prepareLocalDataContext,
  verifyBackupFile,
} from "./data-tools.mjs";
import {
  composeRunCommand,
  composeStopCommand,
  composeUpCommand,
  createSpawnRunner,
  unwrapPackageManagerArguments,
} from "./compose.mjs";

export function parseRestoreArguments(argv) {
  const args = unwrapPackageManagerArguments(argv);
  if (
    args.length !== 4 ||
    args[0] !== "--file" ||
    args[2] !== "--confirm-sha256" ||
    typeof args[1] !== "string" ||
    typeof args[3] !== "string"
  ) {
    throw new LocalDataError("LOCAL_RESTORE_ARGS_INVALID");
  }
  return Object.freeze({ file: args[1], sha256: args[3] });
}

const defaultDependencies = () =>
  Object.freeze({
    ...createDataToolDependencies(),
    createDatabaseBackup,
    prepareLocalDataContext,
    run: createSpawnRunner(),
    verifyBackupFile,
  });

export async function runRestore(options, dependencies = defaultDependencies()) {
  const parsed = parseRestoreArguments(options.argv);
  const context = await dependencies.prepareLocalDataContext(options, dependencies);
  const source = await dependencies.verifyBackupFile(context, parsed.file, parsed.sha256);
  const safetyBackup = await dependencies.createDatabaseBackup(
    context,
    { cwd: options.cwd, kind: "pre-restore" },
    dependencies,
  );
  options.stdout(`Pre-restore backup: ${safetyBackup.path}\n`);
  const commandOptions = Object.freeze({ cwd: options.cwd, env: context.env });
  await dependencies.run(
    composeStopCommand("server", { project: context.project }),
    commandOptions,
  );
  const handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await dependencies.stream(postgresRestoreCommand(context.project), {
      ...commandOptions,
      inputFd: handle.fd,
    });
  } catch (error) {
    throw new LocalDataError("LOCAL_RESTORE_DATABASE_FAILED", { cause: error });
  } finally {
    await handle.close();
  }
  await dependencies.run(
    composeRunCommand("migrate", [], { project: context.project }),
    commandOptions,
  );
  await dependencies.run(composeUpCommand("server", { project: context.project }), commandOptions);
  options.stdout(`Restore complete: ${source.path}\n`);
  return Object.freeze({ source, safetyBackup });
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runRestore({
    argv: Object.freeze(process.argv.slice(2)),
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
  }).catch((error) => {
    process.stderr.write(`${dataToolErrorCode(error, "LOCAL_RESTORE_FAILED")}\n`);
    process.exitCode = 1;
  });
}
