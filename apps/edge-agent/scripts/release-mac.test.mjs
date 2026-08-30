import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertEquivalentApplication,
  assertExpectedApplication,
  inspectSignedUniversalApplication,
} from "./release-inspection.mjs";
import {
  createReleaseBuildEnvironment,
  createReleaseSignerCommand,
  createReleaseSignerEnvironment,
  createReleaseVerifierEnvironment,
  locateReleaseArtifacts,
  parseReleaseEnvironment,
  stageReleaseResources,
} from "./release-mac.mjs";
import { withAtomicReleaseDirectory } from "./release-transaction.mjs";
import { readReleaseInputFile } from "./release-resources.mjs";
import { createReleaseTreeVersion, sealReleaseTreePermissions } from "./release-tree.mjs";

const macReleaseTest = process.platform === "win32" ? test.skip : test;

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-preflight-"));
  t.after(async () => {
    await rm(root, { recursive: true });
  });
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.pem");
  const policyPath = join(root, "policy.json");
  const updateConfigPath = join(root, "update-config.json");
  const keychain = join(root, "release.keychain-db");
  await writeFile(privateKeyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, keys.publicKey.export({ format: "pem", type: "spki" }), {
    mode: 0o600,
  });
  await writeFile(policyPath, JSON.stringify({ channel: "stable" }), { mode: 0o600 });
  await writeFile(
    updateConfigPath,
    JSON.stringify({
      schema_version: 1,
      enabled: true,
      channel: "stable",
      manifest_url: "https://updates.manpengan.xyz/laundry/stable/latest-laundry-v2.json",
    }),
    { mode: 0o600 },
  );
  await writeFile(keychain, "fixture");
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    DATABASE_URL: "must-not-pass",
    CSC_NAME: "Developer ID Application: Laundry Desk (ABCDE12345)",
    APPLE_KEYCHAIN: keychain,
    APPLE_KEYCHAIN_PROFILE: "laundry-notary",
    LAUNDRY_UPDATE_PRIVATE_KEY_FILE: privateKeyPath,
    LAUNDRY_UPDATE_PUBLIC_KEY_FILE: publicKeyPath,
    LAUNDRY_RELEASE_POLICY_FILE: policyPath,
    LAUNDRY_UPDATE_CONFIG_FILE: updateConfigPath,
  };
  return { root, env, updateConfigPath };
}

test("release environment is explicit, keychain-only, and rejects argument injection", async (t) => {
  const setup = await releaseFixture(t);
  const parsed = parseReleaseEnvironment(setup.env, "darwin");
  assert.equal(parsed.profile, "laundry-notary");
  assert.equal(parsed.teamIdentifier, "ABCDE12345");
  assert.throws(
    () =>
      parseReleaseEnvironment(
        { ...setup.env, CSC_NAME: "Developer ID Application: x;rm" },
        "darwin",
      ),
    /CSC_NAME/u,
  );
  assert.throws(
    () => parseReleaseEnvironment({ ...setup.env, APPLE_ID: "unexpected" }, "darwin"),
    /APPLE_ID/u,
  );
  assert.throws(() => parseReleaseEnvironment(setup.env, "linux"), /requires Darwin/u);
});

test("build environment cannot discover the update signing private key", async (t) => {
  const setup = await releaseFixture(t);
  const parsed = parseReleaseEnvironment(setup.env, "darwin");
  const stagingDirectory = join(setup.root, "staging", "release");
  const stagedResources = {
    publicKeyStagingPath: join(setup.root, "staging", "public.pem"),
    updateConfigStagingPath: join(setup.root, "staging", "update-config.json"),
  };
  const build = createReleaseBuildEnvironment(setup.env, parsed, stagingDirectory, stagedResources);
  assert.equal(build.DATABASE_URL, undefined);
  assert.equal(build.HOME, setup.root);
  assert.equal(build.CSC_KEYCHAIN, parsed.keychain);
  assert.equal(build.LAUNDRY_UPDATE_PRIVATE_KEY_FILE, undefined);
  assert.equal(build.LAUNDRY_RELEASE_POLICY_FILE, undefined);
  assert.equal(build.LAUNDRY_RELEASE_OUTPUT_DIRECTORY, stagingDirectory);

  const descriptor = { schema_version: 1, version: "1.2.3" };
  const signer = createReleaseSignerEnvironment(parsed, stagingDirectory, descriptor);
  assert.deepEqual(Object.keys(signer).sort(), [
    "LAUNDRY_RELEASE_DIRECTORY",
    "LAUNDRY_RELEASE_INPUT_DESCRIPTOR",
    "LAUNDRY_RELEASE_POLICY_FILE",
    "LAUNDRY_UPDATE_PRIVATE_KEY_FILE",
  ]);
  assert.deepEqual(JSON.parse(signer.LAUNDRY_RELEASE_INPUT_DESCRIPTOR), descriptor);
  const verifier = createReleaseVerifierEnvironment(
    stagingDirectory,
    { appPath: join(stagingDirectory, "mac-universal", "laundry-desk V2.app") },
    descriptor,
  );
  assert.equal(verifier.LAUNDRY_UPDATE_PRIVATE_KEY_FILE, undefined);
  assert.match(verifier.LAUNDRY_RELEASE_VERIFY_PUBLIC_KEY_FILE, /update-public-key\.pem$/u);
  const command = createReleaseSignerCommand();
  assert.equal(command.file, process.execPath);
  assert.deepEqual(command.args, ["dist/upgrade/release-bundle-cli.js"]);
});

macReleaseTest(
  "release stages only the matching Ed25519 public key and strict update config",
  async (t) => {
    const setup = await releaseFixture(t);
    const parsed = parseReleaseEnvironment(setup.env, "darwin");
    const packageRoot = join(setup.root, "package");
    await mkdir(join(packageRoot, "build"), { recursive: true });
    const staged = await stageReleaseResources(parsed, packageRoot);
    assert.equal(
      await readFile(staged.publicKeyStagingPath, "utf8"),
      await readFile(parsed.publicKeyPath, "utf8"),
    );
    assert.deepEqual(JSON.parse(await readFile(staged.updateConfigStagingPath, "utf8")), {
      schema_version: 1,
      enabled: true,
      channel: "stable",
      manifest_url: "https://updates.manpengan.xyz/laundry/stable/latest-laundry-v2.json",
    });

    const other = generateKeyPairSync("ed25519");
    await writeFile(parsed.publicKeyPath, other.publicKey.export({ format: "pem", type: "spki" }));
    const secondRoot = join(setup.root, "other-package");
    await mkdir(join(secondRoot, "build"), { recursive: true });
    await assert.rejects(() => stageReleaseResources(parsed, secondRoot), /does not match/u);
  },
);

macReleaseTest(
  "release refuses disabled, credentialed, or shape-drifted production update config",
  async (t) => {
    for (const candidate of [
      { schema_version: 1, enabled: false },
      {
        schema_version: 1,
        enabled: true,
        channel: "stable",
        manifest_url:
          "https://user:password@updates.manpengan.xyz/laundry/stable/latest-laundry-v2.json",
      },
      {
        schema_version: 1,
        enabled: true,
        channel: "stable",
        manifest_url: "https://updates.manpengan.xyz/laundry/stable/latest-laundry-v2.json",
        extra: true,
      },
    ]) {
      const setup = await releaseFixture(t);
      await writeFile(setup.updateConfigPath, JSON.stringify(candidate));
      const packageRoot = join(setup.root, "package-invalid-config");
      await mkdir(join(packageRoot, "build"), { recursive: true });
      await assert.rejects(
        () => stageReleaseResources(parseReleaseEnvironment(setup.env, "darwin"), packageRoot),
        /configuration is invalid/u,
      );
    }
  },
);

macReleaseTest(
  "release refuses a placeholder host or channel drift from signed policy",
  async (t) => {
    for (const candidate of [
      {
        schema_version: 1,
        enabled: true,
        channel: "stable",
        manifest_url: "https://updates.example/laundry/stable/latest-laundry-v2.json",
      },
      {
        schema_version: 1,
        enabled: true,
        channel: "beta",
        manifest_url: "https://updates.manpengan.xyz/laundry/beta/latest-laundry-v2.json",
      },
    ]) {
      const setup = await releaseFixture(t);
      await writeFile(setup.updateConfigPath, JSON.stringify(candidate));
      const packageRoot = join(setup.root, "package-policy-mismatch");
      await mkdir(join(packageRoot, "build"), { recursive: true });
      await assert.rejects(
        () => stageReleaseResources(parseReleaseEnvironment(setup.env, "darwin"), packageRoot),
        /configuration is invalid|channels must match/u,
      );
    }
  },
);

macReleaseTest(
  "release inputs reject hard links and same-inode mutation during bounded reads",
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "laundry-release-input-snapshot-"));
    t.after(async () => rm(root, { recursive: true }));
    const path = join(root, "input.json");
    await writeFile(path, '{"channel":"stable"}', { mode: 0o600 });
    await assert.rejects(
      () =>
        readReleaseInputFile(path, "release input", 1024, {
          afterOpen: async () => await chmod(path, 0o644),
        }),
      /changed while reading/u,
    );
    await chmod(path, 0o600);
    await assert.rejects(
      () =>
        readReleaseInputFile(path, "release input", 1024, {
          afterOpen: async () => await appendFile(path, " "),
        }),
      /changed while reading/u,
    );
    const linked = join(root, "linked.json");
    await link(path, linked);
    await assert.rejects(
      () => readReleaseInputFile(path, "release input", 1024),
      /one bounded 600 file/u,
    );
  },
);

macReleaseTest(
  "release inspection rejects a thin nested Mach-O and binds app identity",
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "laundry-release-inspection-"));
    t.after(async () => rm(root, { recursive: true }));
    const appPath = join(root, "Laundry Desk.app");
    const main = join(appPath, "Contents", "MacOS", "Laundry Desk");
    const helper = join(appPath, "Contents", "Frameworks", "Helper.framework", "Helper");
    const resources = join(appPath, "Contents", "Resources");
    await mkdir(join(appPath, "Contents"), { recursive: true });
    await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
    await mkdir(join(appPath, "Contents", "Frameworks", "Helper.framework"), { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(main, Buffer.from("cafebabf", "hex"));
    await writeFile(helper, Buffer.from("cafebabf", "hex"));

    const signing = [
      "Identifier=com.laundry-desk.v2",
      "TeamIdentifier=ABCDE12345",
      `CDHash=${"a".repeat(40)}`,
      '# designated => identifier "com.laundry-desk.v2" and anchor apple generic',
    ].join("\n");
    const fakeRun = async (file, args) => {
      if (file.endsWith("PlistBuddy")) {
        if (args[1].includes("CFBundleExecutable")) return { stdout: "Laundry Desk\n", stderr: "" };
        if (args[1].includes("CFBundleShortVersionString"))
          return { stdout: "1.2.3\n", stderr: "" };
        return { stdout: "com.laundry-desk.v2\n", stderr: "" };
      }
      if (file.endsWith("lipo")) {
        return { stdout: args[1] === helper ? "arm64\n" : "arm64 x86_64\n", stderr: "" };
      }
      if (args.includes("--display")) return { stdout: "", stderr: signing };
      return { stdout: "", stderr: "" };
    };
    await assert.rejects(
      () => inspectSignedUniversalApplication(appPath, fakeRun),
      /every packaged Mach-O/u,
    );

    const universal = await inspectSignedUniversalApplication(appPath, async (file, args) => {
      const result = await fakeRun(file, args);
      return file.endsWith("lipo") ? { stdout: "x86_64 arm64\n", stderr: "" } : result;
    });
    assert.deepEqual(universal.machOFiles, [
      "Contents/Frameworks/Helper.framework/Helper",
      "Contents/MacOS/Laundry Desk",
    ]);
    assert.throws(
      () => assertEquivalentApplication(universal, { ...universal, cdHash: "b".repeat(40) }, "ZIP"),
      /ZIP app identity does not match/u,
    );
    assertExpectedApplication(universal, {
      bundleIdentifier: "com.laundry-desk.v2",
      version: "1.2.3",
      teamIdentifier: "ABCDE12345",
    });
    for (const expected of [
      { bundleIdentifier: "com.attacker.app", version: "1.2.3", teamIdentifier: "ABCDE12345" },
      { bundleIdentifier: "com.laundry-desk.v2", version: "9.9.9", teamIdentifier: "ABCDE12345" },
      { bundleIdentifier: "com.laundry-desk.v2", version: "1.2.3", teamIdentifier: "ZZZZZ99999" },
    ]) {
      assert.throws(() => assertExpectedApplication(universal, expected), /configured release/u);
    }

    const symlinkPath = join(resources, "link");
    await writeFile(join(resources, "target"), "target");
    await symlink("target", symlinkPath);
    await inspectSignedUniversalApplication(appPath, async (file, args) => {
      const result = await fakeRun(file, args);
      return file.endsWith("lipo") ? { stdout: "x86_64 arm64\n", stderr: "" } : result;
    });
    await unlink(symlinkPath);
    for (const [target, message] of [
      [join(root, "outside"), /absolute symlink/u],
      ["../../../../outside", /escapes its root/u],
      ["missing", /broken symlink/u],
    ]) {
      await symlink(target, symlinkPath);
      await assert.rejects(
        () =>
          inspectSignedUniversalApplication(appPath, async (file, args) => {
            const result = await fakeRun(file, args);
            return file.endsWith("lipo") ? { stdout: "x86_64 arm64\n", stderr: "" } : result;
          }),
        message,
      );
      await unlink(symlinkPath);
    }
  },
);

test("release root is an exact app, DMG, ZIP, and optional manifest allowlist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-root-shape-"));
  t.after(async () => rm(root, { recursive: true }));
  const appPath = join(root, "mac-universal", "Laundry Desk.app");
  await mkdir(appPath, { recursive: true });
  await writeFile(join(root, "Laundry.dmg"), "dmg");
  await writeFile(join(root, "Laundry.zip"), "zip");
  assert.equal((await locateReleaseArtifacts(root)).appPath, appPath);

  const sensitive = join(root, "update-private-key.pem");
  await writeFile(sensitive, "secret");
  await assert.rejects(() => locateReleaseArtifacts(root), /exactly one app/u);
  await unlink(sensitive);
  const linked = join(root, "extra-link");
  await symlink("Laundry.zip", linked);
  await assert.rejects(() => locateReleaseArtifacts(root), /must not contain symlinks/u);
});

test("failed release transaction erases partial artifacts before atomic publish", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-transaction-"));
  t.after(async () => rm(root, { recursive: true }));
  await assert.rejects(
    () =>
      withAtomicReleaseDirectory(root, async ({ stagingDirectory }) => {
        await writeFile(join(stagingDirectory, "partial.zip"), "partial");
        throw new Error("simulated release failure");
      }),
    /simulated release failure/u,
  );
  await assert.rejects(() => access(join(root, "release")), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(root, "build")), []);

  const completed = await withAtomicReleaseDirectory(root, async ({ stagingDirectory }) => {
    await writeFile(join(stagingDirectory, "complete.zip"), "complete");
    return "validated";
  });
  assert.equal(completed.result, "validated");
  assert.equal(await readFile(join(root, "release", "complete.zip"), "utf8"), "complete");
});

test("the final before-commit gate runs after staging and blocks atomic publish", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-final-gate-"));
  t.after(async () => rm(root, { recursive: true }));
  await assert.rejects(
    () =>
      withAtomicReleaseDirectory(root, async ({ stagingDirectory, setBeforeCommit }) => {
        const artifact = join(stagingDirectory, "release.zip");
        await writeFile(artifact, "validated");
        setBeforeCommit(async () => {
          assert.equal(await readFile(artifact, "utf8"), "validated");
          throw new Error("final release verification failed");
        });
      }),
    /final release verification failed/u,
  );
  await assert.rejects(() => access(join(root, "release")), { code: "ENOENT" });
});

test("commit rechecks the sealed staging object and rejects post-verifier mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-seal-recheck-"));
  t.after(async () => rm(root, { recursive: true }));
  await assert.rejects(
    () =>
      withAtomicReleaseDirectory(root, async ({ stagingDirectory, setBeforeCommit }) => {
        const artifact = join(stagingDirectory, "release.zip");
        await writeFile(artifact, "verified");
        await sealReleaseTreePermissions([artifact]);
        setBeforeCommit(async () => {
          const seal = await createReleaseTreeVersion(stagingDirectory);
          await chmod(artifact, 0o600);
          return seal;
        });
      }),
    /changed after final verification|remains writable/u,
  );
  await assert.rejects(() => access(join(root, "release")), { code: "ENOENT" });
});

test("commit never replaces a destination created after the availability check", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-no-replace-"));
  t.after(async () => rm(root, { recursive: true }));
  await assert.rejects(
    () =>
      withAtomicReleaseDirectory(
        root,
        async ({ stagingDirectory, setBeforeCommit }) => {
          const artifact = join(stagingDirectory, "release.zip");
          await writeFile(artifact, "verified");
          await sealReleaseTreePermissions([artifact]);
          setBeforeCommit(async () => await createReleaseTreeVersion(stagingDirectory));
        },
        {
          renameExclusive: async (_source, destination) => {
            await mkdir(destination);
            const error = new Error("destination exists");
            error.code = "EEXIST";
            throw error;
          },
        },
      ),
    /destination exists/u,
  );
  assert.equal((await lstat(join(root, "release"))).isDirectory(), true);
  assert.deepEqual(await readdir(join(root, "release")), []);
});

test("post-commit cleanup failure cannot turn a published release into failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-release-commit-point-"));
  t.after(async () => rm(root, { recursive: true }));
  const warnings = [];
  const originalError = console.error;
  console.error = (...values) => warnings.push(values);
  try {
    const completed = await withAtomicReleaseDirectory(
      root,
      async ({ stagingDirectory }) => {
        await writeFile(join(stagingDirectory, "complete.zip"), "complete");
        return "committed";
      },
      {
        remove: async () => {
          throw new Error("cleanup remove failed");
        },
        unlink: async () => {
          throw new Error("cleanup unlink failed");
        },
      },
    );
    assert.equal(completed.result, "committed");
    assert.equal(await readFile(join(root, "release", "complete.zip"), "utf8"), "complete");
    assert.deepEqual(warnings, [["[release:mac] post-commit cleanup incomplete", 2]]);
  } finally {
    console.error = originalError;
  }
});
