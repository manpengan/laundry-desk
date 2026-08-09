import { pathToFileURL } from "node:url";

import {
  LOCAL_PREFLIGHT_SCRIPT,
  LocalLifecycleError,
  composeBuildCommand,
  composeConfigCommand,
  composeRunCommand,
  composeStopCommand,
  composeUpCommand,
  composeVersionCommand,
  lifecycleEnvironment,
  lifecycleErrorCode,
  loadLifecycleDependencies,
  resolveComposeProject,
  unwrapPackageManagerArguments,
} from "./compose.mjs";

const ADMIN_ENV_KEYS = Object.freeze([
  "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
  "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
  "LAUNDRY_BOOTSTRAP_APPROVER_USERNAME",
  "LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME",
  "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD",
  "LAUNDRY_BOOTSTRAP_APPROVER_PIN",
]);

const parseUpArguments = (argv) => {
  const normalizedArguments = unwrapPackageManagerArguments(argv);
  if (normalizedArguments.length === 0) {
    return Object.freeze({ bootstrap: false });
  }
  if (normalizedArguments.length === 1 && normalizedArguments[0] === "--bootstrap") {
    return Object.freeze({ bootstrap: true });
  }
  throw new LocalLifecycleError("LOCAL_UP_ARGS_INVALID");
};

const assertBootstrapEnvironment = (bootstrap, environment) => {
  if (!bootstrap) {
    return;
  }
  const complete = ADMIN_ENV_KEYS.every((key) => {
    const value = environment[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!complete) {
    throw new LocalLifecycleError("LOCAL_BOOTSTRAP_ENV_INCOMPLETE");
  }
};

const withoutAdministratorEnvironment = (environment) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(environment).filter(([key]) => !ADMIN_ENV_KEYS.includes(key)),
    ),
  );

const bootstrapEnvironment = (environment, administratorEnvironment) =>
  Object.freeze({
    ...environment,
    ...Object.fromEntries(ADMIN_ENV_KEYS.map((key) => [key, administratorEnvironment[key]])),
  });

const isBootstrapCommand = (command) =>
  command.file === "docker" && command.args.includes("run") && command.args.at(-1) === "bootstrap";

export const buildUpCommands = ({ bootstrap, project }) => {
  const composeOptions = Object.freeze({ project });
  const commands = [
    composeVersionCommand(),
    composeConfigCommand(composeOptions),
    composeStopCommand("server", composeOptions),
    composeUpCommand("postgres", composeOptions),
    composeBuildCommand("server", composeOptions),
    composeRunCommand("migrate", [], composeOptions),
  ];
  if (bootstrap) {
    commands.push(
      composeRunCommand("bootstrap", [], {
        ...composeOptions,
        environmentNames: ADMIN_ENV_KEYS,
      }),
    );
  }
  commands.push(
    composeRunCommand(
      "server",
      ["node", "--input-type=module", "--eval", LOCAL_PREFLIGHT_SCRIPT],
      composeOptions,
    ),
    composeUpCommand("server", composeOptions),
  );
  return Object.freeze(commands);
};

export async function runUp(options, dependencies) {
  const parsed = parseUpArguments(options.argv);
  assertBootstrapEnvironment(parsed.bootstrap, options.env);
  const project = resolveComposeProject(options.env);
  const sanitizedEnvironment = withoutAdministratorEnvironment(options.env);
  const environment = await lifecycleEnvironment(sanitizedEnvironment, dependencies);
  const privilegedEnvironment = parsed.bootstrap
    ? bootstrapEnvironment(environment, options.env)
    : environment;
  for (const command of buildUpCommands({ ...parsed, project })) {
    await dependencies.run(
      command,
      Object.freeze({
        cwd: options.cwd,
        env: isBootstrapCommand(command) ? privilegedEnvironment : environment,
      }),
    );
  }
  return 0;
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void loadLifecycleDependencies()
    .then((dependencies) =>
      runUp(
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
      process.stderr.write(`${lifecycleErrorCode(error, "LOCAL_UP_FAILED")}\n`);
      process.exitCode = 1;
    });
}
