import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ensureLocalConfig,
  generateLocalConfig,
  loadLocalConfig,
  parseLocalConfig,
  resolveLocalConfigPaths,
  toLocalConfigEnvironment,
} from "./config.mjs";

const temporaryDirectories = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createTemporaryDirectory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "laundry-local-config-")));
  temporaryDirectories.push(path);
  return path;
}

function assertSecretStrength(config) {
  const secrets = [
    config.postgresSuperuserPassword,
    config.postgresAppPassword,
    config.accessTokenSecret,
    config.csrfProofSecret,
  ];

  assert.equal(new Set(secrets).size, secrets.length);
  for (const secret of secrets) {
    assert.match(secret, /^[A-Za-z0-9_-]+$/u);
    assert.ok(Buffer.from(secret, "base64url").byteLength >= 32);
  }
  assert.match(config.instanceId, /^[A-Za-z0-9_-]+$/u);
  assert.ok(Buffer.from(config.instanceId, "base64url").byteLength >= 16);
}

test("resolves repo-external macOS Application Support paths", () => {
  const paths = resolveLocalConfigPaths({
    platform: "darwin",
    homeDir: "/Users/local-test",
    env: {},
  });

  assert.deepEqual(paths, {
    directoryPath: "/Users/local-test/Library/Application Support/laundry-desk-v2/local",
    filePath: "/Users/local-test/Library/Application Support/laundry-desk-v2/local/config.json",
  });
  assert.equal(Object.isFrozen(paths), true);
});

test("accepts only an absolute explicit config-directory override", () => {
  const override = resolveLocalConfigPaths({
    platform: "linux",
    homeDir: "/home/local-test",
    env: { LAUNDRY_LOCAL_CONFIG_DIR: "/ci/private/laundry-config" },
  });

  assert.equal(override.directoryPath, "/ci/private/laundry-config");
  assert.equal(override.filePath, "/ci/private/laundry-config/config.json");

  for (const invalidPath of ["", "relative/config", "/tmp/config\u0000escape"]) {
    assert.throws(
      () =>
        resolveLocalConfigPaths({
          platform: "darwin",
          homeDir: "/Users/local-test",
          env: { LAUNDRY_LOCAL_CONFIG_DIR: invalidPath },
        }),
      /LAUNDRY_LOCAL_CONFIG_DIR/u,
    );
  }
});

test("rejects unsupported platforms and invalid home directories", () => {
  assert.throws(
    () => resolveLocalConfigPaths({ platform: "win32", homeDir: "C:\\Users\\local", env: {} }),
    /platform/u,
  );
  assert.throws(
    () => resolveLocalConfigPaths({ platform: "darwin", homeDir: "relative-home", env: {} }),
    /home directory/u,
  );
  assert.throws(
    () =>
      resolveLocalConfigPaths({
        platform: "win32",
        homeDir: "C:\\Users\\local",
        env: { LAUNDRY_LOCAL_CONFIG_DIR: "/absolute/override" },
      }),
    /platform/u,
  );
});

test("rejects config locations inside the repository", () => {
  const repositoryPath = fileURLToPath(new URL("../../.local-config-test", import.meta.url));

  assert.throws(
    () =>
      resolveLocalConfigPaths({
        platform: "darwin",
        homeDir: "/Users/local-test",
        env: { LAUNDRY_LOCAL_CONFIG_DIR: repositoryPath },
      }),
    /outside the repository/u,
  );
});

test("generates four independent secrets from at least 32 random bytes", () => {
  const first = generateLocalConfig();
  const second = generateLocalConfig();

  assert.deepEqual(Object.keys(first).sort(), [
    "accessTokenSecret",
    "csrfProofSecret",
    "instanceId",
    "postgresAppPassword",
    "postgresSuperuserPassword",
    "version",
  ]);
  assert.equal(first.version, 1);
  assert.equal(Object.isFrozen(first), true);
  assertSecretStrength(first);
  assertSecretStrength(second);
  assert.notEqual(first.postgresSuperuserPassword, second.postgresSuperuserPassword);
  assert.notEqual(first.postgresAppPassword, second.postgresAppPassword);
  assert.notEqual(first.accessTokenSecret, second.accessTokenSecret);
  assert.notEqual(first.csrfProofSecret, second.csrfProofSecret);
  assert.notEqual(first.instanceId, second.instanceId);

  assert.throws(
    () => generateLocalConfig({ randomBytes: () => Buffer.alloc(31, 1) }),
    /at least 32 random bytes/u,
  );
  assert.throws(
    () => generateLocalConfig({ randomBytes: () => Buffer.alloc(32, 1) }),
    /independent/u,
  );
});

test("strictly parses canonical config without exposing rejected values", () => {
  const valid = generateLocalConfig();
  assert.deepEqual(parseLocalConfig(valid), valid);

  const leakedCandidate = "secret-value-that-must-not-appear";
  const invalidConfigs = [
    { ...valid, version: 2 },
    { ...valid, instanceId: "short" },
    { ...valid, accessTokenSecret: "short" },
    { ...valid, accessTokenSecret: `${valid.accessTokenSecret}=` },
    { ...valid, csrfProofSecret: valid.accessTokenSecret },
    { ...valid, administratorPassword: leakedCandidate },
    { ...valid, administratorPin: leakedCandidate },
    null,
    [],
  ];

  for (const invalidConfig of invalidConfigs) {
    assert.throws(
      () => parseLocalConfig(invalidConfig),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid local configuration/u);
        assert.doesNotMatch(error.message, new RegExp(leakedCandidate, "u"));
        return true;
      },
    );
  }
});

test("creates and atomically reuses a private config without administrator credentials", async () => {
  const homeDir = await createTemporaryDirectory();
  const options = { platform: "darwin", homeDir, env: {} };

  const first = await ensureLocalConfig(options);
  const paths = resolveLocalConfigPaths(options);
  const originalContents = await readFile(paths.filePath, "utf8");
  const second = await ensureLocalConfig(options);

  assert.deepEqual(second, first);
  assert.equal(await readFile(paths.filePath, "utf8"), originalContents);
  assert.equal((await stat(paths.directoryPath)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.filePath)).mode & 0o777, 0o600);
  assertSecretStrength(first);

  const persisted = JSON.parse(originalContents);
  assert.deepEqual(persisted, first);
  assert.equal("administratorPassword" in persisted, false);
  assert.equal("administratorPin" in persisted, false);
  assert.equal("adminPassword" in persisted, false);
  assert.equal("adminPin" in persisted, false);

  const directoryEntries = await readdir(paths.directoryPath);
  assert.deepEqual(directoryEntries, ["config.json"]);
});

test("concurrent first-use callers converge on one config without temporary files", async () => {
  const homeDir = await createTemporaryDirectory();
  const options = { platform: "darwin", homeDir, env: {} };

  const configs = await Promise.all(Array.from({ length: 16 }, () => ensureLocalConfig(options)));
  const paths = resolveLocalConfigPaths(options);
  const persisted = parseLocalConfig(JSON.parse(await readFile(paths.filePath, "utf8")));

  for (const config of configs) {
    assert.deepEqual(config, persisted);
  }
  assert.deepEqual(await readdir(paths.directoryPath), ["config.json"]);
});

test("fails closed for insecure, malformed, oversized, or symlinked config files", async () => {
  const homeDir = await createTemporaryDirectory();
  const options = { platform: "darwin", homeDir, env: {} };
  const paths = resolveLocalConfigPaths(options);
  await mkdir(paths.directoryPath, { mode: 0o700, recursive: true });

  await writeFile(paths.filePath, "{not-json", { mode: 0o600 });
  await assert.rejects(() => loadLocalConfig(options), /Invalid local configuration/u);

  await writeFile(paths.filePath, "x".repeat(20_000), { mode: 0o600 });
  await assert.rejects(() => loadLocalConfig(options), /Invalid local configuration/u);

  await writeFile(paths.filePath, JSON.stringify(generateLocalConfig()), { mode: 0o644 });
  await chmod(paths.filePath, 0o644);
  await assert.rejects(() => loadLocalConfig(options), /mode 0600/u);

  await rm(paths.filePath);
  const symlinkTarget = join(homeDir, "symlink-target.json");
  await writeFile(symlinkTarget, JSON.stringify(generateLocalConfig()), { mode: 0o600 });
  await symlink(symlinkTarget, paths.filePath);
  await assert.rejects(() => loadLocalConfig(options), /regular file/u);
});

test("fails closed for an insecure or symlinked config directory", async () => {
  const homeDir = await createTemporaryDirectory();
  const options = { platform: "darwin", homeDir, env: {} };
  const paths = resolveLocalConfigPaths(options);

  await mkdir(paths.directoryPath, { mode: 0o755, recursive: true });
  await assert.rejects(() => ensureLocalConfig(options), /mode 0700/u);

  await rm(paths.directoryPath, { recursive: true });
  const symlinkTarget = join(homeDir, "config-target");
  await mkdir(symlinkTarget, { mode: 0o700 });
  await symlink(symlinkTarget, paths.directoryPath);
  await assert.rejects(() => ensureLocalConfig(options), /symbolic-link ancestor/u);
});

test("rejects an immediate symlink parent for an explicit config override", async () => {
  const homeDir = await createTemporaryDirectory();
  const targetPath = join(homeDir, "override-target");
  const parentPath = join(homeDir, "override-parent");
  await mkdir(targetPath, { mode: 0o700 });
  await symlink(targetPath, parentPath);

  await assert.rejects(
    () =>
      ensureLocalConfig({
        platform: "darwin",
        homeDir,
        env: { LAUNDRY_LOCAL_CONFIG_DIR: join(parentPath, "config") },
      }),
    /symbolic-link ancestor/u,
  );
});

test("rejects a non-immediate symlink ancestor for an explicit config override", async () => {
  const homeDir = await createTemporaryDirectory();
  const targetPath = join(homeDir, "ancestor-target");
  const ancestorPath = join(homeDir, "ancestor-link");
  await mkdir(targetPath, { mode: 0o700 });
  await symlink(targetPath, ancestorPath);

  await assert.rejects(
    () =>
      ensureLocalConfig({
        platform: "darwin",
        homeDir,
        env: { LAUNDRY_LOCAL_CONFIG_DIR: join(ancestorPath, "nested", "config") },
      }),
    /symbolic-link ancestor/u,
  );
});

test("rejects an immediate symlink parent for the default Application Support path", async () => {
  const homeDir = await createTemporaryDirectory();
  const targetPath = join(homeDir, "default-target");
  const parentPath = join(homeDir, "Library", "Application Support", "laundry-desk-v2");
  await mkdir(targetPath, { mode: 0o700 });
  await mkdir(join(parentPath, ".."), { recursive: true });
  await symlink(targetPath, parentPath);

  await assert.rejects(
    () => ensureLocalConfig({ platform: "darwin", homeDir, env: {} }),
    /symbolic-link ancestor/u,
  );
});

test(
  "rejects a case-aliased macOS path that resolves inside the repository",
  { skip: process.platform !== "darwin" },
  async () => {
    const repositoryPath = fileURLToPath(new URL("../../.local-case-alias-test", import.meta.url));
    const aliasedPath = repositoryPath.replace(/^\/Users\//u, "/users/");
    assert.notEqual(aliasedPath, repositoryPath);

    await assert.rejects(
      () =>
        loadLocalConfig({
          platform: "darwin",
          env: { LAUNDRY_LOCAL_CONFIG_DIR: aliasedPath },
        }),
      /outside the repository/u,
    );
  },
);

test("maps config to a frozen secret environment without URLs or aliases", () => {
  const config = generateLocalConfig();
  const environment = toLocalConfigEnvironment(config);

  assert.deepEqual(environment, {
    POSTGRES_PASSWORD: config.postgresSuperuserPassword,
    LAUNDRY_APP_PASSWORD: config.postgresAppPassword,
    LAUNDRY_ACCESS_TOKEN_SECRET: config.accessTokenSecret,
    LAUNDRY_CSRF_PROOF_SECRET: config.csrfProofSecret,
    LAUNDRY_LOCAL_INSTANCE_ID: config.instanceId,
  });
  assert.equal(Object.isFrozen(environment), true);
  assert.equal(
    Object.keys(environment).some((key) => /URL|ADMIN|PIN/u.test(key)),
    false,
  );
});
