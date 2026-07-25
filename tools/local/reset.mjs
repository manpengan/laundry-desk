import { pathToFileURL } from "node:url";

import {
  LOCAL_POSTGRES_VOLUME,
  LOCAL_COMPOSE_PROJECT,
  LocalLifecycleError,
  composeDownCommand,
  lifecycleErrorCode,
  loadResetDependencies,
  resolveComposeProject,
  unwrapPackageManagerArguments,
  volumeInspectLabelsCommand,
  volumeRemoveCommand,
} from "./compose.mjs";

const RESET_CONFIRMATION = "DELETE-laundry-desk-v2-local";

const parseResetArguments = (argv) => {
  const normalizedArguments = unwrapPackageManagerArguments(argv);
  if (
    normalizedArguments.length !== 2 ||
    normalizedArguments[0] !== "--confirm" ||
    normalizedArguments[1] !== RESET_CONFIRMATION
  ) {
    throw new LocalLifecycleError("LOCAL_RESET_CONFIRMATION_REQUIRED");
  }
};

const assertOwnedVolume = async ({ project, expectedLabels, commandOptions, dependencies }) => {
  let capturedLabels;
  try {
    capturedLabels = await dependencies.capture(
      volumeInspectLabelsCommand(project),
      commandOptions,
    );
  } catch {
    throw new LocalLifecycleError("LOCAL_RESET_VOLUME_OWNERSHIP_UNVERIFIED");
  }

  let labels;
  try {
    labels = JSON.parse(capturedLabels);
  } catch {
    throw new LocalLifecycleError("LOCAL_RESET_VOLUME_OWNERSHIP_UNVERIFIED");
  }
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
    throw new LocalLifecycleError("LOCAL_RESET_VOLUME_OWNERSHIP_UNVERIFIED");
  }
  for (const [key, value] of Object.entries(expectedLabels)) {
    if (labels[key] !== value) {
      throw new LocalLifecycleError("LOCAL_RESET_VOLUME_OWNERSHIP_UNVERIFIED");
    }
  }
};

export async function runReset(options, dependencies) {
  parseResetArguments(options.argv);
  const project = resolveComposeProject(options.env);
  if (project !== LOCAL_COMPOSE_PROJECT) {
    throw new LocalLifecycleError("LOCAL_RESET_PROJECT_FORBIDDEN");
  }
  const config = await dependencies.loadLocalConfig({ env: options.env });
  const expectedLabels = dependencies.localVolumeLabels({
    project,
    instanceId: config.instanceId,
  });
  const commandOptions = Object.freeze({
    cwd: options.cwd,
    env: options.env,
  });
  await assertOwnedVolume({ project, expectedLabels, commandOptions, dependencies });
  await dependencies.run(composeDownCommand({ project }), commandOptions);
  await assertOwnedVolume({ project, expectedLabels, commandOptions, dependencies });
  options.stdout(`Deleting Docker volume: ${LOCAL_POSTGRES_VOLUME}\n`);
  await dependencies.run(volumeRemoveCommand(project), commandOptions);
  return 0;
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void loadResetDependencies()
    .then((dependencies) =>
      runReset(
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
      process.stderr.write(`${lifecycleErrorCode(error, "LOCAL_RESET_FAILED")}\n`);
      process.exitCode = 1;
    });
}
