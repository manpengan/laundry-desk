import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_APPROVER_STAFF_ID,
  BootstrapError,
  type BootstrapInput,
  type BootstrapResult,
  type CommissionInput,
  type CommissionResult,
} from "./bootstrap.js";
import {
  runBootstrapCli,
  type BootstrapCliDependencies,
  type BootstrapCliEnvironment,
} from "./bootstrap-cli.js";
import { LOCAL_PROFILE } from "./profile.js";

const DATABASE_URL = "postgresql://owner:url-secret@127.0.0.1:8543/laundry_v2";
const PASSWORD = "password-sentinel";
const PIN = "864209";
const RAW_ERROR_SECRET = "raw-error-secret";
const PHC_SECRET = "$argon2id$phc-secret";

const baseEnv = Object.freeze({
  DATABASE_ADMIN_URL: DATABASE_URL,
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "店长",
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
  LAUNDRY_BOOTSTRAP_ADMIN_PIN: PIN,
  LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: "approver",
  LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: "复核管理员",
  LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: "independent-approver-password",
  LAUNDRY_BOOTSTRAP_APPROVER_PIN: "975318",
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
    approverStaffId: BOOTSTRAP_APPROVER_STAFF_ID,
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
    approverUsername: "approver",
    approverDisplayName: "复核管理员",
    approverPassword: "independent-approver-password",
    approverPin: "975318",
    demoOnly: false,
  });
  assert.deepEqual(JSON.parse(harness.stdout.join("")), {
    status: "unchanged",
    org_id: LOCAL_PROFILE.orgId,
    store_id: LOCAL_PROFILE.storeId,
    admin_staff_id: LOCAL_PROFILE.adminStaffId,
    approver_staff_id: BOOTSTRAP_APPROVER_STAFF_ID,
    demo_only: false,
  });
});

test("bootstrap consumes setup credentials only through *_FILE inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-bootstrap-files-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const values = Object.freeze({
    DATABASE_ADMIN_URL: DATABASE_URL,
    LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
    LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "店长",
    LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
    LAUNDRY_BOOTSTRAP_ADMIN_PIN: PIN,
    LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: "approver",
    LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: "复核管理员",
    LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: "independent-approver-password",
    LAUNDRY_BOOTSTRAP_APPROVER_PIN: "975318",
  });
  const fileEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const path = join(root, name.toLowerCase());
    await writeFile(path, value, { mode: 0o600 });
    fileEnvironment[`${name}_FILE`] = path;
  }
  const harness = createHarness();
  let capturedInput: BootstrapInput | undefined;
  const code = await harness.run({
    env: Object.freeze(fileEnvironment),
    dependencies: Object.freeze({
      bootstrap: async (_url, input): Promise<BootstrapResult> => {
        capturedInput = input;
        return successResult();
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(capturedInput?.adminPassword, PASSWORD);
  assert.equal(capturedInput?.adminPin, PIN);
  assert.doesNotMatch(harness.stdout.join(""), new RegExp(`${PASSWORD}|${PIN}`, "u"));
});

test("commission consumes only the second administrator through private files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-commission-files-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const values = Object.freeze({
    DATABASE_ADMIN_URL: DATABASE_URL,
    LAUNDRY_COMMISSION_APPROVER_USERNAME: "legacy-approver",
    LAUNDRY_COMMISSION_APPROVER_DISPLAY_NAME: "复核管理员",
    LAUNDRY_COMMISSION_APPROVER_PASSWORD: "legacy-approver-password",
    LAUNDRY_COMMISSION_APPROVER_PIN: "975318",
  });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const path = join(root, name.toLowerCase());
    await writeFile(path, value, { mode: 0o600 });
    env[`${name}_FILE`] = path;
  }
  const harness = createHarness();
  let captured: CommissionInput | undefined;
  const code = await harness.run({
    argv: ["commission", "--confirm", "laundry-desk-v2-commission"],
    env,
    dependencies: Object.freeze({
      bootstrap: async (): Promise<BootstrapResult> => successResult(),
      commission: async (_url, input): Promise<CommissionResult> => {
        captured = input;
        return Object.freeze({
          status: "commissioned",
          orgId: LOCAL_PROFILE.orgId,
          storeId: LOCAL_PROFILE.storeId,
          adminStaffId: LOCAL_PROFILE.adminStaffId,
          approverStaffId: BOOTSTRAP_APPROVER_STAFF_ID,
          featureProfileVersion: 1,
        });
      },
    }),
  });
  assert.equal(code, 0);
  assert.equal(captured?.approverUsername, "legacy-approver");
  assert.equal(JSON.parse(harness.stdout.join("")).status, "commissioned");
  assert.doesNotMatch(harness.stdout.join(""), /legacy-approver-password|975318/u);
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

test("rejects every demo database query string without echoing the URL", async (t) => {
  const urls = [
    `${DATABASE_URL}?host=query-secret.example`,
    `${DATABASE_URL}?%68ost=query-secret.example`,
    `${DATABASE_URL}?host=127.0.0.1&host=query-secret.example`,
  ] as const;

  for (const databaseAdminUrl of urls) {
    await t.test(new URL(databaseAdminUrl).search, async () => {
      const harness = createHarness();
      let called = false;
      const code = await harness.run({
        argv: ["--confirm", "laundry-desk-v2-demo"],
        env: Object.freeze({
          ...baseEnv,
          DATABASE_ADMIN_URL: databaseAdminUrl,
          LAUNDRY_LOCAL_DEMO: "1",
        }),
        dependencies: Object.freeze({
          bootstrap: async (): Promise<BootstrapResult> => {
            called = true;
            return Object.freeze({ ...successResult(), demoOnly: true });
          },
        }),
      });
      const output = `${harness.stdout.join("")}${harness.stderr.join("")}`;

      assert.equal(code, 1);
      assert.equal(called, false);
      assert.equal(harness.stdout.length, 0);
      assert.equal(harness.stderr.join(""), "DEMO_DATABASE_QUERY_FORBIDDEN\n");
      assert.equal(output.includes(databaseAdminUrl), false);
      assert.equal(output.includes("query-secret"), false);
      assert.equal(output.includes("url-secret"), false);
    });
  }
});

test("preserves query strings for non-demo bootstrap", async () => {
  const databaseAdminUrl = `${DATABASE_URL}?host=query-secret.example`;
  const harness = createHarness();
  let capturedUrl: string | undefined;
  const code = await harness.run({
    env: Object.freeze({ ...baseEnv, DATABASE_ADMIN_URL: databaseAdminUrl }),
    dependencies: Object.freeze({
      bootstrap: async (url: string): Promise<BootstrapResult> => {
        capturedUrl = url;
        return successResult();
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(capturedUrl, databaseAdminUrl);
  assert.equal(harness.stderr.length, 0);
  assert.equal(harness.stdout.join("").includes(databaseAdminUrl), false);
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
