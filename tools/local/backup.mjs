import { pathToFileURL } from "node:url";

import {
  createDataToolDependencies,
  createDatabaseBackup,
  dataToolErrorCode,
  LocalDataError,
  prepareLocalDataContext,
} from "./data-tools.mjs";
import { unwrapPackageManagerArguments } from "./compose.mjs";

export const parseBackupArguments = (argv) => {
  if (unwrapPackageManagerArguments(argv).length !== 0) {
    throw new LocalDataError("LOCAL_BACKUP_ARGS_INVALID");
  }
};

export async function runBackup(options, dependencies = createDataToolDependencies()) {
  parseBackupArguments(options.argv);
  const context = await prepareLocalDataContext(options, dependencies);
  const backup = await createDatabaseBackup(
    context,
    { cwd: options.cwd, kind: "backup" },
    dependencies,
  );
  options.stdout(`Backup: ${backup.path}\nSHA-256: ${backup.sha256}\nBytes: ${backup.bytes}\n`);
  return backup;
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
