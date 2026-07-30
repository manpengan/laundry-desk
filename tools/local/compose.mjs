import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";

export const LOCAL_COMPOSE_FILE = "tools/compose/docker-compose.yml";
export const LOCAL_COMPOSE_PROJECT = "laundry-desk";
export const LOCAL_POSTGRES_VOLUME = `${LOCAL_COMPOSE_PROJECT}_pgdata-v2`;
export const LOCAL_VOLUME_LABEL_KEYS = Object.freeze({
  managed: "com.laundry-desk.managed",
  project: "com.laundry-desk.project",
  instance: "com.laundry-desk.instance",
});

const COMPOSE_SERVICES = new Set(["postgres", "migrate", "bootstrap", "server"]);
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const MAXIMUM_CAPTURE_BYTES = 16_384;
const MAXIMUM_PROJECT_LENGTH = 63;
const PROJECT_PATTERN = /^laundry-[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const WAIT_TIMEOUT_SECONDS = "60";

export const LOCAL_PREFLIGHT_SCRIPT = [
  'const { createLocalRuntime } = await import("./apps/server/dist/local/create-runtime.js");',
  "const runtime = await createLocalRuntime(process.env);",
  "if (runtime.pool !== null) await runtime.pool.end();",
].join(" ");

export class LocalLifecycleError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "LocalLifecycleError";
    this.code = code;
  }
}

const command = (file, args) =>
  Object.freeze({
    file,
    args: Object.freeze([...args]),
  });

export const unwrapPackageManagerArguments = (argv) =>
  Object.freeze(argv[0] === "--" ? argv.slice(1) : [...argv]);

const assertService = (service) => {
  if (!COMPOSE_SERVICES.has(service)) {
    throw new LocalLifecycleError("LOCAL_COMPOSE_SERVICE_INVALID");
  }
};

const assertProject = (project) => {
  if (
    typeof project !== "string" ||
    project.length > MAXIMUM_PROJECT_LENGTH ||
    !PROJECT_PATTERN.test(project)
  ) {
    throw new LocalLifecycleError("LOCAL_COMPOSE_PROJECT_INVALID");
  }
  return project;
};

export const resolveComposeProject = (environment) => {
  const override = environment.COMPOSE_PROJECT_NAME;
  return override === undefined ? LOCAL_COMPOSE_PROJECT : assertProject(override);
};

export const postgresVolumeName = (project = LOCAL_COMPOSE_PROJECT) =>
  `${assertProject(project)}_pgdata-v2`;

export const localVolumeLabels = ({ project, instanceId }) => {
  const normalizedProject = assertProject(project);
  if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new LocalLifecycleError("LOCAL_INSTANCE_ID_INVALID");
  }
  return Object.freeze({
    [LOCAL_VOLUME_LABEL_KEYS.managed]: "true",
    [LOCAL_VOLUME_LABEL_KEYS.project]: normalizedProject,
    [LOCAL_VOLUME_LABEL_KEYS.instance]: instanceId,
  });
};

const assertComposeOptions = (options) => {
  if (options.composeFile !== undefined && options.composeFile !== LOCAL_COMPOSE_FILE) {
    throw new LocalLifecycleError("LOCAL_COMPOSE_FILE_INVALID");
  }
  return assertProject(options.project ?? LOCAL_COMPOSE_PROJECT);
};

export const composeCommand = (args, options = {}) => {
  const project = assertComposeOptions(options);
  return command("docker", ["compose", "-p", project, "-f", LOCAL_COMPOSE_FILE, ...args]);
};

export const composeVersionCommand = () => command("docker", ["compose", "version"]);

export const composeConfigCommand = (options = {}) =>
  composeCommand(["config", "--quiet"], options);

export const composeBuildCommand = (service, options = {}) => {
  assertService(service);
  return composeCommand(["build", service], options);
};

export const composeUpCommand = (service, options = {}) => {
  assertService(service);
  return composeCommand(
    ["up", "-d", "--wait", "--wait-timeout", WAIT_TIMEOUT_SECONDS, service],
    options,
  );
};

export const composeStopCommand = (service, options = {}) => {
  assertService(service);
  return composeCommand(["stop", service], options);
};

export const composeCopyFromCommand = (service, sourcePath, destinationPath, options = {}) => {
  assertService(service);
  return composeCommand(["cp", `${service}:${sourcePath}`, destinationPath], options);
};

const environmentArguments = (names) => names.flatMap((name) => ["-e", name]);

export const composeRunCommand = (service, serviceCommand = [], options = {}) => {
  assertService(service);
  return composeCommand(
    [
      "run",
      "--rm",
      ...environmentArguments(options.environmentNames ?? []),
      service,
      ...serviceCommand,
    ],
    options,
  );
};

export const composeDownCommand = (options = {}) =>
  composeCommand(["down", "--remove-orphans"], options);

export const volumeRemoveCommand = (project = LOCAL_COMPOSE_PROJECT) =>
  command("docker", ["volume", "rm", postgresVolumeName(project)]);

export const volumeInspectLabelsCommand = (project = LOCAL_COMPOSE_PROJECT) =>
  command("docker", [
    "volume",
    "inspect",
    "--format",
    "{{ json .Labels }}",
    postgresVolumeName(project),
  ]);

const commandFailure = (cause) => new LocalLifecycleError("LOCAL_COMMAND_FAILED", { cause });

export const createSpawnRunner =
  ({ spawn = nodeSpawn } = {}) =>
  async (commandSpec, options) =>
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(commandSpec.file, [...commandSpec.args], {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: "inherit",
        });
      } catch (error) {
        reject(commandFailure(error));
        return;
      }
      child.once("error", (error) => reject(commandFailure(error)));
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(commandFailure(Object.freeze({ code, signal })));
      });
    });

export const createExecFileCaptureRunner =
  ({ execFile = nodeExecFile } = {}) =>
  async (commandSpec, options) =>
    await new Promise((resolve, reject) => {
      try {
        execFile(
          commandSpec.file,
          [...commandSpec.args],
          {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            encoding: "utf8",
            maxBuffer: MAXIMUM_CAPTURE_BYTES,
          },
          (error, stdout) => {
            if (error !== null) {
              reject(
                commandFailure(
                  Object.freeze({
                    code: error.code ?? null,
                    signal: error.signal ?? null,
                  }),
                ),
              );
              return;
            }
            if (typeof stdout !== "string") {
              reject(commandFailure(Object.freeze({ code: "INVALID_STDOUT", signal: null })));
              return;
            }
            resolve(stdout);
          },
        );
      } catch (error) {
        reject(commandFailure(error));
      }
    });

export const loadLifecycleDependencies = async () => {
  const { ensureLocalConfig, toLocalConfigEnvironment } = await import("./config.mjs");
  return Object.freeze({
    ensureLocalConfig,
    toLocalConfigEnvironment,
    run: createSpawnRunner(),
  });
};

export const loadResetDependencies = async () => {
  const { loadLocalConfig } = await import("./config.mjs");
  return Object.freeze({
    loadLocalConfig,
    localVolumeLabels,
    run: createSpawnRunner(),
    capture: createExecFileCaptureRunner(),
  });
};

export const createCommandDependencies = () =>
  Object.freeze({
    run: createSpawnRunner(),
  });

export const lifecycleEnvironment = async (environment, dependencies) => {
  const config = await dependencies.ensureLocalConfig({ env: environment });
  return Object.freeze({
    ...environment,
    ...dependencies.toLocalConfigEnvironment(config),
  });
};

export const lifecycleErrorCode = (error, fallback) =>
  error instanceof LocalLifecycleError ||
  (error !== null &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    error.code.startsWith("LOCAL_"))
    ? error.code
    : fallback;
