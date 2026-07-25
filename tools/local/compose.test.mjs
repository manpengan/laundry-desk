import assert from "node:assert/strict";
import test from "node:test";

const TEST_INSTANCE_ID = "0123456789abcdefghijklmn";

const importRequired = async (relativePath) => {
  try {
    return await import(new URL(relativePath, import.meta.url));
  } catch (error) {
    assert.fail(
      `required lifecycle module ${relativePath} must exist: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const makeConfigDependencies = (calls) =>
  Object.freeze({
    ensureLocalConfig: async (options) => {
      calls.push(Object.freeze({ kind: "config", options }));
      return Object.freeze({ version: 1 });
    },
    loadLocalConfig: async (options) => {
      calls.push(Object.freeze({ kind: "load-config", options }));
      return Object.freeze({ version: 1, instanceId: TEST_INSTANCE_ID });
    },
    localVolumeLabels: ({ project, instanceId }) =>
      Object.freeze({
        "com.laundry-desk.managed": "true",
        "com.laundry-desk.project": project,
        "com.laundry-desk.instance": instanceId,
      }),
    toLocalConfigEnvironment: () =>
      Object.freeze({
        POSTGRES_PASSWORD: "postgres-secret",
        LAUNDRY_APP_PASSWORD: "app-secret",
        LAUNDRY_ACCESS_TOKEN_SECRET: "access-secret",
        LAUNDRY_CSRF_PROOF_SECRET: "csrf-secret",
        LAUNDRY_LOCAL_INSTANCE_ID: TEST_INSTANCE_ID,
      }),
  });

const makeRunner =
  (calls, failureIndex = -1) =>
  async (command, options) => {
    calls.push(Object.freeze({ kind: "command", command, options }));
    const commandIndex = calls.filter((call) => call.kind === "command").length - 1;
    if (commandIndex === failureIndex) {
      const error = new Error("runner failed");
      error.code = "COMMAND_FAILED";
      throw error;
    }
  };

test("compose builders use the safe default project and array arguments", async () => {
  const {
    LOCAL_COMPOSE_FILE,
    LOCAL_COMPOSE_PROJECT,
    composeConfigCommand,
    composeStopCommand,
    composeUpCommand,
    composeVersionCommand,
  } = await importRequired("./compose.mjs");

  assert.equal(LOCAL_COMPOSE_FILE, "tools/compose/docker-compose.yml");
  assert.equal(LOCAL_COMPOSE_PROJECT, "laundry-desk");
  assert.deepEqual(composeVersionCommand(), {
    file: "docker",
    args: ["compose", "version"],
  });
  assert.deepEqual(composeConfigCommand(), {
    file: "docker",
    args: [
      "compose",
      "-p",
      "laundry-desk",
      "-f",
      "tools/compose/docker-compose.yml",
      "config",
      "--quiet",
    ],
  });
  assert.deepEqual(composeUpCommand("postgres"), {
    file: "docker",
    args: [
      "compose",
      "-p",
      "laundry-desk",
      "-f",
      "tools/compose/docker-compose.yml",
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "60",
      "postgres",
    ],
  });
  assert.deepEqual(composeStopCommand("server"), {
    file: "docker",
    args: [
      "compose",
      "-p",
      "laundry-desk",
      "-f",
      "tools/compose/docker-compose.yml",
      "stop",
      "server",
    ],
  });
});

test("compose builders accept only scoped project names and derive the exact volume", async () => {
  const {
    composeConfigCommand,
    localVolumeLabels,
    postgresVolumeName,
    resolveComposeProject,
    volumeRemoveCommand,
  } = await importRequired("./compose.mjs");
  const ciProject = "laundry-ci-48291-2";

  assert.equal(resolveComposeProject({}), "laundry-desk");
  assert.equal(resolveComposeProject({ COMPOSE_PROJECT_NAME: ciProject }), ciProject);
  assert.equal(postgresVolumeName(ciProject), `${ciProject}_pgdata-v2`);
  assert.deepEqual(composeConfigCommand({ project: ciProject }).args.slice(0, 6), [
    "compose",
    "-p",
    ciProject,
    "-f",
    "tools/compose/docker-compose.yml",
    "config",
  ]);
  assert.deepEqual(volumeRemoveCommand(ciProject), {
    file: "docker",
    args: ["volume", "rm", `${ciProject}_pgdata-v2`],
  });
  assert.deepEqual(localVolumeLabels({ project: ciProject, instanceId: TEST_INSTANCE_ID }), {
    "com.laundry-desk.managed": "true",
    "com.laundry-desk.project": ciProject,
    "com.laundry-desk.instance": TEST_INSTANCE_ID,
  });
  assert.throws(() => localVolumeLabels({ project: ciProject, instanceId: "short" }), {
    code: "LOCAL_INSTANCE_ID_INVALID",
  });

  for (const project of [
    "",
    "laundry-CI",
    "laundry-ci;echo",
    "other-project",
    "laundry-",
    `laundry-${"a".repeat(80)}`,
  ]) {
    assert.throws(
      () => resolveComposeProject({ COMPOSE_PROJECT_NAME: project }),
      { code: "LOCAL_COMPOSE_PROJECT_INVALID" },
      project,
    );
  }
});
test("compose builders reject unknown services", async () => {
  const { composeRunCommand, composeUpCommand } = await importRequired("./compose.mjs");

  assert.throws(() => composeUpCommand("postgres; echo unsafe"), {
    code: "LOCAL_COMPOSE_SERVICE_INVALID",
  });
  assert.throws(() => composeRunCommand("unknown"), {
    code: "LOCAL_COMPOSE_SERVICE_INVALID",
  });
});
test("spawn runner disables shell execution and reports a sanitized failure", async () => {
  const { createSpawnRunner } = await importRequired("./compose.mjs");
  const spawnCalls = [];
  const fakeSpawn = (file, args, options) => {
    spawnCalls.push(Object.freeze({ file, args, options }));
    return Object.freeze({
      once(event, listener) {
        if (event === "exit") {
          queueMicrotask(() => listener(7, null));
        }
        return this;
      },
    });
  };
  const run = createSpawnRunner({ spawn: fakeSpawn });
  const secretEnvironment = Object.freeze({ PRIVATE_VALUE: "must-not-leak" });

  await assert.rejects(
    () =>
      run(
        Object.freeze({ file: "docker", args: Object.freeze(["compose", "version"]) }),
        Object.freeze({ cwd: "/workspace", env: secretEnvironment }),
      ),
    (error) => {
      assert.equal(error.code, "LOCAL_COMMAND_FAILED");
      assert.doesNotMatch(error.message, /must-not-leak/u);
      return true;
    },
  );
  assert.deepEqual(spawnCalls, [
    {
      file: "docker",
      args: ["compose", "version"],
      options: {
        cwd: "/workspace",
        env: secretEnvironment,
        shell: false,
        stdio: "inherit",
      },
    },
  ]);
});
test("capture runner disables shell execution and returns bounded stdout", async () => {
  const { createExecFileCaptureRunner } = await importRequired("./compose.mjs");
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push(Object.freeze({ file, args, options }));
    callback(null, '{"label":"value"}\\n', "");
  };
  const capture = createExecFileCaptureRunner({ execFile });

  assert.equal(
    await capture(
      Object.freeze({ file: "docker", args: Object.freeze(["volume", "inspect", "target"]) }),
      Object.freeze({ cwd: "/workspace", env: Object.freeze({ PATH: "/bin" }) }),
    ),
    '{"label":"value"}\\n',
  );
  assert.deepEqual(calls, [
    {
      file: "docker",
      args: ["volume", "inspect", "target"],
      options: {
        cwd: "/workspace",
        env: { PATH: "/bin" },
        shell: false,
        encoding: "utf8",
        maxBuffer: 16_384,
      },
    },
  ]);
});

test("local up runs config, PG health, build, migration, preflight, and server health in order", async () => {
  const { runUp } = await importRequired("./up.mjs");
  const calls = [];
  const environment = Object.freeze({ PATH: "/bin" });

  const exitCode = await runUp(
    Object.freeze({
      argv: Object.freeze([]),
      env: environment,
      cwd: "/workspace",
      stdout: () => assert.fail("normal up must not print secrets"),
      stderr: () => assert.fail("normal up must not write stderr"),
    }),
    Object.freeze({
      ...makeConfigDependencies(calls),
      run: makeRunner(calls),
    }),
  );

  assert.equal(exitCode, 0);
  assert.equal(calls[0].kind, "config");
  assert.deepEqual(calls[0].options.env, environment);
  assert.equal(Object.isFrozen(calls[0].options.env), true);
  const commands = calls.filter((call) => call.kind === "command");
  assert.deepEqual(
    commands.map(({ command }) => command.args),
    [
      ["compose", "version"],
      [
        "compose",
        "-p",
        "laundry-desk",
        "-f",
        "tools/compose/docker-compose.yml",
        "config",
        "--quiet",
      ],
      ["compose", "-p", "laundry-desk", "-f", "tools/compose/docker-compose.yml", "stop", "server"],
      [
        "compose",
        "-p",
        "laundry-desk",
        "-f",
        "tools/compose/docker-compose.yml",
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "60",
        "postgres",
      ],
      [
        "compose",
        "-p",
        "laundry-desk",
        "-f",
        "tools/compose/docker-compose.yml",
        "build",
        "server",
      ],
      [
        "compose",
        "-p",
        "laundry-desk",
        "-f",
        "tools/compose/docker-compose.yml",
        "run",
        "--rm",
        "migrate",
      ],
      [
        "compose",
        "-p",
        "laundry-desk",
        "-f",
        "tools/compose/docker-compose.yml",
        "run",
        "--rm",
        "server",
        "node",
        "--input-type=module",
        "--eval",
        commands[6].command.args.at(-1),
      ],
      [
        "compose",
        "-p",
        "laundry-desk",
        "-f",
        "tools/compose/docker-compose.yml",
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "60",
        "server",
      ],
    ],
  );
  assert.match(commands[6].command.args.at(-1), /createLocalRuntime/u);
  assert.doesNotMatch(commands[6].command.args.at(-1), /\$\{|process\.env\.[A-Z_]+\}/u);
  for (const { options } of commands) {
    assert.equal(options.cwd, "/workspace");
    assert.deepEqual(options.env, {
      PATH: "/bin",
      POSTGRES_PASSWORD: "postgres-secret",
      LAUNDRY_APP_PASSWORD: "app-secret",
      LAUNDRY_ACCESS_TOKEN_SECRET: "access-secret",
      LAUNDRY_CSRF_PROOF_SECRET: "csrf-secret",
      LAUNDRY_LOCAL_INSTANCE_ID: TEST_INSTANCE_ID,
    });
  }
});

test("local up bootstraps only when explicitly requested with all four admin inputs", async () => {
  const { runUp } = await importRequired("./up.mjs");
  const calls = [];
  const environment = Object.freeze({
    LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
    LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "Local Administrator",
    LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "admin-password-secret",
    LAUNDRY_BOOTSTRAP_ADMIN_PIN: "482915",
  });

  await runUp(
    Object.freeze({
      argv: Object.freeze(["--", "--bootstrap"]),
      env: environment,
      cwd: "/workspace",
      stdout: () => {},
      stderr: () => {},
    }),
    Object.freeze({
      ...makeConfigDependencies(calls),
      run: makeRunner(calls),
    }),
  );

  const commands = calls.filter((call) => call.kind === "command");
  const bootstrapIndex = commands.findIndex(({ command }) => command.args.includes("bootstrap"));
  const migrateIndex = commands.findIndex(({ command }) => command.args.includes("migrate"));
  const preflightIndex = commands.findIndex(
    ({ command }) => command.args.includes("--eval") && command.args.includes("server"),
  );
  assert.ok(bootstrapIndex > migrateIndex);
  assert.ok(preflightIndex > bootstrapIndex);
  assert.deepEqual(commands[bootstrapIndex].command.args.slice(-11), [
    "run",
    "--rm",
    "-e",
    "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
    "-e",
    "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
    "-e",
    "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
    "-e",
    "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
    "bootstrap",
  ]);
  assert.equal(
    commands[bootstrapIndex].command.args.some((argument) =>
      ["admin", "Local Administrator", "admin-password-secret", "482915"].includes(argument),
    ),
    false,
  );
  assert.equal(
    commands[bootstrapIndex].options.env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
    "admin-password-secret",
  );
  assert.equal(commands[bootstrapIndex].options.env.LAUNDRY_BOOTSTRAP_ADMIN_PIN, "482915");
  for (const [index, { options }] of commands.entries()) {
    if (index === bootstrapIndex) {
      continue;
    }
    for (const key of [
      "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
      "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
      "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
      "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
    ]) {
      assert.equal(key in options.env, false, `${key} leaked to command ${index}`);
    }
  }
});

test("local up uses one strictly validated project for every compose command", async () => {
  const { runUp } = await importRequired("./up.mjs");
  const calls = [];
  const project = "laundry-ci-901-3";

  await runUp(
    Object.freeze({
      argv: Object.freeze([]),
      env: Object.freeze({ COMPOSE_PROJECT_NAME: project }),
      cwd: "/workspace",
      stdout: () => {},
      stderr: () => {},
    }),
    Object.freeze({
      ...makeConfigDependencies(calls),
      run: makeRunner(calls),
    }),
  );

  const composeCommands = calls
    .filter((call) => call.kind === "command")
    .map(({ command }) => command)
    .filter(({ args }) => args[0] === "compose" && args[1] !== "version");
  assert.ok(composeCommands.length > 0);
  for (const command of composeCommands) {
    assert.deepEqual(command.args.slice(0, 3), ["compose", "-p", project]);
  }
});

test("local up rejects incomplete bootstrap input and unknown arguments before running commands", async () => {
  const { runUp } = await importRequired("./up.mjs");
  for (const testCase of [
    { argv: ["--bootstrap"], env: {}, code: "LOCAL_BOOTSTRAP_ENV_INCOMPLETE" },
    { argv: ["--bootstrap", "--bootstrap"], env: {}, code: "LOCAL_UP_ARGS_INVALID" },
    { argv: ["--unknown"], env: {}, code: "LOCAL_UP_ARGS_INVALID" },
  ]) {
    const calls = [];
    await assert.rejects(
      () =>
        runUp(
          Object.freeze({
            argv: Object.freeze(testCase.argv),
            env: Object.freeze(testCase.env),
            cwd: "/workspace",
            stdout: () => {},
            stderr: () => {},
          }),
          Object.freeze({
            ...makeConfigDependencies(calls),
            run: makeRunner(calls),
          }),
        ),
      { code: testCase.code },
    );
    assert.deepEqual(calls, []);
  }
});
test("local up stops after the first command failure", async () => {
  const { runUp } = await importRequired("./up.mjs");
  const calls = [];

  await assert.rejects(
    () =>
      runUp(
        Object.freeze({
          argv: Object.freeze([]),
          env: Object.freeze({}),
          cwd: "/workspace",
          stdout: () => {},
          stderr: () => {},
        }),
        Object.freeze({
          ...makeConfigDependencies(calls),
          run: makeRunner(calls, 2),
        }),
      ),
    { code: "COMMAND_FAILED" },
  );
  assert.equal(calls.filter((call) => call.kind === "command").length, 3);
});
test("local up stops an existing server before migration and leaves it stopped on failure", async () => {
  const { runUp } = await importRequired("./up.mjs");
  const calls = [];

  await assert.rejects(
    () =>
      runUp(
        Object.freeze({
          argv: Object.freeze([]),
          env: Object.freeze({}),
          cwd: "/workspace",
          stdout: () => {},
          stderr: () => {},
        }),
        Object.freeze({
          ...makeConfigDependencies(calls),
          run: makeRunner(calls, 5),
        }),
      ),
    { code: "COMMAND_FAILED" },
  );

  const commandArguments = calls
    .filter((call) => call.kind === "command")
    .map(({ command }) => command.args);
  const stopIndex = commandArguments.findIndex(
    (args) => args.at(-2) === "stop" && args.at(-1) === "server",
  );
  const migrateIndex = commandArguments.findIndex((args) => args.at(-1) === "migrate");

  assert.ok(stopIndex >= 0);
  assert.ok(migrateIndex > stopIndex);
  assert.equal(
    commandArguments.some((args) => args.includes("up") && args.at(-1) === "server"),
    false,
  );
});

test("local down accepts no arguments and never deletes volumes", async () => {
  const { runDown } = await importRequired("./down.mjs");
  const calls = [];
  const environment = Object.freeze({ COMPOSE_PROJECT_NAME: "laundry-ci-901-3" });

  const exitCode = await runDown(
    Object.freeze({
      argv: Object.freeze([]),
      env: environment,
      cwd: "/workspace",
      stdout: () => {},
      stderr: () => {},
    }),
    Object.freeze({
      ...makeConfigDependencies(calls),
      run: makeRunner(calls),
    }),
  );

  assert.equal(exitCode, 0);
  const commands = calls.filter((call) => call.kind === "command");
  assert.equal(commands.length, 1);
  assert.equal(
    calls.some((call) => call.kind === "config"),
    false,
  );
  assert.deepEqual(commands[0].command.args.slice(0, 3), ["compose", "-p", "laundry-ci-901-3"]);
  assert.deepEqual(commands[0].command.args.slice(-2), ["down", "--remove-orphans"]);
  assert.equal(commands[0].command.args.includes("--volumes"), false);
  assert.equal(commands[0].command.args.includes("-v"), false);
  assert.equal(commands[0].options.env, environment);

  for (const argv of [["--volumes"], ["-v"], ["unexpected"]]) {
    const rejectedCalls = [];
    await assert.rejects(
      () =>
        runDown(
          Object.freeze({
            argv: Object.freeze(argv),
            env: Object.freeze({}),
            cwd: "/workspace",
            stdout: () => {},
            stderr: () => {},
          }),
          Object.freeze({
            ...makeConfigDependencies(rejectedCalls),
            run: makeRunner(rejectedCalls),
          }),
        ),
      { code: argv[0].includes("v") ? "LOCAL_DOWN_VOLUMES_FORBIDDEN" : "LOCAL_DOWN_ARGS_INVALID" },
    );
    assert.deepEqual(rejectedCalls, []);
  }
});

test("local reset requires the exact confirmation and removes only the exact named volume", async () => {
  const { runReset } = await importRequired("./reset.mjs");
  const { LOCAL_POSTGRES_VOLUME } = await importRequired("./compose.mjs");
  const calls = [];
  const output = [];

  const exitCode = await runReset(
    Object.freeze({
      argv: Object.freeze(["--", "--confirm", "DELETE-laundry-desk-v2-local"]),
      env: Object.freeze({}),
      cwd: "/workspace",
      stdout: (text) => output.push(text),
      stderr: () => {},
    }),
    Object.freeze({
      ...makeConfigDependencies(calls),
      run: makeRunner(calls),
      capture: async (command, options) => {
        calls.push(Object.freeze({ kind: "capture", command, options }));
        return JSON.stringify({
          "com.laundry-desk.managed": "true",
          "com.laundry-desk.project": "laundry-desk",
          "com.laundry-desk.instance": TEST_INSTANCE_ID,
        });
      },
    }),
  );

  assert.equal(exitCode, 0);
  assert.equal(LOCAL_POSTGRES_VOLUME, "laundry-desk_pgdata-v2");
  assert.equal(
    calls.some((call) => call.kind === "config"),
    false,
  );
  assert.equal(calls.filter((call) => call.kind === "load-config").length, 1);
  const inspections = calls.filter((call) => call.kind === "capture");
  assert.equal(inspections.length, 2);
  for (const inspection of inspections) {
    assert.deepEqual(inspection.command, {
      file: "docker",
      args: ["volume", "inspect", "--format", "{{ json .Labels }}", "laundry-desk_pgdata-v2"],
    });
  }
  assert.deepEqual(output, [`Deleting Docker volume: ${LOCAL_POSTGRES_VOLUME}\n`]);
  const commands = calls.filter((call) => call.kind === "command");
  assert.deepEqual(commands.at(-1).command, {
    file: "docker",
    args: ["volume", "rm", "laundry-desk_pgdata-v2"],
  });
  assert.equal(
    commands.some(({ command }) =>
      command.args.some((argument) => argument === "*" || argument.includes("volume*")),
    ),
    false,
  );
});

test("local reset fails closed before down or remove when volume ownership is unverified", async () => {
  const { runReset } = await importRequired("./reset.mjs");

  for (const capturedLabels of [
    "{}",
    JSON.stringify({
      "com.laundry-desk.managed": "true",
      "com.laundry-desk.project": "laundry-desk",
      "com.laundry-desk.instance": "other-instance",
    }),
    "not-json",
  ]) {
    const calls = [];
    await assert.rejects(
      () =>
        runReset(
          Object.freeze({
            argv: Object.freeze(["--confirm", "DELETE-laundry-desk-v2-local"]),
            env: Object.freeze({}),
            cwd: "/workspace",
            stdout: () => assert.fail("unverified reset must not announce deletion"),
            stderr: () => {},
          }),
          Object.freeze({
            ...makeConfigDependencies(calls),
            run: makeRunner(calls),
            capture: async (command, options) => {
              calls.push(Object.freeze({ kind: "capture", command, options }));
              return capturedLabels;
            },
          }),
        ),
      { code: "LOCAL_RESET_VOLUME_OWNERSHIP_UNVERIFIED" },
    );
    assert.equal(
      calls.some((call) => call.kind === "command"),
      false,
    );
  }
});

test("local reset rechecks ownership after down and refuses a changed volume", async () => {
  const { runReset } = await importRequired("./reset.mjs");
  const calls = [];
  let inspection = 0;
  const expectedLabels = {
    "com.laundry-desk.managed": "true",
    "com.laundry-desk.project": "laundry-desk",
    "com.laundry-desk.instance": TEST_INSTANCE_ID,
  };

  await assert.rejects(
    () =>
      runReset(
        Object.freeze({
          argv: Object.freeze(["--confirm", "DELETE-laundry-desk-v2-local"]),
          env: Object.freeze({}),
          cwd: "/workspace",
          stdout: () => assert.fail("changed reset target must not announce deletion"),
          stderr: () => {},
        }),
        Object.freeze({
          ...makeConfigDependencies(calls),
          run: makeRunner(calls),
          capture: async (command, options) => {
            calls.push(Object.freeze({ kind: "capture", command, options }));
            inspection += 1;
            return JSON.stringify(
              inspection === 1
                ? expectedLabels
                : { ...expectedLabels, "com.laundry-desk.instance": "changed-instance" },
            );
          },
        }),
      ),
    { code: "LOCAL_RESET_VOLUME_OWNERSHIP_UNVERIFIED" },
  );

  const commands = calls.filter((call) => call.kind === "command");
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].command.args.slice(-2), ["down", "--remove-orphans"]);
});

test("local reset refuses even a valid non-default project override", async () => {
  const { runReset } = await importRequired("./reset.mjs");
  const calls = [];
  const output = [];

  await assert.rejects(
    () =>
      runReset(
        Object.freeze({
          argv: Object.freeze(["--confirm", "DELETE-laundry-desk-v2-local"]),
          env: Object.freeze({ COMPOSE_PROJECT_NAME: "laundry-ci-901-3" }),
          cwd: "/workspace",
          stdout: (text) => output.push(text),
          stderr: () => {},
        }),
        Object.freeze({
          ...makeConfigDependencies(calls),
          run: makeRunner(calls),
        }),
      ),
    { code: "LOCAL_RESET_PROJECT_FORBIDDEN" },
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(output, []);
});
test("local reset rejects every inexact confirmation without side effects", async () => {
  const { runReset } = await importRequired("./reset.mjs");
  for (const argv of [
    [],
    ["--confirm"],
    ["--confirm", "laundry-desk-v2-local"],
    ["--confirm", "DELETE-laundry-desk-v2-local", "--force"],
    ["--volume", "laundry-desk_pgdata-v2"],
  ]) {
    const calls = [];
    const output = [];
    await assert.rejects(
      () =>
        runReset(
          Object.freeze({
            argv: Object.freeze(argv),
            env: Object.freeze({}),
            cwd: "/workspace",
            stdout: (text) => output.push(text),
            stderr: () => {},
          }),
          Object.freeze({
            ...makeConfigDependencies(calls),
            run: makeRunner(calls),
          }),
        ),
      { code: "LOCAL_RESET_CONFIRMATION_REQUIRED" },
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(output, []);
  }
});
