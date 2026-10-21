import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  STORE_INITIALIZATION_FILES,
  digest,
  supportsStoreInitialization,
} from "./companion-contract.mjs";
import {
  requireNoBootstrapInputs,
  requireNoInputLogs,
  requireStoreInitializationInvariant,
  runtimeSecretDigest,
  storeInitializationAcceptance,
  syntheticStoreInput,
  verifyStoreIdentities,
  verifyStoreLogin,
} from "./store-initialization-acceptance.mjs";

async function fixture(t, change = {}) {
  const root = await mkdtemp(join(tmpdir(), "ld-init-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "secrets"));
  await mkdir(join(root, "logs"));
  await writeFile(join(root, "logs/postgres.log"), "synthetic startup ready");
  await writeFile(join(root, "secrets/runtime-secret"), "synthetic-running-key");
  await writeFile(join(root, "state.json"), '{"schema":2,"phase":"running"}');
  const events = [],
    reports = [];
  let installed = false;
  const context = {
    root,
    payload: root,
    io: { read: (path) => readFile(path, "utf8") },
    manifest: { files: STORE_INITIALIZATION_FILES.map((path) => ({ path })) },
    scenario: async (name, action) => {
      await action();
      reports.push({ name, status: "passed" });
    },
    command: async (action, source, sha, input) => {
      events.push(action);
      assert.equal(action, "install-store");
      assert.equal(source, undefined);
      assert.equal(sha, undefined);
      assert.equal(input.mode, "new_empty");
      if (installed)
        throw Object.assign(new Error("synthetic refusal"), {
          stderr: "WINDOWS_COMPANION_STORE_REQUIRES_NEW_INSTANCE\n",
        });
      installed = true;
      return {
        status: "running",
        initialization: "operator_new_empty",
        admission: "pending",
        assurance: "development_only",
      };
    },
    load: async (name) => {
      if (name === "companion-contract.mjs") return { supportsStoreInitialization };
      if (name === "lifecycle-environment.mjs") return { runtimeEnvironment: async () => ({}) };
      if (name === "lifecycle-database.mjs")
        return {
          kit: async (payload, action) => {
            events.push(action);
            return '{"commission_required":false}';
          },
        };
      assert.fail("unexpected payload dependency");
    },
    sql: async (statement) => {
      events.push(statement);
      return statement === "SHOW data_checksums"
        ? "on"
        : statement === "SHOW password_encryption"
          ? "scram-sha-256"
          : "2";
    },
    secretDigest: () => runtimeSecretDigest(root, digest),
    ...change,
  };
  return { context, events, reports };
}

test("random fixture inputs meet the independent two-identity wire contract and are not returned in reports", async (t) => {
  const first = syntheticStoreInput(),
    second = syntheticStoreInput();
  for (const input of [first, second]) {
    assert.equal(input.mode, "new_empty");
    for (const person of [input.admin, input.approver]) {
      assert.equal(/^[A-Za-z0-9_.-]{1,64}$/u.test(person.username), true);
      assert.ok(person.password.length >= 12);
      assert.equal(/^[0-9]{8}$/u.test(person.pin), true);
    }
    for (const field of ["username", "password", "pin"])
      assert.equal(input.admin[field] !== input.approver[field], true);
  }
  assert.equal(first.admin.password !== second.admin.password, true);
  const { context, events, reports } = await fixture(t);
  let captured;
  const result = await storeInitializationAcceptance(context, {
    verifyIdentities: async (_context, input) => {
      captured = input;
      events.push("real-identities");
    },
  });
  assert.equal(result, await context.secretDigest());
  assert.deepEqual(events.slice(0, 6), [
    "install-store",
    "verify-commissioned",
    "commission-status",
    "real-identities",
    "SHOW data_checksums",
    "SHOW password_encryption",
  ]);
  assert.deepEqual(
    reports.map(({ name }) => name),
    [
      "install-store-real-database-and-independent-identities",
      "existing-store-refuses-reinitialization-without-mutation",
    ],
  );
  for (const value of [...Object.values(captured.admin), ...Object.values(captured.approver)])
    assert.equal(JSON.stringify(reports).includes(value), false);
});

test("old or partial capability is rejected before creating any database or report", async (t) => {
  for (const files of [[], [{ path: STORE_INITIALIZATION_FILES[0] }]]) {
    const { context, reports, events } = await fixture(t, { manifest: { files } });
    await assert.rejects(storeInitializationAcceptance(context), {
      message: "WINDOWS_COMPANION_STORE_ACCEPTANCE_CAPABILITY_REQUIRED",
    });
    assert.deepEqual(reports, []);
    assert.deepEqual(events, []);
  }
});

test("residual input directories and any bootstrap credential file fail the cumulative lifecycle guard", async (t) => {
  const { context } = await fixture(t);
  await requireNoBootstrapInputs(context.root);
  await mkdir(join(context.root, "bootstrap-input"));
  await assert.rejects(requireNoBootstrapInputs(context.root), /INPUT_RETAINED/u);
  await rm(join(context.root, "bootstrap-input"), { recursive: true });
  for (const role of ["admin", "approver"])
    for (const field of ["username", "display-name", "password", "pin"]) {
      const path = join(context.root, "secrets", `laundry-bootstrap-${role}-${field}`);
      await writeFile(path, "synthetic-do-not-publish");
      await assert.rejects(requireNoBootstrapInputs(context.root), /CREDENTIAL_FILE_RETAINED/u);
      await rm(path);
    }
});

test("every initialized lifecycle phase retains operator-only state schema 2", async (t) => {
  const { context } = await fixture(t);
  for (const phase of ["initialized", "stopped", "running", "uninstalled"]) {
    await writeFile(join(context.root, "state.json"), JSON.stringify({ schema: 2, phase }));
    await requireStoreInitializationInvariant(context.root, context.io);
  }
  for (const schema of [0, 1, 3, "2", null]) {
    await writeFile(join(context.root, "state.json"), JSON.stringify({ schema, phase: "running" }));
    await assert.rejects(requireStoreInitializationInvariant(context.root, context.io), {
      message: "WINDOWS_COMPANION_STORE_ACCEPTANCE_STATE_SCHEMA_INVALID",
    });
  }
});

test("missing commissioning, false success and raw private failures never produce a passed scenario", async (t) => {
  for (const variant of ["success-shape", "commission", "private-error"]) {
    const { context, reports } = await fixture(t);
    const changed =
      variant === "success-shape"
        ? { command: async () => ({ status: "running" }) }
        : variant === "commission"
          ? {
              load: async (name) =>
                name === "lifecycle-database.mjs"
                  ? { kit: async () => '{"commission_required":true}' }
                  : context.load(name),
            }
          : {};
    await assert.rejects(
      storeInitializationAcceptance(
        { ...context, ...changed },
        {
          verifyIdentities: async () => {
            throw new Error("synthetic-private-password-must-not-escape");
          },
        },
      ),
      (error) => {
        assert.match(error.message, /^WINDOWS_COMPANION_STORE_ACCEPTANCE_[A-Z_]+$/u);
        assert.equal(JSON.stringify(error).includes("synthetic-private"), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.deepEqual(reports, []);
  }
});

test("a refused reinstall cannot alter state, runtime secret contents or names, or the existing SQL probe", async (t) => {
  for (const mutation of ["state", "secret", "secret-name", "probe"]) {
    const { context, reports } = await fixture(t);
    let calls = 0;
    const command = async (...args) => {
      calls++;
      if (calls === 2 && mutation === "secret-name")
        await rename(
          join(context.root, "secrets/runtime-secret"),
          join(context.root, "secrets/renamed"),
        );
      else if (calls === 2 && mutation !== "probe")
        await writeFile(
          join(context.root, mutation === "state" ? "state.json" : "secrets/runtime-secret"),
          "synthetic-tampering",
        );
      return context.command(...args);
    };
    await assert.rejects(
      storeInitializationAcceptance(
        {
          ...context,
          command,
          sql: async (statement) =>
            mutation === "probe" && statement.startsWith("SELECT count")
              ? "0"
              : context.sql(statement),
        },
        { verifyIdentities: async () => {} },
      ),
      /EXISTING_(?:ROOT|DATABASE)_CHANGED/u,
    );
    assert.equal(reports.length, 1);
  }
});

test("private values in runtime logs fail without publishing filenames or file content", async (t) => {
  const { context } = await fixture(t);
  const input = syntheticStoreInput();
  for (const value of [...Object.values(input.admin), ...Object.values(input.approver)]) {
    await writeFile(join(context.root, "logs/postgres.log"), `synthetic unexpected echo: ${value}`);
    await assert.rejects(requireNoInputLogs(context.root, input), {
      message: "WINDOWS_COMPANION_STORE_ACCEPTANCE_INPUT_LOGGED",
    });
  }
  await writeFile(join(context.root, "logs/postgres.log"), "x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(requireNoInputLogs(context.root, input), /LOG_FILE_INVALID/u);
});

test("identity verification binds both active admin/privacy roles and verifies each password and PIN", async () => {
  const input = syntheticStoreInput();
  const profile = { orgId: "org", storeId: "store" };
  for (const failure of [null, "password", "pin", "role", "inactive", "hash", "count"]) {
    const rows = [input.admin, input.approver].map((person, i) => ({
      id: String(i),
      username: person.username,
      display_name: person.displayName,
      password_hash: `$argon2id$password-${i}`,
      pin_hash: `$argon2id$pin-${i}`,
      is_active: !(failure === "inactive" && i === 1),
    }));
    if (failure === "hash") rows[1].pin_hash = "plaintext-is-rejected";
    const roles = rows.map((row) => ({
      staff_id: row.id,
      role: failure === "role" ? "staff" : "admin",
      is_active: true,
      is_privacy_admin: true,
    }));
    const checked = [],
      logged = [];
    let ended = false;
    const tools = {
      profile,
      pool: {
        query: async (sql, args) => {
          assert.deepEqual(args, sql.includes("staff_store_roles") ? ["org", "store"] : ["org"]);
          return {
            rows: sql.includes("staff_store_roles")
              ? roles
              : failure === "count"
                ? rows.slice(0, 1)
                : rows,
          };
        },
        end: async () => {
          ended = true;
        },
      },
      passwordPort: {
        verifyPassword: async (value, hash) => {
          checked.push(hash);
          const i = Number(hash.slice(-1)),
            field = hash.includes("password") ? "password" : "pin";
          return value === [input.admin, input.approver][i][field] && failure !== field;
        },
      },
    };
    const work = verifyStoreIdentities({}, input, {
      databaseTools: async () => tools,
      login: async (person, id) => logged.push(id),
    });
    if (failure) await assert.rejects(work, /^Error: WINDOWS_COMPANION_STORE_ACCEPTANCE_[A-Z_]+$/u);
    else {
      await work;
      assert.equal(checked.length, 4);
      assert.deepEqual(logged, ["0", "1"]);
    }
    assert.equal(ended, true);
  }
});

test("real login probe uses only fixed loopback POST and rejects wrong identity, role or missing session", async () => {
  const person = syntheticStoreInput().admin;
  const profile = { orgId: "org", storeId: "store", orgCode: "local", storeCode: "main" };
  for (const failure of [null, "staff", "role", "status", "oversized"]) {
    const request = async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8787/api/v2/auth/login");
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "POST");
      const data = JSON.parse(options.body);
      assert.equal(data.password === person.password, true);
      assert.equal(data.username === person.username, true);
      const body = {
        ok: true,
        data: {
          role: failure === "role" ? "staff" : "admin",
          storage: "memory_only",
          session: {
            staff_id: failure === "staff" ? "other" : "expected",
            org_id: "org",
            store_id: "store",
            device_id: data.device_id,
          },
          display: { staff_name: person.displayName },
          access_token: "synthetic-token-only",
        },
      };
      return new Response(failure === "oversized" ? "x".repeat(65537) : JSON.stringify(body), {
        status: failure === "status" ? 403 : 200,
      });
    };
    if (failure)
      await assert.rejects(
        verifyStoreLogin(person, "expected", profile, request),
        /STORE_ACCEPTANCE_LOGIN_/u,
      );
    else await verifyStoreLogin(person, "expected", profile, request);
  }
});
