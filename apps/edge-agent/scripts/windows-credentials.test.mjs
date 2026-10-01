import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { securePrivateDirectory, securePrivateFile } from "@laundry/platform-fs";
import {
  fillWindowsCredential,
  loadWindowsBootstrapCredentials,
  loadWindowsFunctionalAccount,
  loadWindowsRuntimeCredentials,
} from "../e2e/windows-credentials.mjs";

const INVALID = Object.freeze({ message: /^Windows Runtime credential handoff is invalid$/u });
const VALUES = Object.freeze({
  development_only: true,
  admin_username: "admin-win-dev",
  admin_display_name: "Windows Dev ADMIN",
  admin_password: "synthetic-test-admin-password",
  admin_pin: "123456",
  approver_display_name: "Windows Dev APPROVER",
  approver_pin: "654321",
});
const FUNCTIONAL_VALUES = Object.freeze({
  development_only: true,
  org_code: "local",
  store_code: "main",
  role: "admin",
  privacy_admin: false,
  username: "codex-qa-synthetic",
  display_name: "Codex Synthetic QA",
  password: "synthetic-functional-password",
  pin: "123456",
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-win-credentials-test-")));
  await securePrivateDirectory(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, "secrets");
  await mkdir(secrets);
  await securePrivateDirectory(secrets);
  const legacy = join(root, "development-credentials.json");
  await privateFile(legacy, JSON.stringify(VALUES));
  for (const [name, value] of Object.entries(VALUES)) {
    if (name !== "development_only") await privateFile(companionFile(secrets, name), value);
  }
  return Object.freeze({ root, secrets, legacy });
}

async function privateFile(path, value) {
  await writeFile(path, value, { mode: 0o600 });
  await securePrivateFile(path);
}

function companionFile(directory, name) {
  return join(directory, `laundry-bootstrap-${name.replaceAll("_", "-")}`);
}

const companionEnvironment = (path) => Object.freeze({ LAUNDRY_WINDOWS_RUNTIME_SECRETS_DIR: path });
const legacyEnvironment = (path) =>
  Object.freeze({ LAUNDRY_WINDOWS_RUNTIME_CREDENTIALS_FILE: path });

test("Windows credential journeys disable automatic failure snapshots and recording", async () => {
  for (const filename of [
    "playwright.electron.windows-runtime.config.ts",
    "playwright.electron.windows-functional.config.ts",
  ]) {
    const config = await readFile(new URL(`../${filename}`, import.meta.url), "utf8");
    assert.match(config, /process\.env\.PLAYWRIGHT_NO_COPY_PROMPT\s*=\s*"1";/u);
    assert.match(config, /trace:\s*"off"/u);
    assert.match(config, /screenshot:\s*"off"/u);
    assert.match(config, /video:\s*"off"/u);
  }
});

test("credential fills pass through in memory and remove secret-bearing action diagnostics on failure", async () => {
  let received;
  await fillWindowsCredential(
    {
      fill: async (value) => {
        received = value;
      },
    },
    VALUES.admin_password,
  );
  assert.equal(received, VALUES.admin_password);
  await assert.rejects(
    fillWindowsCredential(
      {
        fill: async () => {
          throw new Error(`fill(${VALUES.admin_password}) timed out`);
        },
      },
      VALUES.admin_password,
    ),
    (error) => {
      assert.equal(error.message, "Windows credential input is unavailable");
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes(VALUES.admin_password), false);
      return true;
    },
  );
});

test("companion files support Runtime login and functional bootstrap without creating a handoff copy", async (t) => {
  const { secrets } = await fixture(t);
  const before = await readdir(secrets);
  const runtime = await loadWindowsRuntimeCredentials(companionEnvironment(secrets));
  assert.deepEqual(runtime, {
    privateRoot: secrets,
    adminUsername: VALUES.admin_username,
    adminDisplayName: VALUES.admin_display_name,
    adminPassword: VALUES.admin_password,
  });
  assert.equal(Object.isFrozen(runtime), true);
  const bootstrap = await loadWindowsBootstrapCredentials(companionEnvironment(secrets));
  assert.deepEqual(bootstrap, {
    ...runtime,
    adminPin: VALUES.admin_pin,
    approverDisplayName: VALUES.approver_display_name,
    approverPin: VALUES.approver_pin,
  });
  assert.equal(Object.isFrozen(bootstrap), true);
  assert.deepEqual(await readdir(secrets), before);
});

test("legacy development JSON remains supported with its private Runtime root", async (t) => {
  const { root, legacy } = await fixture(t);
  const runtime = await loadWindowsRuntimeCredentials(legacyEnvironment(legacy));
  const bootstrap = await loadWindowsBootstrapCredentials(legacyEnvironment(legacy));
  assert.equal(runtime.adminUsername, VALUES.admin_username);
  assert.equal(runtime.privateRoot, root);
  assert.equal(bootstrap.approverPin, VALUES.approver_pin);
});

test("functional accounts load from private files and only a missing account requests creation", async (t) => {
  const { secrets } = await fixture(t);
  const path = join(secrets, "functional-account.json");
  assert.equal(await loadWindowsFunctionalAccount(path), null);
  await privateFile(path, JSON.stringify(FUNCTIONAL_VALUES));
  assert.deepEqual(await loadWindowsFunctionalAccount(path), {
    username: FUNCTIONAL_VALUES.username,
    displayName: FUNCTIONAL_VALUES.display_name,
    password: FUNCTIONAL_VALUES.password,
    pin: FUNCTIONAL_VALUES.pin,
  });
  await assert.rejects(loadWindowsFunctionalAccount("relative-account.json"), INVALID);
});

test("malformed or inappropriate functional account files fail without disclosing stored credentials", async (t) => {
  const { secrets } = await fixture(t);
  const path = join(secrets, "functional-account.json");
  for (const contents of [
    `{"password":${FUNCTIONAL_VALUES.password}}`,
    "null",
    "[]",
    "a".repeat(8193),
    ...[
      { development_only: false },
      { org_code: "other" },
      { store_code: "other" },
      { role: "clerk" },
      { privacy_admin: true },
      { username: "bad user" },
      { display_name: "" },
      { password: "short" },
      { pin: "12345" },
    ].map((change) => JSON.stringify({ ...FUNCTIONAL_VALUES, ...change })),
  ]) {
    await privateFile(path, contents);
    await assert.rejects(loadWindowsFunctionalAccount(path), (error) => {
      assert.match(error.message, INVALID.message);
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes(FUNCTIONAL_VALUES.password), false);
      return true;
    });
  }
});

test("Runtime login needs only the administrator files while functional bootstrap requires PIN and approver files", async (t) => {
  const { secrets } = await fixture(t);
  await rm(companionFile(secrets, "approver_pin"));
  assert.equal(
    (await loadWindowsRuntimeCredentials(companionEnvironment(secrets))).adminUsername,
    VALUES.admin_username,
  );
  await assert.rejects(loadWindowsBootstrapCredentials(companionEnvironment(secrets)), INVALID);
});

test("source selection rejects missing, ambiguous, relative, blank and padded paths without fallback", async (t) => {
  const { secrets, legacy } = await fixture(t);
  for (const environment of [
    {},
    { ...companionEnvironment(secrets), ...legacyEnvironment(legacy) },
    companionEnvironment("secrets"),
    companionEnvironment(""),
    companionEnvironment(` ${secrets}`),
    companionEnvironment(`${secrets}\0`),
    legacyEnvironment("development-credentials.json"),
    { ...companionEnvironment(join(secrets, "missing")), ...legacyEnvironment(legacy) },
  ]) {
    await assert.rejects(loadWindowsRuntimeCredentials(environment), INVALID);
    await assert.rejects(loadWindowsBootstrapCredentials(environment), INVALID);
  }
});

test("a missing companion secret is rejected even when a legacy credential JSON exists nearby", async (t) => {
  const { secrets } = await fixture(t);
  await privateFile(join(secrets, "development-credentials.json"), JSON.stringify(VALUES));
  await rm(companionFile(secrets, "admin_password"));
  await assert.rejects(loadWindowsRuntimeCredentials(companionEnvironment(secrets)), INVALID);
});

test("legacy JSON rejects non-development data, non-object data and malformed syntax without leaking secrets", async (t) => {
  const { legacy } = await fixture(t);
  for (const contents of [
    JSON.stringify({ ...VALUES, development_only: false }),
    "null",
    "[]",
    `{"secret":"${VALUES.admin_password}", broken}`,
  ]) {
    await privateFile(legacy, contents);
    await assert.rejects(loadWindowsRuntimeCredentials(legacyEnvironment(legacy)), (error) => {
      assert.match(error.message, INVALID.message);
      assert.equal(error.message.includes(VALUES.admin_password), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("both formats validate safe usernames, bounded single-line passwords and display names", async (t) => {
  const { secrets, legacy } = await fixture(t);
  for (const [field, value] of [
    ["admin_username", "bad user"],
    ["admin_username", "a".repeat(65)],
    ["admin_display_name", "   "],
    ["admin_display_name", "a".repeat(81)],
    ["admin_display_name", "Name\nInjected"],
    ["admin_password", "short"],
    ["admin_password", "a".repeat(257)],
    ["admin_password", `${VALUES.admin_password}\0`],
    ["admin_password", `${VALUES.admin_password}\r\n`],
  ]) {
    await privateFile(legacy, JSON.stringify({ ...VALUES, [field]: value }));
    await assert.rejects(loadWindowsRuntimeCredentials(legacyEnvironment(legacy)), INVALID);
    await privateFile(companionFile(secrets, field), value);
    await assert.rejects(loadWindowsRuntimeCredentials(companionEnvironment(secrets)), INVALID);
    await privateFile(companionFile(secrets, field), VALUES[field]);
  }
});

test("functional bootstrap rejects malformed or identical approval PINs in either format", async (t) => {
  const { secrets, legacy } = await fixture(t);
  for (const value of ["12345", "123456789", "12345x", VALUES.admin_pin]) {
    await privateFile(legacy, JSON.stringify({ ...VALUES, approver_pin: value }));
    await assert.rejects(loadWindowsBootstrapCredentials(legacyEnvironment(legacy)), INVALID);
    await privateFile(companionFile(secrets, "approver_pin"), value);
    await assert.rejects(loadWindowsBootstrapCredentials(companionEnvironment(secrets)), INVALID);
  }
});

test("credential reads reject empty, oversized and malformed UTF-8 files", async (t) => {
  const { secrets, legacy } = await fixture(t);
  for (const contents of ["", "a".repeat(8193), Buffer.from([0xc3, 0x28])]) {
    await privateFile(legacy, contents);
    await assert.rejects(loadWindowsRuntimeCredentials(legacyEnvironment(legacy)), INVALID);
    await privateFile(companionFile(secrets, "admin_password"), contents);
    await assert.rejects(loadWindowsRuntimeCredentials(companionEnvironment(secrets)), INVALID);
  }
});

test("hard-linked credentials and a directory replacing a secret are rejected", async (t) => {
  const { secrets } = await fixture(t);
  const path = companionFile(secrets, "admin_password");
  const alias = join(secrets, "password-alias");
  await link(path, alias);
  await assert.rejects(loadWindowsRuntimeCredentials(companionEnvironment(secrets)), INVALID);
  await rm(alias);
  await rm(path);
  await mkdir(path);
  await assert.rejects(loadWindowsRuntimeCredentials(companionEnvironment(secrets)), INVALID);
});

test("a symlink or junction cannot hide the selected secrets directory", async (t) => {
  const { root, secrets } = await fixture(t);
  const alias = join(root, "secrets-alias");
  await symlink(secrets, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(loadWindowsRuntimeCredentials(companionEnvironment(alias)), INVALID);
});

test(
  "non-private POSIX files and directories are rejected",
  { skip: process.platform === "win32" },
  async (t) => {
    const { secrets } = await fixture(t);
    const password = companionFile(secrets, "admin_password");
    await chmod(password, 0o644);
    await assert.rejects(loadWindowsRuntimeCredentials(companionEnvironment(secrets)), INVALID);
    await chmod(password, 0o600);
    await chmod(secrets, 0o755);
    await assert.rejects(loadWindowsRuntimeCredentials(companionEnvironment(secrets)), INVALID);
  },
);
