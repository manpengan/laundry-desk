import { pathToFileURL } from "node:url";

import {
  LocalLifecycleError,
  composeDownCommand,
  lifecycleErrorCode,
  loadCommandDependencies,
  resolveComposeProject,
  unwrapPackageManagerArguments,
} from "./compose.mjs";

const parseDownArguments = (argv) => {
  const normalizedArguments = unwrapPackageManagerArguments(argv);
  if (normalizedArguments.length === 0) {
    return;
  }
  if (normalizedArguments.some((argument) => argument === "--volumes" || argument === "-v")) {
    throw new LocalLifecycleError("LOCAL_DOWN_VOLUMES_FORBIDDEN");
  }
  throw new LocalLifecycleError("LOCAL_DOWN_ARGS_INVALID");
};

export async function runDown(options, dependencies) {
  parseDownArguments(options.argv);
  const project = resolveComposeProject(options.env);
  const { directoryPath } = dependencies.resolveLocalConfigPaths({ env: options.env });
  const environment = Object.freeze({
    ...options.env,
    LAUNDRY_LOCAL_CONFIG_DIR: directoryPath,
  });
  await dependencies.run(
    composeDownCommand({ project }),
    Object.freeze({ cwd: options.cwd, env: environment }),
  );
  return 0;
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void loadCommandDependencies()
    .then((dependencies) =>
      runDown(
        Object.freeze({
          argv: Object.freeze(process.argv.slice(2)),
          env: process.env,
          cwd: process.cwd(),
          stdout: (text) => process.stdout.write(text),
          stderr: (text) => process.stderr.write(text),
        }),
        dependencies,
      ),
    )
    .catch((error) => {
      process.stderr.write(`${lifecycleErrorCode(error, "LOCAL_DOWN_FAILED")}\n`);
      process.exitCode = 1;
    });
}
