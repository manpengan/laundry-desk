import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ADMIN_ENV = Object.freeze({
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "acceptance-admin",
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "Acceptance Administrator",
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "test-password-not-a-real-secret",
  LAUNDRY_BOOTSTRAP_ADMIN_PIN: "246810",
  LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: "acceptance-approver",
  LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: "Acceptance Approver",
  LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: "independent-approver-secret",
  LAUNDRY_BOOTSTRAP_APPROVER_PIN: "135790",
});
const UUID = "12345678-1234-4123-8123-123456789abc";
const PROJECT = "laundry-acceptance-123456781234412381231234";
const INSTANCE_ID = Buffer.alloc(16, 7).toString("base64url");
const APP_PATH = "/workspace/apps/edge-agent/release/mac-arm64/laundry-desk V2.app";
const RECOVERY_PATH =
  "/private/tmp/laundry-acceptance-owned/config/backups/laundry-v2-backup-20260808T000000Z-a1b2c3d4.dump";
const RECOVERY_SHA = "a".repeat(64);
const LOCAL_SECRETS = Object.freeze([
  "pg-super-secret",
  "pg-app-secret",
  "access-secret",
  "csrf-secret",
]);

async function implementation() {
  try {
    return await import("./acceptance.mjs");
  } catch (error) {
    assert.fail(`acceptance harness implementation is required: ${error?.code ?? "unknown"}`);
  }
}

function commandName(command) {
  return [command.file, ...command.args].join(" ");
}

function createDependencies(overrides = {}) {
  const events = [];
  const dependencies = {
    randomUUID: () => UUID,
    resolveTemporaryBase: async () => "/private/tmp",
    canonicalizePath: async (path) => path,
    checkPort: async (port) => events.push(`port:${port}`),
    createTempRoot: async () => {
      events.push("temp:create");
      return "/private/tmp/laundry-acceptance-owned";
    },
    createDirectory: async (path) => events.push(`mkdir:${path}`),
    run: async (command, options) => {
      events.push({ kind: "run", command, options });
    },
    waitForPostgres: async () => events.push("wait:postgres-up"),
    waitForHealth: async ({ expected }) => events.push(`wait:health-${expected}`),
    loadInstanceId: async () => {
      events.push("config:load-instance");
      return INSTANCE_ID;
    },
    loadSecretValues: async () => {
      events.push("config:load-secrets");
      return LOCAL_SECRETS;
    },
    findRecoverySet: async () => {
      events.push("recovery:find");
      return Object.freeze({ path: RECOVERY_PATH, sha256: RECOVERY_SHA });
    },
    validateSupportBundles: async ({ configDirectory, secretValues, expectedCount }) => {
      events.push(`support:validate:${expectedCount}:${configDirectory}`);
      assert.deepEqual(secretValues, [
        ADMIN_ENV.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
        ADMIN_ENV.LAUNDRY_BOOTSTRAP_ADMIN_PIN,
        ADMIN_ENV.LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD,
        ADMIN_ENV.LAUNDRY_BOOTSTRAP_APPROVER_PIN,
        ...LOCAL_SECRETS,
      ]);
    },
    findPackagedApp: async () => {
      events.push("app:find");
      return APP_PATH;
    },
    inspectVolumeLabels: async ({ volumeName }) => {
      events.push(`volume:inspect:${volumeName}`);
      return {
        "com.laundry-desk.managed": "true",
        "com.laundry-desk.project": PROJECT,
        "com.laundry-desk.instance": INSTANCE_ID,
        "com.docker.compose.volume": "pgdata-v2",
      };
    },
    removeVolume: async ({ volumeName }) => events.push(`volume:remove:${volumeName}`),
    removeTree: async (path) => events.push(`tree:remove:${path}`),
    ...overrides,
  };
  return { dependencies: Object.freeze(dependencies), events };
}

test("requires every bootstrap administrator input before any side effect", async () => {
  const { runAcceptance, ACCEPTANCE_ADMIN_ENV_KEYS } = await implementation();

  for (const missing of ACCEPTANCE_ADMIN_ENV_KEYS) {
    const environment = { PATH: "/bin", ...ADMIN_ENV };
    delete environment[missing];
    const { dependencies, events } = createDependencies();

    await assert.rejects(
      () => runAcceptance({ cwd: "/workspace", env: environment }, dependencies),
      (error) => error?.code === "ACCEPTANCE_BOOTSTRAP_ENV_INCOMPLETE",
    );
    assert.deepEqual(events, []);
  }
});

test("rejects caller-controlled acceptance identity and artifact paths", async () => {
  const { runAcceptance } = await implementation();
  const forbidden = [
    ["COMPOSE_PROJECT_NAME", "laundry-other"],
    ["LAUNDRY_LOCAL_CONFIG_DIR", "/tmp/other-config"],
    ["LAUNDRY_MAC_USER_DATA_DIR", "/tmp/other-user-data"],
    ["LAUNDRY_MAC_APP_PATH", "/tmp/other.app"],
  ];

  for (const [name, value] of forbidden) {
    const { dependencies, events } = createDependencies();
    await assert.rejects(
      () =>
        runAcceptance(
          { cwd: "/workspace", env: { PATH: "/bin", ...ADMIN_ENV, [name]: value } },
          dependencies,
        ),
      (error) => error?.code === "ACCEPTANCE_ENV_OVERRIDE_FORBIDDEN",
    );
    assert.deepEqual(events, []);
  }
});

test("refuses either occupied fixed port before creating files or running commands", async () => {
  const { runAcceptance } = await implementation();

  for (const occupied of [8543, 8787]) {
    const { dependencies, events } = createDependencies({
      checkPort: async (port) => {
        events.push(`port:${port}`);
        if (port === occupied) throw new Error("private socket diagnostic");
      },
    });
    await assert.rejects(
      () => runAcceptance({ cwd: "/workspace", env: { PATH: "/bin", ...ADMIN_ENV } }, dependencies),
      (error) =>
        error?.code === "ACCEPTANCE_PORT_OCCUPIED" &&
        !error.message.includes("private socket diagnostic"),
    );
    assert.equal(events.includes("temp:create"), false);
    assert.equal(
      events.some((event) => typeof event === "object"),
      false,
    );
  }
});

test("deletes only an owned canonical temp root, including partial setup cleanup", async () => {
  const { runAcceptance } = await implementation();
  const unsafe = createDependencies({
    createTempRoot: async () => "/Users",
    createDirectory: async () => assert.fail("unsafe root must be rejected first"),
    removeTree: async () => assert.fail("unsafe root must never be recursively removed"),
  });
  await assert.rejects(
    () =>
      runAcceptance(
        { cwd: "/workspace", env: { PATH: "/bin", ...ADMIN_ENV } },
        unsafe.dependencies,
      ),
    (error) => error?.code === "ACCEPTANCE_TEMP_ROOT_INVALID",
  );

  const partial = createDependencies({
    createDirectory: async () => {
      throw new Error("mkdir detail");
    },
  });
  await assert.rejects(
    () =>
      runAcceptance(
        { cwd: "/workspace", env: { PATH: "/bin", ...ADMIN_ENV } },
        partial.dependencies,
      ),
    (error) => error?.code === "ACCEPTANCE_TEMP_SETUP_FAILED",
  );
  assert.equal(partial.events.at(-1), "tree:remove:/private/tmp/laundry-acceptance-owned");
});

test("runs the real-browser/package/outage/recovery sequence with one identity", async () => {
  const { runAcceptance } = await implementation();
  const { dependencies, events } = createDependencies();

  await runAcceptance(
    {
      cwd: "/workspace",
      env: {
        PATH: "/bin",
        LANG: "zh_TW.UTF-8",
        TASK11_SYNTHETIC_SECRET: "must-not-reach-child",
        ...ADMIN_ENV,
      },
    },
    dependencies,
  );

  const runs = events.filter((event) => typeof event === "object");
  assert.deepEqual(
    runs.map(({ command }) => commandName(command)),
    [
      "pnpm local:up --bootstrap",
      "pnpm local:web:e2e",
      "pnpm local:mac:build",
      `${process.execPath} tools/local/print-dispatch-acceptance.mjs`,
      "pnpm local:maintenance",
      `pnpm local:restore:drill --file ${RECOVERY_PATH} --confirm-sha256 ${RECOVERY_SHA}`,
      "pnpm local:support-bundle",
      "pnpm local:down",
      "pnpm local:support-bundle",
      "pnpm local:mac:e2e",
      "pnpm local:down",
    ],
  );

  for (const index of [0, 1, 3, 9]) {
    const environment = runs[index].options.env;
    for (const [name, value] of Object.entries(ADMIN_ENV)) {
      assert.equal(environment[name], value);
    }
  }
  for (const index of [2, 4, 5, 6, 7, 8, 10]) {
    const environment = runs[index].options.env;
    for (const name of Object.keys(ADMIN_ENV)) {
      assert.equal(name in environment, false);
    }
  }
  assert.equal(runs[9].options.env.LAUNDRY_MAC_APP_PATH, APP_PATH);
  assert.equal(runs[1].options.env.LAUNDRY_LOCAL_ORG_CODE, "local");
  assert.equal(runs[4].options.env.LAUNDRY_LOCAL_STORE_CODE, "main");

  for (const { command } of runs) {
    const serialized = JSON.stringify(command);
    assert.doesNotMatch(serialized, /test-password-not-a-real-secret|246810/u);
  }
  for (const { options } of runs) {
    assert.equal("TASK11_SYNTHETIC_SECRET" in options.env, false);
  }

  const volumeName = `${PROJECT}_pgdata-v2`;
  assert.deepEqual(
    events.filter((event) => typeof event === "string"),
    [
      "port:8543",
      "port:8787",
      "temp:create",
      "mkdir:/private/tmp/laundry-acceptance-owned/user-data",
      "config:load-instance",
      "wait:postgres-up",
      "wait:health-up",
      "wait:health-up",
      "recovery:find",
      "app:find",
      "wait:health-down",
      `volume:inspect:${volumeName}`,
      "config:load-secrets",
      "support:validate:2:/private/tmp/laundry-acceptance-owned/config",
      "wait:health-down",
      `volume:inspect:${volumeName}`,
      `volume:remove:${volumeName}`,
      "tree:remove:/private/tmp/laundry-acceptance-owned",
    ],
  );
  assert.equal(runs[0].options.env.COMPOSE_PROJECT_NAME, PROJECT);
  assert.equal(
    runs[0].options.env.LAUNDRY_LOCAL_CONFIG_DIR,
    "/private/tmp/laundry-acceptance-owned/config",
  );
  assert.equal(
    runs[4].options.env.LAUNDRY_MAC_USER_DATA_DIR,
    "/private/tmp/laundry-acceptance-owned/user-data",
  );
});

test("a mac smoke failure still downs, validates, removes the exact volume, and cleans files", async () => {
  const { runAcceptance } = await implementation();
  const { dependencies, events } = createDependencies({
    run: async (command, options) => {
      events.push({ kind: "run", command, options });
      if (commandName(command) === "pnpm local:mac:e2e") {
        throw new Error("secret-bearing child failure must be hidden");
      }
    },
  });

  await assert.rejects(
    () => runAcceptance({ cwd: "/workspace", env: { PATH: "/bin", ...ADMIN_ENV } }, dependencies),
    (error) =>
      error?.code === "ACCEPTANCE_MAC_E2E_FAILED" &&
      !error.message.includes("secret-bearing child failure"),
  );

  const commands = events
    .filter((event) => typeof event === "object")
    .map(({ command }) => commandName(command));
  assert.deepEqual(commands.slice(-2), ["pnpm local:mac:e2e", "pnpm local:down"]);
  assert.ok(events.includes(`volume:remove:${PROJECT}_pgdata-v2`));
  assert.equal(events.at(-1), "tree:remove:/private/tmp/laundry-acceptance-owned");
});

test("an up failure after config creation still validates and removes only its volume", async () => {
  const { runAcceptance } = await implementation();
  const { dependencies, events } = createDependencies({
    run: async (command, options) => {
      events.push({ kind: "run", command, options });
      if (commandName(command) === "pnpm local:up --bootstrap") throw new Error("up failed");
    },
  });
  await assert.rejects(
    () => runAcceptance({ cwd: "/workspace", env: { PATH: "/bin", ...ADMIN_ENV } }, dependencies),
    (error) => error?.code === "ACCEPTANCE_BOOTSTRAP_UP_FAILED",
  );
  assert.ok(events.includes("config:load-instance"));
  assert.ok(events.includes(`volume:remove:${PROJECT}_pgdata-v2`));
  assert.equal(events.at(-1), "tree:remove:/private/tmp/laundry-acceptance-owned");
});

test("invalid ownership labels fail closed and never remove a volume", async () => {
  const { runAcceptance } = await implementation();
  const { dependencies, events } = createDependencies({
    inspectVolumeLabels: async ({ volumeName }) => {
      events.push(`volume:inspect:${volumeName}`);
      return {
        "com.laundry-desk.managed": "true",
        "com.laundry-desk.project": PROJECT,
        "com.laundry-desk.instance": "another-instance",
      };
    },
  });

  await assert.rejects(() =>
    runAcceptance({ cwd: "/workspace", env: { PATH: "/bin", ...ADMIN_ENV } }, dependencies),
  );
  assert.equal(
    events.some((event) => String(event).startsWith("volume:remove:")),
    false,
  );
  assert.equal(events.at(-1), "tree:remove:/private/tmp/laundry-acceptance-owned");
});

test("finds exactly one regular packaged app under mac-* output", async () => {
  const { findUniquePackagedApp } = await implementation();
  const root = await mkdtemp(join(tmpdir(), "laundry-app-scan-"));
  try {
    await mkdir(join(root, "mac-arm64", "laundry-desk V2.app"), { recursive: true });
    assert.equal(await findUniquePackagedApp(root), join(root, "mac-arm64", "laundry-desk V2.app"));

    await mkdir(join(root, "mac-x64", "laundry-desk V2.app"), { recursive: true });
    await assert.rejects(
      () => findUniquePackagedApp(root),
      (error) => error?.code === "ACCEPTANCE_MAC_APP_NOT_UNIQUE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("support bundle acceptance enforces private files, manifest and secret absence", async () => {
  const { validateSupportBundles } = await import("./acceptance-recovery.mjs");
  const root = await mkdtemp(join(tmpdir(), "laundry-support-acceptance-"));
  const output = join(root, "support-bundles");
  const bundle = (status) =>
    `${JSON.stringify({
      version: 1,
      manifest: {
        format: "laundry-desk-support-bundle",
        sections: [
          "product",
          "diagnostics",
          "services",
          "migrations",
          "server_logs",
          "edge_queue",
          "cups",
          "update_state",
        ],
      },
      generated_at: "2026-08-08T00:00:00.000Z",
      sections: {
        product: { status },
        diagnostics: {},
        services: {},
        migrations: {},
        server_logs: {},
        edge_queue: {},
        cups: {},
        update_state: {},
      },
    })}\n`;
  try {
    await mkdir(output, { mode: 0o700 });
    const files = [
      ["a".repeat(24), "running"],
      ["b".repeat(24), "stopped"],
    ];
    for (const [suffix, status] of files) {
      await writeFile(
        join(output, `laundry-v2-support-20260808T000000Z-${suffix}.json`),
        bundle(status),
        { mode: 0o600 },
      );
    }
    const canonicalRoot = await realpath(root);
    await validateSupportBundles({
      configDirectory: canonicalRoot,
      secretValues: ["must-not-appear"],
      expectedCount: 2,
    });
    const first = join(output, `laundry-v2-support-20260808T000000Z-${files[0][0]}.json`);
    await chmod(first, 0o644);
    await assert.rejects(
      () =>
        validateSupportBundles({
          configDirectory: canonicalRoot,
          secretValues: ["must-not-appear"],
          expectedCount: 2,
        }),
      (error) => error?.code === "LOCAL_SUPPORT_SOURCE_INVALID",
    );
    await chmod(first, 0o600);
    await writeFile(
      join(output, `laundry-v2-support-20260808T000000Z-${"b".repeat(24)}.json`),
      bundle("must-not-appear"),
      { mode: 0o600 },
    );
    await assert.rejects(
      () =>
        validateSupportBundles({
          configDirectory: canonicalRoot,
          secretValues: ["must-not-appear"],
          expectedCount: 2,
        }),
      (error) => error?.message === "ACCEPTANCE_SUPPORT_BUNDLE_SECRET_LEAK",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded wait reports only a sanitized diagnostic on timeout", async () => {
  const { waitForProbe } = await implementation();
  const diagnostics = [];
  let clock = 0;

  await assert.rejects(
    () =>
      waitForProbe({
        label: "API health",
        timeoutMs: 10,
        intervalMs: 1,
        probe: async () => false,
        now: () => clock,
        sleep: async () => {
          clock += 6;
        },
        diagnostic: (line) => diagnostics.push(line),
      }),
    (error) => error?.code === "ACCEPTANCE_WAIT_TIMEOUT",
  );
  assert.deepEqual(diagnostics, ["API health timed out after 10ms"]);
});
