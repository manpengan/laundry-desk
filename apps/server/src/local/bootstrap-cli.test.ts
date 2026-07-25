import assert from "node:assert/strict";
import test from "node:test";

import { BootstrapError, type BootstrapInput, type BootstrapResult } from "./bootstrap.js";
import {
  runBootstrapCli,
  type BootstrapCliDependencies,
  type BootstrapCliEnvironment,
} from "./bootstrap-cli.js";
import { LOCAL_PROFILE } from "./profile.js";

const DATABASE_URL = "postgresql://owner:url-secret@127.0.0.1:8543/laundry_v2";
const PASSWORD = "password-sentinel";
const PIN = "8642";
const RAW_ERROR_SECRET = "raw-error-secret";
const PHC_SECRET = "$argon2id$phc-secret";

const baseEnv = Object.freeze({
  DATABASE_ADMIN_URL: DATABASE_URL,
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "店长",
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
  LAUNDRY_BOOTSTRAP_ADMIN_PIN: PIN,
}) satisfies BootstrapCliEnvironment;

type CliHarness = Readonly<{
  stdout: string[];
  stderr: string[];
  run: (
    options?: Readonly<{
      argv?: readonly string[];
      env?: BootstrapCliEnvironment;
      dependencies?: BootstrapCliDependencies;
    }>,
  ) => Promise<number>;
}>;

function successResult(status: "created" | "unchanged" = "created"): BootstrapResult {
  return Object.freeze({
    status,
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
    adminStaffId: LOCAL_PROFILE.adminStaffId,
    demoOnly: false,
  });
}

function createHarness(): CliHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return Object.freeze({
    stdout,
    stderr,
    run: async (options = {}): Promise<number> =>
      runBootstrapCli(
        Object.freeze({
          argv: options.argv ?? ["--confirm", "laundry-desk-v2-local"],
          env: options.env ?? baseEnv,
          stdout: (text: string): void => {
            stdout.push(text);
          },
          stderr: (text: string): void => {
            stderr.push(text);
          },
        }),
        options.dependencies ??
          Object.freeze({
            bootstrap: async (): Promise<BootstrapResult> => successResult(),
          }),
      ),
  });
}

test("runs non-demo bootstrap only after the exact local confirmation", async () => {
  const harness = createHarness();
  const calls: Array<Readonly<{ databaseAdminUrl: string; input: BootstrapInput }>> = [];

  const exitCode = await harness.run({
    dependencies: Object.freeze({
      bootstrap: async (
        databaseAdminUrl: string,
        input: BootstrapInput,
      ): Promise<BootstrapResult> => {
        calls.push(Object.freeze({ databaseAdminUrl, input }));
        return successResult("unchanged");
      },
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(harness.stderr.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.databaseAdminUrl, DATABASE_URL);
  assert.deepEqual(calls[0]?.input, {
    profile: LOCAL_PROFILE,
    adminUsername: "admin",
    adminDisplayName: "店长",
    adminPassword: PASSWORD,
    adminPin: PIN,
    demoOnly: false,
  });
  assert.deepEqual(JSON.parse(harness.stdout.join("")), {
    status: "unchanged",
    org_id: LOCAL_PROFILE.orgId,
    store_id: LOCAL_PROFILE.storeId,
    admin_staff_id: LOCAL_PROFILE.adminStaffId,
    demo_only: false,
  });
});

test("allows demo bootstrap only with flag, exact demo confirmation, and loopback database", async () => {
  const harness = createHarness();
  let capturedInput: BootstrapInput | undefined;

  const exitCode = await harness.run({
    argv: ["--confirm", "laundry-desk-v2-demo"],
    env: Object.freeze({ ...baseEnv, LAUNDRY_LOCAL_DEMO: "1" }),
    dependencies: Object.freeze({
      bootstrap: async (
        _databaseAdminUrl: string,
        input: BootstrapInput,
      ): Promise<BootstrapResult> => {
        capturedInput = input;
        return Object.freeze({ ...successResult(), demoOnly: true });
      },
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(capturedInput?.demoOnly, true);
  assert.equal(JSON.parse(harness.stdout.join("")).demo_only, true);
});

test("rejects unknown argv, missing env, wrong confirmation, and remote demo database", async (t) => {
  const cases: ReadonlyArray<
    Readonly<{
      name: string;
      argv?: readonly string[];
      env?: BootstrapCliEnvironment;
      expected: RegExp;
    }>
  > = [
    {
      name: "unknown argv",
      argv: ["--confirm", "laundry-desk-v2-local", "--force"],
      expected: /^ARGS_INVALID\n$/u,
    },
    {
      name: "missing env",
      env: Object.freeze({
        ...baseEnv,
        LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: undefined,
      }),
      expected: /^LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: /u,
    },
    {
      name: "wrong local confirmation",
      argv: ["--confirm", "yes"],
      expected: /^CONFIRMATION_REQUIRED\n$/u,
    },
    {
      name: "remote demo database",
      argv: ["--confirm", "laundry-desk-v2-demo"],
      env: Object.freeze({
        ...baseEnv,
        DATABASE_ADMIN_URL: "postgresql://owner:secret@db.example.test:5432/laundry_v2",
        LAUNDRY_LOCAL_DEMO: "1",
      }),
      expected: /^DEMO_DATABASE_NOT_LOOPBACK\n$/u,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = createHarness();
      let called = false;
      const code = await harness.run({
        ...(entry.argv === undefined ? {} : { argv: entry.argv }),
        ...(entry.env === undefined ? {} : { env: entry.env }),
        dependencies: Object.freeze({
          bootstrap: async (): Promise<BootstrapResult> => {
            called = true;
            return successResult();
          },
        }),
      });

      assert.equal(code, 1);
      assert.equal(called, false);
      assert.equal(harness.stdout.length, 0);
      assert.match(harness.stderr.join(""), entry.expected);
    });
  }
});

test("prints stable BootstrapError codes and sanitizes unknown database failures", async (t) => {
  await t.test("typed bootstrap conflict", async () => {
    const harness = createHarness();
    const code = await harness.run({
      dependencies: Object.freeze({
        bootstrap: async (): Promise<BootstrapResult> => {
          throw new BootstrapError("BOOTSTRAP_STATE_CONFLICT");
        },
      }),
    });

    assert.equal(code, 1);
    assert.equal(harness.stdout.length, 0);
    assert.equal(harness.stderr.join(""), "BOOTSTRAP_STATE_CONFLICT\n");
  });

  await t.test("unknown database error", async () => {
    const harness = createHarness();
    const code = await harness.run({
      dependencies: Object.freeze({
        bootstrap: async (): Promise<BootstrapResult> => {
          throw new Error(`${RAW_ERROR_SECRET} ${PHC_SECRET} ${DATABASE_URL}`);
        },
      }),
    });
    const combined = `${harness.stdout.join("")}${harness.stderr.join("")}`;

    assert.equal(code, 1);
    assert.equal(harness.stdout.length, 0);
    assert.equal(harness.stderr.join(""), "BOOTSTRAP_FAILED\n");
    for (const secret of [PASSWORD, PIN, PHC_SECRET, DATABASE_URL, RAW_ERROR_SECRET]) {
      assert.equal(combined.includes(secret), false);
    }
  });
});
