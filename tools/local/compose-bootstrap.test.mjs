import assert from "node:assert/strict";
import test from "node:test";

const TEST_INSTANCE_ID = "0123456789abcdefghijklmn";
const dependencies = (calls) =>
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
    resolveLocalConfigPaths: () => Object.freeze({ directoryPath: "/test/local-config" }),
    toLocalConfigEnvironment: () =>
      Object.freeze({
        POSTGRES_PASSWORD: "postgres-secret",
        LAUNDRY_APP_PASSWORD: "app-secret",
        LAUNDRY_ACCESS_TOKEN_SECRET: "access-secret",
        LAUNDRY_CSRF_PROOF_SECRET: "csrf-secret",
        LAUNDRY_LOCAL_INSTANCE_ID: TEST_INSTANCE_ID,
      }),
    run: async (command, options) => {
      calls.push(Object.freeze({ kind: "command", command, options }));
    },
  });

test("local up bootstraps only when explicitly requested with both administrators", async () => {
  const { runUp } = await import("./up.mjs");
  const calls = [];
  const environment = Object.freeze({
    LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
    LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "Local Administrator",
    LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "admin-password-secret",
    LAUNDRY_BOOTSTRAP_ADMIN_PIN: "482915",
    LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: "approver",
    LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: "Approval Administrator",
    LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: "approver-password-secret",
    LAUNDRY_BOOTSTRAP_APPROVER_PIN: "739251",
  });

  await runUp(
    Object.freeze({
      argv: Object.freeze(["--", "--bootstrap"]),
      env: environment,
      cwd: "/workspace",
      stdout: () => {},
      stderr: () => {},
    }),
    dependencies(calls),
  );

  const commands = calls.filter((call) => call.kind === "command");
  const bootstrapIndex = commands.findIndex(({ command }) => command.args.includes("bootstrap"));
  const migrateIndex = commands.findIndex(({ command }) => command.args.includes("migrate"));
  const preflightIndex = commands.findIndex(
    ({ command }) => command.args.includes("--eval") && command.args.includes("server"),
  );
  assert.ok(bootstrapIndex > migrateIndex);
  assert.ok(preflightIndex > bootstrapIndex);
  const bootstrapEnvironment = [
    "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
    "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
    "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
    "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
    "LAUNDRY_BOOTSTRAP_APPROVER_USERNAME",
    "LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME",
    "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD",
    "LAUNDRY_BOOTSTRAP_APPROVER_PIN",
  ];
  assert.deepEqual(commands[bootstrapIndex].command.args.slice(-19), [
    "run",
    "--rm",
    ...bootstrapEnvironment.flatMap((name) => ["-e", name]),
    "bootstrap",
  ]);
  assert.equal(
    commands[bootstrapIndex].command.args.some((argument) =>
      Object.values(environment).includes(argument),
    ),
    false,
  );
  assert.equal(
    commands[bootstrapIndex].options.env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
    "admin-password-secret",
  );
  assert.equal(
    commands[bootstrapIndex].options.env.LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD,
    "approver-password-secret",
  );
  for (const [index, { options }] of commands.entries()) {
    if (index === bootstrapIndex) continue;
    for (const key of bootstrapEnvironment) {
      assert.equal(key in options.env, false, `${key} leaked to command ${index}`);
    }
  }
});
