import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ACCEPTANCE_CREDENTIAL_FILES,
  ACCEPTANCE_FIXTURE_OPT_IN,
  assertNoDirectAcceptanceSecrets,
  loadRemoteAcceptanceEnvironment,
  materializeAcceptanceSecrets,
  parseServerEnvironment,
} from "./hk-vps-release-acceptance-secrets.mjs";
import {
  acceptanceCredentialScpArguments,
  withDownloadedAcceptanceCredentials,
} from "./hk-vps-release-local-credentials.mjs";
import { selectLocalEnvironment } from "./hk-vps-release-local.mjs";

const UID = process.getuid();
const GID = process.getgid();

async function privateFile(path, value) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function remoteFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-secrets-test-")));
  await chmod(root, 0o700);
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot, { mode: 0o700 });
  const approver = {
    username: join(sourceRoot, "approver-username"),
    displayName: join(sourceRoot, "approver-display-name"),
    password: join(sourceRoot, "approver-password"),
    pin: join(sourceRoot, "approver-pin"),
  };
  await privateFile(approver.username, "approver");
  await privateFile(approver.displayName, "Release Approver");
  await privateFile(approver.password, "approver-private-value");
  await privateFile(approver.pin, "850274");
  const sourcePath = join(root, "server.env");
  await privateFile(
    sourcePath,
    [
      "# existing service values are ignored",
      "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME=owner",
      'LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME="Release Owner"',
      "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD='admin-private-value'",
      "LAUNDRY_BOOTSTRAP_ADMIN_PIN=740193",
      `LAUNDRY_BOOTSTRAP_APPROVER_USERNAME_FILE=${approver.username}`,
      `LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME_FILE=${approver.displayName}`,
      `LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD_FILE=${approver.password}`,
      `LAUNDRY_BOOTSTRAP_APPROVER_PIN_FILE=${approver.pin}`,
      "DATABASE_ADMIN_URL=postgresql://postgres:db-private@127.0.0.1:5432/laundry_v2",
      "UNRELATED=value",
      "",
    ].join("\n"),
  );
  return Object.freeze({
    envPath: join(root, "adr36-acceptance.env"),
    root,
    secretRoot: join(root, "acceptance-secrets"),
    sourcePath,
  });
}

test("remote prepare materializes exactly nine root-private files and one path-only env", async () => {
  const fixture = await remoteFixture();
  try {
    const options = { ...fixture, gid: GID, uid: UID };
    const environment = await materializeAcceptanceSecrets(options);
    const expectedFiles = [
      ...ACCEPTANCE_CREDENTIAL_FILES.map((item) => item.filename),
      "database-admin-url",
    ].sort();
    assert.deepEqual((await readdir(fixture.secretRoot)).sort(), expectedFiles);
    assert.equal((await lstat(fixture.secretRoot)).mode & 0o7777, 0o700);
    for (const filename of expectedFiles) {
      const metadata = await lstat(join(fixture.secretRoot, filename));
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.uid, UID);
      assert.equal(metadata.gid, GID);
      assert.equal(metadata.mode & 0o7777, 0o600);
      assert.doesNotMatch(await readFile(join(fixture.secretRoot, filename), "utf8"), /[\r\n]/u);
    }
    const envSource = await readFile(fixture.envPath, "utf8");
    assert.equal(envSource.trim().split("\n").length, 10);
    assert.match(
      envSource,
      new RegExp(`LAUNDRY_ADR36_REMINDER_FIXTURE=${ACCEPTANCE_FIXTURE_OPT_IN}`, "u"),
    );
    assert.doesNotMatch(envSource, /private-value|db-private/u);
    assert.equal(Object.keys(environment).length, 13);
    assert.equal(Object.hasOwn(environment, "DATABASE_ADMIN_URL"), false);
    assert.equal(Object.hasOwn(environment, "GH_TOKEN"), false);
    assert.deepEqual(await materializeAcceptanceSecrets(options), environment);
    assert.deepEqual(await loadRemoteAcceptanceEnvironment(options), environment);

    await privateFile(join(fixture.secretRoot, "admin-password"), "changed");
    await assert.rejects(() => materializeAcceptanceSecrets(options), {
      code: "CLOUD_RELEASE_ACCEPTANCE_SECRET_MISMATCH",
    });
    assert.equal(await readFile(join(fixture.secretRoot, "admin-password"), "utf8"), "changed");
    assert.deepEqual((await readdir(fixture.secretRoot)).sort(), expectedFiles);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("remote prepare retries after a crash leaves a partial private staging file", async () => {
  const fixture = await remoteFixture();
  const stalePath = join(fixture.secretRoot, `.admin-username.tmp-${"a".repeat(32)}`);
  try {
    await mkdir(fixture.secretRoot, { mode: 0o700 });
    await privateFile(stalePath, "partially-written");

    await materializeAcceptanceSecrets({ ...fixture, gid: GID, uid: UID });

    await assert.rejects(() => lstat(stalePath), { code: "ENOENT" });
    assert.equal(await readFile(join(fixture.secretRoot, "admin-username"), "utf8"), "owner");
    assert.deepEqual(
      (await readdir(fixture.secretRoot)).sort(),
      [...ACCEPTANCE_CREDENTIAL_FILES.map((item) => item.filename), "database-admin-url"].sort(),
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("remote prepare retries idempotently after publish precedes staging cleanup", async () => {
  const fixture = await remoteFixture();
  const options = { ...fixture, gid: GID, uid: UID };
  const finalPath = join(fixture.secretRoot, "admin-password");
  const stalePath = join(fixture.secretRoot, `.admin-password.tmp-${"b".repeat(32)}`);
  try {
    const expected = await materializeAcceptanceSecrets(options);
    await link(finalPath, stalePath);
    assert.equal((await lstat(stalePath)).ino, (await lstat(finalPath)).ino);

    assert.deepEqual(await materializeAcceptanceSecrets(options), expected);

    await assert.rejects(() => lstat(stalePath), { code: "ENOENT" });
    assert.equal(await readFile(finalPath, "utf8"), "admin-private-value");
    assert.equal((await readdir(fixture.secretRoot)).length, 9);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("remote prepare refuses to clean a symlink disguised as a staging file", async () => {
  const fixture = await remoteFixture();
  const stalePath = join(fixture.secretRoot, `.admin-username.tmp-${"c".repeat(32)}`);
  try {
    await mkdir(fixture.secretRoot, { mode: 0o700 });
    await symlink(fixture.sourcePath, stalePath);

    await assert.rejects(() => materializeAcceptanceSecrets({ ...fixture, gid: GID, uid: UID }), {
      code: "CLOUD_RELEASE_ACCEPTANCE_SECRET_FILE_INVALID",
    });
    assert.equal((await lstat(stalePath)).isSymbolicLink(), true);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("remote prepare rejects ambiguous source fields, symlinks and unexpected secret files", async () => {
  for (const scenario of ["ambiguous", "symlink", "extra"]) {
    const fixture = await remoteFixture();
    try {
      const options = { ...fixture, gid: GID, uid: UID };
      if (scenario === "ambiguous") {
        await privateFile(
          fixture.sourcePath,
          `${await readFile(fixture.sourcePath, "utf8")}LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD_FILE=/tmp/nope\n`,
        );
        await assert.rejects(() => materializeAcceptanceSecrets(options), {
          code: "CLOUD_RELEASE_ACCEPTANCE_SECRET_SOURCE_AMBIGUOUS",
        });
      } else if (scenario === "symlink") {
        const target = join(fixture.root, "server-target.env");
        await privateFile(target, await readFile(fixture.sourcePath, "utf8"));
        await rm(fixture.sourcePath);
        await symlink(target, fixture.sourcePath);
        await assert.rejects(() => materializeAcceptanceSecrets(options), {
          code: "CLOUD_RELEASE_SERVER_ENV_INVALID",
        });
      } else {
        await materializeAcceptanceSecrets(options);
        await privateFile(join(fixture.secretRoot, "unexpected"), "value");
        await assert.rejects(() => loadRemoteAcceptanceEnvironment(options), {
          code: "CLOUD_RELEASE_ACCEPTANCE_SECRET_ROOT_INVALID",
        });
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }
});

test("server.env is parsed without shell expansion and rejects duplicate or multiline ambiguity", () => {
  const parsed = parseServerEnvironment(
    'A=\'literal $VALUE\'\nB=escaped\\ value\nC="quoted\\"value"\n',
  );
  assert.equal(parsed.get("A"), "literal $VALUE");
  assert.equal(parsed.get("B"), "escaped value");
  assert.equal(parsed.get("C"), 'quoted"value');
  for (const invalid of ["A=one\nA=two\n", "export A=value\n", "A='unterminated\n", "A=x\r\n"]) {
    assert.throws(() => parseServerEnvironment(invalid), {
      code: "CLOUD_RELEASE_SERVER_ENV_INVALID",
    });
  }
});

test("local browser credentials download exactly eight fixed files into a cleaned private root", async () => {
  const calls = [];
  let temporaryRoot;
  const execute = async (_file, arguments_, label) => {
    const destination = arguments_.at(-1);
    calls.push({ arguments_, label });
    await writeFile(destination, "downloaded-private-value", { mode: 0o644 });
    return Object.freeze({ code: 0, stderr: "", stdout: "" });
  };
  const operationFailure = new Error("browser failed");
  await assert.rejects(
    () =>
      withDownloadedAcceptanceCredentials(
        {
          environment: {
            DATABASE_URL: "must-not-pass",
            GH_TOKEN: "must-not-pass",
            HOME: "/Users/test",
            LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD_FILE: "/attacker/value",
            PATH: "/usr/bin:/bin",
            RELEASE_TOKEN: "must-not-pass",
          },
          execute,
          knownHostsPath: "/private/tmp/known-hosts",
        },
        async (environment) => {
          temporaryRoot = environment.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME_FILE.split("/")
            .slice(0, -1)
            .join("/");
          assert.equal(Object.keys(environment).filter((name) => name.endsWith("_FILE")).length, 8);
          assert.equal(environment.LAUNDRY_CLOUD_WEB_E2E, "1");
          assert.equal(environment.LAUNDRY_CLOUD_WEB_MACHINE_JSON, "1");
          for (const forbidden of ["DATABASE_URL", "GH_TOKEN", "RELEASE_TOKEN"]) {
            assert.equal(Object.hasOwn(environment, forbidden), false);
          }
          for (const path of Object.entries(environment)
            .filter(([name]) => name.endsWith("_FILE"))
            .map(([, path]) => path)) {
            const metadata = await lstat(path);
            assert.equal(metadata.uid, UID);
            assert.equal(metadata.mode & 0o7777, 0o600);
          }
          throw operationFailure;
        },
      ),
    (error) => error === operationFailure,
  );
  assert.equal(calls.length, 8);
  assert.deepEqual(
    calls.map((call) => call.arguments_.at(-2).split("/").at(-1)).sort(),
    ACCEPTANCE_CREDENTIAL_FILES.map((item) => item.filename).sort(),
  );
  assert.equal(
    calls.some((call) => call.arguments_.join(" ").includes("database-admin-url")),
    false,
  );
  await assert.rejects(() => lstat(temporaryRoot), { code: "ENOENT" });
});

test("release orchestration rejects every direct bootstrap field before any download", async () => {
  for (const name of [
    "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
    "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD",
    "LAUNDRY_BOOTSTRAP_UNEXPECTED",
  ]) {
    assert.throws(() => assertNoDirectAcceptanceSecrets({ [name]: "secret" }), {
      code: "CLOUD_RELEASE_DIRECT_SECRET_REJECTED",
    });
    assert.throws(() => selectLocalEnvironment({ [name]: "secret", PATH: "/usr/bin:/bin" }), {
      code: "CLOUD_RELEASE_DIRECT_SECRET_REJECTED",
    });
    await assert.rejects(
      () =>
        withDownloadedAcceptanceCredentials(
          {
            environment: { [name]: "secret" },
            execute: async () => assert.fail("download must not run"),
            knownHostsPath: "/private/tmp/known-hosts",
          },
          async () => undefined,
        ),
      { code: "CLOUD_RELEASE_DIRECT_SECRET_REJECTED" },
    );
  }
});

test("invalid local identity is rejected before creating a credential root", async () => {
  let created = false;
  await assert.rejects(
    () =>
      withDownloadedAcceptanceCredentials(
        {
          environment: {},
          execute: async () => assert.fail("download must not run"),
          knownHostsPath: "/private/tmp/known-hosts",
        },
        async () => undefined,
        {
          gid: GID,
          mkdtemp: async () => {
            created = true;
            return "/private/tmp/credential-root";
          },
          uid: -1,
        },
      ),
    { code: "CLOUD_RELEASE_LOCAL_CREDENTIAL_INVALID" },
  );
  assert.equal(created, false);
});

test("credential SCP arguments retain pinned key-only SSH and fixed remote names", () => {
  const arguments_ = acceptanceCredentialScpArguments(
    "admin-password",
    "/private/tmp/release/admin-password",
    "/private/tmp/known-hosts",
  );
  assert.ok(arguments_.includes("BatchMode=yes"));
  assert.ok(arguments_.includes("StrictHostKeyChecking=yes"));
  assert.equal(arguments_.at(-2), "hk-vps:/etc/laundry-desk/acceptance-secrets/admin-password");
  assert.throws(
    () =>
      acceptanceCredentialScpArguments(
        "database-admin-url",
        "/private/tmp/release/database-admin-url",
        "/private/tmp/known-hosts",
      ),
    { code: "CLOUD_RELEASE_CREDENTIAL_DOWNLOAD_PATH_INVALID" },
  );
});
