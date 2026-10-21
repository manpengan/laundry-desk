import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { platform } from "./backup-test-fixture.mjs";
import {
  STORE_INITIALIZATION_FILES,
  requireManifest,
  supportsStoreInitialization,
} from "./companion-contract.mjs";
import { readDataOptions } from "./data-options.mjs";
import { bootstrapSecretNames, runtimeEnvironment } from "./lifecycle-environment.mjs";
import { initializeDatabase, initializeSecrets } from "./lifecycle-database.mjs";
import { installFreshRuntime } from "./lifecycle-install.mjs";
import { exists, storage } from "./lifecycle-storage.mjs";
import { runtimeEntryFixture } from "./runtime-entry-test-fixture.mjs";
import {
  clearStoreInput,
  requireFreshStore,
  requireStoreInput,
  validateStoreInput,
  withStoreInput,
} from "./store-initialization.mjs";

const input = () => ({
  version: 1,
  mode: "new_empty",
  admin: {
    username: "synthetic-owner",
    displayName: "合成店长",
    password: "Synthetic-owner-2026-only",
    pin: "391742",
  },
  approver: {
    username: "synthetic-reviewer",
    displayName: "合成复核员",
    password: "Synthetic-reviewer-2026-only",
    pin: "830219",
  },
});
const flatInput = () =>
  Object.fromEntries(
    ["admin", "approver"].flatMap((role) =>
      Object.entries(input()[role]).map(([field, value]) => [
        role + field[0].toUpperCase() + field.slice(1),
        value,
      ]),
    ),
  );
const capabilities = { files: STORE_INITIALIZATION_FILES.map((path) => ({ path })) };
const builtApps = fileURLToPath(new URL("../../apps", import.meta.url));
const builtSchema = await exists(join(builtApps, "server/dist/local/bootstrap-model.js"));

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ld-store-init-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, io: storage(platform), platform };
}

test("store wire input is bounded UTF-8, exact fields, and never includes authority or confirmation copies", async () => {
  const bytes = Buffer.from(JSON.stringify(input()));
  assert.deepEqual(await readDataOptions("install-store", Readable.from([bytes])), input());
  assert.ok(bytes.every((byte) => byte === 0));
  for (const changed of [
    null,
    { ...input(), assurance: "production" },
    { ...input(), mode: "reset" },
    { ...input(), admin: { ...input().admin, passwordConfirmation: "never-on-wire" } },
    { ...input(), approver: { ...input().approver, username: null } },
    { ...input(), admin: { ...input().admin, displayName: "line\nbreak" } },
  ]) {
    assert.throws(() => requireStoreInput(changed), {
      message: "WINDOWS_COMPANION_STORE_INPUT_INVALID",
    });
  }
  for (const bytes of [Buffer.alloc(8193, 65), Buffer.from([0xff]), Buffer.from("{")])
    await assert.rejects(readDataOptions("install-store", Readable.from([bytes])), /ARGS_INVALID/u);
});

test(
  "the trusted server schema validates both independent identities without returning secret values on error",
  {
    skip: builtSchema
      ? false
      : "server build required; packaging/native acceptance validates the built schema",
  },
  async () => {
    const valid = await validateStoreInput(builtApps, capabilities, input());
    assert.equal(valid.demoOnly, false);
    assert.equal(valid.adminDisplayName, "合成店长");
    const badFields = {
      username: ["", "bad/name", "a".repeat(65)],
      displayName: [" ", "a".repeat(81)],
      password: ["short", "a".repeat(257), "line\nbreak-is-invalid"],
      pin: ["12345", "123456789", "abcdef"],
    };
    for (const role of ["admin", "approver"])
      for (const [field, values] of Object.entries(badFields))
        for (const value of values) {
          const changed = { ...input(), [role]: { ...input()[role], [field]: value } };
          await assert.rejects(validateStoreInput(builtApps, capabilities, changed), {
            message: "WINDOWS_COMPANION_STORE_INPUT_INVALID",
          });
        }
    for (const field of ["username", "password", "pin"])
      await assert.rejects(
        validateStoreInput(builtApps, capabilities, {
          ...input(),
          approver: { ...input().approver, [field]: input().admin[field] },
        }),
        { message: "WINDOWS_COMPANION_STORE_INPUT_INVALID" },
      );
    await assert.rejects(
      validateStoreInput(builtApps, { files: [] }, input()),
      /STORE_INITIALIZATION_UNAVAILABLE/u,
    );
  },
);

test("initialization capability is additive; partial new payloads and production relabels are rejected", async (t) => {
  const { manifest } = await runtimeEntryFixture(t);
  assert.equal(supportsStoreInitialization(manifest), false);
  assert.equal(requireManifest(manifest), manifest);
  const entry = { path: STORE_INITIALIZATION_FILES[0], size: 1, sha256: "a".repeat(64) };
  // Manifest canonical order is byte order, independent of the host locale.
  const partial = {
    ...manifest,
    files: [...manifest.files, entry].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
  assert.throws(() => requireManifest(partial), /STORE_INITIALIZATION_CAPABILITY_INCOMPLETE/u);
  assert.throws(
    () => requireManifest({ ...manifest, assurance: "production" }),
    /MANIFEST_INVALID/u,
  );
});

test("operator initialization rejects every existing instance and never offers conversion or reset", async (t) => {
  const { root, io } = await fixture(t);
  for (const name of ["postgres-data", "photos", "backups"]) {
    await io.directory(join(root, name));
    await io.write(join(root, name, "retained"), "existing-store-value");
  }
  assert.throws(() => requireFreshStore("install-store", true), /STORE_REQUIRES_NEW_INSTANCE/u);
  assert.doesNotThrow(() => requireFreshStore("install", true));
  assert.doesNotThrow(() => requireFreshStore("install-store", false));
  for (const name of ["postgres-data", "photos", "backups"])
    assert.equal(await readFile(join(root, name, "retained"), "utf8"), "existing-store-value");
});

test("one-time files use private storage and are removed after successful or failed bootstrap", async (t) => {
  const context = await fixture(t);
  for (const failure of [false, true]) {
    const operation = withStoreInput(
      context.root,
      flatInput(),
      context.io,
      platform,
      async (directory) => {
        for (const file of Object.values(bootstrapSecretNames))
          await platform.inspectPrivateFile(join(directory, file));
        assert.equal(
          await context.io.read(
            join(directory, bootstrapSecretNames.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD),
          ),
          input().admin.password,
        );
        if (failure) throw new Error("SYNTHETIC_BOOTSTRAP_FAILURE");
        return "verified";
      },
    );
    if (failure) await assert.rejects(operation, /SYNTHETIC_BOOTSTRAP_FAILURE/u);
    else assert.equal(await operation, "verified");
    assert.equal(await exists(join(context.root, "bootstrap-input")), false);
  }
});

test("interrupted private writes clean their temporary credentials; unknown files and hardlinks fail closed", async (t) => {
  const context = await fixture(t);
  const directory = join(context.root, "bootstrap-input");
  const failingIo = {
    ...context.io,
    write: async (path, value) => {
      await context.io.write(
        join(directory, ".commit-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        value,
      );
      throw new Error("SYNTHETIC_WRITE_FAILURE");
    },
  };
  await assert.rejects(
    withStoreInput(context.root, flatInput(), failingIo, platform, () =>
      assert.fail("bootstrap ran"),
    ),
    /SYNTHETIC_WRITE_FAILURE/u,
  );
  assert.equal(await exists(directory), false);
  await context.io.directory(directory);
  await context.io.write(join(directory, "unexpected"), "preserve-unknown-value");
  await assert.rejects(clearStoreInput(context.root, platform), /STORE_INPUT_CLEANUP_FAILED/u);
  assert.equal(await readFile(join(directory, "unexpected"), "utf8"), "preserve-unknown-value");
  await rm(join(directory, "unexpected"));
  const file = join(directory, bootstrapSecretNames.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD);
  await context.io.write(file, "synthetic-secret");
  await link(file, join(context.root, "alias"));
  await assert.rejects(clearStoreInput(context.root, platform), /STORE_INPUT_CLEANUP_FAILED/u);
  assert.equal(await readFile(join(context.root, "alias"), "utf8"), "synthetic-secret");
});

async function installFixture(t, failure) {
  const context = await fixture(t);
  const events = [],
    states = [];
  const manifest = {
    ...capabilities,
    runtime_release: "0.1.0-win-dev",
    source_git_sha: "b".repeat(40),
    migrations_sha256: "c".repeat(64),
    migration_head: "0001_initial.sql",
  };
  const payload = join(context.root, "payload");
  await context.io.directory(payload);
  await context.io.directory(join(payload, "metadata"));
  await context.io.write(join(payload, "metadata/contracts.json"), "{}");
  await context.io.write(join(payload, "metadata/schema.md"), "synthetic-schema");
  const request = {
    ...context,
    source: payload,
    expectedDigest: "a".repeat(64),
    save: async (state) => {
      states.push(state);
    },
    task: async () => {
      events.push("task");
    },
    start: async () => {
      events.push("start");
      assert.equal(await exists(join(context.root, "bootstrap-input")), false);
    },
  };
  const dependencies = {
    stageRelease: async () => ({ payload, manifest }),
    initializeDatabase: async (root, source, bound, io, platform, options) => {
      events.push("database");
      if (options) {
        assert.equal(options.requireCommissioned, true);
        assert.equal(
          await io.read(
            join(
              options.bootstrapDirectory,
              bootstrapSecretNames.LAUNDRY_BOOTSTRAP_APPROVER_USERNAME,
            ),
          ),
          input().approver.username,
        );
      }
      if (failure) throw new Error("SYNTHETIC_COMMISSION_VERIFY_FAILURE");
    },
  };
  return { ...context, request, dependencies, events, states, payload, manifest };
}

test("explicit empty-store install starts only after verification and cleanup; normal startup needs no personal credentials", async (t) => {
  const context = await installFixture(t, false);
  await installFreshRuntime(context.request, flatInput(), context.dependencies);
  assert.deepEqual(context.events, ["database", "task", "start"]);
  assert.deepEqual(
    context.states.map(({ phase }) => phase),
    ["staged", "initialized", "stopped"],
  );
  assert.equal(
    context.states.every(({ schema }) => schema === 2),
    true,
  );
  const secretFiles = await readdir(join(context.root, "secrets"));
  assert.equal(
    secretFiles.some((name) => name.startsWith("laundry-bootstrap-")),
    false,
  );
  const persisted =
    JSON.stringify(context.states) +
    (
      await Promise.all(
        secretFiles.map((file) => readFile(join(context.root, "secrets", file), "utf8")),
      )
    ).join("\n");
  for (const value of Object.values(flatInput())) assert.equal(persisted.includes(value), false);
  const before = process.env.SystemRoot;
  process.env.SystemRoot = before ?? "C:\\Windows";
  t.after(() => {
    if (before === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = before;
  });
  const env = await runtimeEnvironment(context.root, context.payload, context.manifest, context.io);
  assert.equal(
    Object.keys(env).some((key) => key.startsWith("LAUNDRY_BOOTSTRAP_")),
    false,
  );
  assert.equal(
    context.states.every(({ assurance }) => assurance === "development_only"),
    true,
  );
});

test("failed commissioning leaves staged recovery evidence, removes inputs and never reports initialized or starts", async (t) => {
  const context = await installFixture(t, true);
  await assert.rejects(
    installFreshRuntime(context.request, flatInput(), context.dependencies),
    /SYNTHETIC_COMMISSION_VERIFY_FAILURE/u,
  );
  assert.deepEqual(context.events, ["database"]);
  assert.deepEqual(
    context.states.map(({ phase }) => phase),
    ["staged"],
  );
  assert.equal(context.states[0].schema, 2);
  assert.equal(await exists(join(context.root, "bootstrap-input")), false);
});

test("default install still generates independent synthetic identities for the existing harness", async (t) => {
  const context = await installFixture(t, false);
  await installFreshRuntime(context.request, null, context.dependencies);
  assert.equal(
    context.states.every(({ schema }) => schema === 1),
    true,
  );
  const secret = (role, field) =>
    context.io.read(
      join(context.root, "secrets", bootstrapSecretNames[`LAUNDRY_BOOTSTRAP_${role}_${field}`]),
    );
  assert.equal(await secret("ADMIN", "USERNAME"), "admin-win-dev");
  assert.equal(await secret("APPROVER", "USERNAME"), "approver-win-dev");
  assert.notEqual(await secret("ADMIN", "PASSWORD"), await secret("APPROVER", "PASSWORD"));
  assert.notEqual(await secret("ADMIN", "PIN"), await secret("APPROVER", "PIN"));
});

test("credential cleanup failure never advances staged state, registers tasks or starts services", async (t) => {
  const context = await installFixture(t, false);
  const dependencies = {
    ...context.dependencies,
    initializeDatabase: async (root, source, bound, io, platform, options) => {
      await io.write(join(options.bootstrapDirectory, "unexpected"), "synthetic-unowned-content");
    },
  };
  await assert.rejects(installFreshRuntime(context.request, flatInput(), dependencies), {
    message: "WINDOWS_COMPANION_STORE_INPUT_CLEANUP_FAILED",
  });
  assert.deepEqual(context.events, []);
  assert.deepEqual(
    context.states.map(({ phase }) => phase),
    ["staged"],
  );
  await rm(join(context.root, "bootstrap-input/unexpected"));
  await clearStoreInput(context.root, platform);
  assert.equal(await exists(join(context.root, "bootstrap-input")), false);
});

for (const kind of ["synthetic", "operator", "verify-failure"]) {
  test(`${kind} database pipeline uses file references and always stops PostgreSQL after commissioning`, async (t) => {
    const context = await installFixture(t, false);
    const previous = process.env.SystemRoot;
    process.env.SystemRoot = previous ?? "C:\\Windows";
    t.after(() => {
      if (previous === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previous;
    });
    await initializeSecrets(context.root, context.io, {
      syntheticIdentities: kind === "synthetic",
    });
    const calls = [];
    const dependencies = {
      run: async (file, args, env) => {
        for (const value of Object.values(flatInput()))
          assert.equal(JSON.stringify({ args, env }).includes(value), false);
        if (file.endsWith("initdb.exe"))
          await context.io.directory(join(context.root, "postgres-data"));
      },
      pgControl: async (verb) => {
        calls.push(`pg-${verb}`);
      },
      kit: async (payload, name, env) => {
        calls.push(name);
        assert.equal(env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD, undefined);
        assert.equal(
          await context.io.read(env.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME_FILE),
          kind === "synthetic" ? "admin-win-dev" : input().admin.username,
        );
        if (kind === "verify-failure" && name === "verify-commissioned")
          throw new Error("SYNTHETIC_STRICT_VERIFY_FAILED");
      },
    };
    const initialize = (bootstrapDirectory) =>
      initializeDatabase(
        context.root,
        context.payload,
        context.manifest,
        context.io,
        platform,
        kind === "synthetic" ? {} : { bootstrapDirectory, requireCommissioned: true },
        dependencies,
      );
    if (kind === "synthetic") await initialize();
    else {
      const operation = withStoreInput(context.root, flatInput(), context.io, platform, initialize);
      if (kind === "verify-failure")
        await assert.rejects(operation, /SYNTHETIC_STRICT_VERIFY_FAILED/u);
      else await operation;
      assert.equal(await exists(join(context.root, "bootstrap-input")), false);
    }
    assert.deepEqual(calls, [
      "pg-start",
      "roles",
      "migrate",
      "bootstrap",
      kind === "synthetic" ? "verify" : "verify-commissioned",
      "pg-stop",
    ]);
  });
}
