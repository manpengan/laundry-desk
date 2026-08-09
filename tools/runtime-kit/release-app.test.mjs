import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildRuntimeApp, copyTrustedKey, parseRuntimeBuildArguments } from "./build-app.mjs";
import { inspectRuntimeApp, parseRuntimeArchitectures } from "./inspect-app.mjs";
import { createRuntimeArtifactSeal, verifyRuntimeReleaseArtifacts } from "./release-artifacts.mjs";
import {
  createRuntimeReleaseChildEnvironment,
  createRuntimeReleasePlan,
  parseRuntimeReleaseEnvironment,
  runRuntimeRelease,
  stageRuntimeManifestPublicKey,
} from "./release-app.mjs";

test("Runtime build and inspect accept only the fixed universal contract", async () => {
  assert.deepEqual(parseRuntimeBuildArguments([]), { release: false, testing: false });
  assert.deepEqual(parseRuntimeBuildArguments(["--testing"]), { release: false, testing: true });
  assert.deepEqual(parseRuntimeBuildArguments(["--release"]), { release: true, testing: false });
  assert.deepEqual(
    parseRuntimeBuildArguments([
      "--testing",
      "--testing-signing-key-output",
      "/private/tmp/runtime-private.pem",
      "--testing-output-root",
      "/private/tmp/runtime-app",
    ]),
    {
      release: false,
      testing: true,
      testingSigningKeyPath: "/private/tmp/runtime-private.pem",
      testingOutputRoot: "/private/tmp/runtime-app",
    },
  );
  assert.throws(() => parseRuntimeBuildArguments(["--release", "extra"]), /ARGS_INVALID/u);
  await assert.rejects(() => buildRuntimeApp({ release: true, testing: true }), /OPTIONS_INVALID/u);
  assert.deepEqual(parseRuntimeArchitectures("x86_64 arm64\n"), ["arm64", "x86_64"]);
  assert.throws(() => parseRuntimeArchitectures("arm64\n"));
});

test("testing Runtime builds can write isolated private signing keys", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-runtime-build-key-")));
  t.after(async () => removeTestTree(root));
  const builds = await Promise.all(
    ["first", "second"].map(async (name) => {
      const privateRoot = join(root, name);
      const resources = join(root, `${name}-resources`);
      await mkdir(privateRoot, { mode: 0o700 });
      await mkdir(resources, { mode: 0o700 });
      const privateKeyPath = join(privateRoot, "runtime-test-signing-private.pem");
      await copyTrustedKey(resources, {
        release: false,
        testing: true,
        testingSigningKeyPath: privateKeyPath,
      });
      return Object.freeze({
        key: await readFile(privateKeyPath, "utf8"),
        keyMode: (await lstat(privateKeyPath)).mode & 0o777,
      });
    }),
  );
  assert.ok(builds.every((build) => build.keyMode === 0o600));
  assert.notEqual(builds[0].key, builds[1].key);

  const insecureRoot = join(root, "insecure");
  await mkdir(insecureRoot, { mode: 0o755 });
  await assert.rejects(
    () =>
      copyTrustedKey(join(root, "first-resources"), {
        release: false,
        testing: true,
        testingSigningKeyPath: join(insecureRoot, "private.pem"),
      }),
    /RUNTIME_BUILD_TESTING_KEY_PATH_INVALID/u,
  );
  await assert.rejects(
    () =>
      copyTrustedKey(join(root, "first-resources"), {
        release: false,
        testing: true,
        testingSigningKeyPath: "relative/private.pem",
      }),
    /RUNTIME_BUILD_TESTING_KEY_PATH_INVALID/u,
  );
  await assert.rejects(
    () =>
      copyTrustedKey(join(root, "first-resources"), {
        release: false,
        testing: true,
        testingSigningKeyPath: join(root, "first", "runtime-test-signing-private.pem"),
      }),
    /RUNTIME_BUILD_TESTING_KEY_PREEXISTS/u,
  );
});

test("concurrent testing Runtime builds own separate apps and matching signing keys", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-runtime-build-isolated-")));
  t.after(async () => removeTestTree(root));
  const results = await Promise.all(
    ["first", "second"].map(async (name) => {
      const temporaryRoot = join(root, name);
      const testingOutputRoot = join(temporaryRoot, "runtime-app");
      const testingSigningKeyPath = join(temporaryRoot, "runtime-test-signing-private.pem");
      const compilerOutputs = [];
      const execute = async (file, arguments_) => {
        if (file === "/usr/bin/xcrun" || file === "/usr/bin/lipo") {
          const output = arguments_.at(-1);
          if (file === "/usr/bin/xcrun") compilerOutputs.push(output);
          await writeFile(output, file === "/usr/bin/xcrun" ? "architecture" : "universal");
        }
        return { stderr: "", stdout: "" };
      };
      await mkdir(temporaryRoot, { mode: 0o700 });
      await mkdir(testingOutputRoot, { mode: 0o700 });
      const appRoot = await buildRuntimeApp(
        {
          release: false,
          testing: true,
          testingOutputRoot,
          testingSigningKeyPath,
        },
        { execute },
      );
      const privateKey = await readFile(testingSigningKeyPath, "utf8");
      const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
      const expectedPublicKey = publicDer.subarray(publicDer.length - 32).toString("base64url");
      const embeddedPublicKey = await readFile(
        join(appRoot, "Contents/Resources/trusted-manifest-public-key.txt"),
        "utf8",
      );
      assert.equal(embeddedPublicKey, `${expectedPublicKey}\n`);
      assert.equal((await lstat(testingSigningKeyPath)).mode & 0o777, 0o600);
      return Object.freeze({ appRoot, compilerOutputs, embeddedPublicKey, privateKey });
    }),
  );
  assert.notEqual(results[0].appRoot, results[1].appRoot);
  assert.notEqual(results[0].privateKey, results[1].privateKey);
  assert.notEqual(results[0].embeddedPublicKey, results[1].embeddedPublicKey);
  for (const [index, name] of ["first", "second"].entries()) {
    const privateBuildRoot = join(root, name, "runtime-app");
    assert.equal(results[index].appRoot, join(privateBuildRoot, "Laundry Desk Runtime Test.app"));
    assert.equal(results[index].compilerOutputs.length, 2);
    for (const output of results[index].compilerOutputs) {
      assert.equal(output.startsWith(`${privateBuildRoot}/architectures-`), true);
    }
  }
});

test("isolated testing Runtime output fails closed before replacing an app", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-runtime-build-output-")));
  t.after(async () => removeTestTree(root));
  const testingOutputRoot = join(root, "runtime-app");
  const appRoot = join(testingOutputRoot, "Laundry Desk Runtime Test.app");
  await mkdir(testingOutputRoot, { mode: 0o700 });
  await mkdir(appRoot, { mode: 0o700 });
  let executed = false;
  await assert.rejects(
    () =>
      buildRuntimeApp(
        {
          release: false,
          testing: true,
          testingOutputRoot,
          testingSigningKeyPath: join(root, "runtime-test-signing-private.pem"),
        },
        {
          execute: async () => {
            executed = true;
            return { stderr: "", stdout: "" };
          },
        },
      ),
    /RUNTIME_BUILD_TESTING_APP_PREEXISTS/u,
  );
  assert.equal(executed, false);
  assert.ok((await lstat(appRoot)).isDirectory());

  await assert.rejects(
    () =>
      buildRuntimeApp({
        release: false,
        testing: true,
        testingSigningKeyPath: join(root, "another-private.pem"),
      }),
    /RUNTIME_BUILD_OPTIONS_INVALID/u,
  );
  for (const boundary of ["permissions", "symlink", "noncanonical"]) {
    const boundaryRoot = join(root, boundary);
    const privateKeyPath = join(boundaryRoot, "runtime-test-signing-private.pem");
    const outputRoot = join(boundaryRoot, "runtime-app");
    await mkdir(boundaryRoot, { mode: 0o700 });
    if (boundary === "permissions") await mkdir(outputRoot, { mode: 0o755 });
    if (boundary === "symlink") {
      const realOutput = join(boundaryRoot, "real-output");
      await mkdir(realOutput, { mode: 0o700 });
      await symlink(realOutput, outputRoot);
    }
    if (boundary === "noncanonical") await mkdir(outputRoot, { mode: 0o700 });
    await assert.rejects(
      () =>
        buildRuntimeApp(
          {
            release: false,
            testing: true,
            testingOutputRoot:
              boundary === "noncanonical" ? `${boundaryRoot}/nested/../runtime-app` : outputRoot,
            testingSigningKeyPath: privateKeyPath,
          },
          {
            execute: async () => {
              throw new Error("RUNTIME_BUILD_TEST_BOUNDARY_EXECUTED");
            },
          },
        ),
      /RUNTIME_BUILD_TESTING_OUTPUT_ROOT_INVALID/u,
    );
  }
});

async function fakeRuntimeApp(appRoot, publicKey = "A".repeat(43)) {
  await mkdir(join(appRoot, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(appRoot, "Contents", "Resources"), { recursive: true });
  await writeFile(join(appRoot, "Contents", "MacOS", "Laundry Desk Runtime"), "main", {
    mode: 0o755,
  });
  await writeFile(
    join(appRoot, "Contents", "Resources", "docker-compose.runtime.yml"),
    "services:\n  postgres:\n    image: postgres:16\n",
  );
  await writeFile(
    join(appRoot, "Contents", "Resources", "docker-compose.runtime-lan.yml"),
    "services:\n  lan-gateway:\n    image: laundry/server@sha256:fixture\n",
  );
  await writeFile(
    join(appRoot, "Contents", "Resources", "trusted-manifest-public-key.txt"),
    `${publicKey}\n`,
  );
}

async function removeTestTree(root) {
  async function makeOwnerWritable(path) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      await chmod(path, 0o700);
      for (const child of await readdir(path)) await makeOwnerWritable(join(path, child));
      return;
    }
    await chmod(path, 0o600);
  }
  await makeOwnerWritable(root);
  await rm(root, { recursive: true, force: true });
}

test("Runtime inspection enforces universal architecture on every Mach-O only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-runtime-inspect-"));
  t.after(async () => removeTestTree(root));
  const appRoot = join(root, "Laundry Desk Runtime.app");
  const executable = join(appRoot, "Contents", "MacOS", "Laundry Desk Runtime");
  const helper = join(appRoot, "Contents", "Frameworks", "Runtime Helper");
  await fakeRuntimeApp(appRoot);
  await mkdir(dirname(helper), { recursive: true });
  await writeFile(helper, "helper");
  const lipoPaths = [];
  const execute = async (file, arguments_) => {
    const path = arguments_.at(-1);
    if (file === "/usr/bin/file") {
      return {
        stdout:
          path === executable || path === helper ? "Mach-O universal binary\n" : "ASCII text\n",
        stderr: "",
      };
    }
    if (file === "/usr/bin/lipo") {
      lipoPaths.push(path);
      return { stdout: "x86_64 arm64\n", stderr: "" };
    }
    assert.equal(file, "/usr/bin/codesign");
    return { stdout: "", stderr: "" };
  };
  const inspected = await inspectRuntimeApp(appRoot, { execute });
  assert.deepEqual(lipoPaths.sort(), [executable, helper].sort());
  assert.deepEqual([...inspected.machOBinaries].sort(), [
    "Contents/Frameworks/Runtime Helper",
    "Contents/MacOS/Laundry Desk Runtime",
  ]);

  await assert.rejects(
    () =>
      inspectRuntimeApp(appRoot, {
        execute: async (file, arguments_) => {
          const path = arguments_.at(-1);
          if (file === "/usr/bin/file") {
            return {
              stdout:
                path === executable || path === helper ? "Mach-O 64-bit executable\n" : "data\n",
              stderr: "",
            };
          }
          if (file === "/usr/bin/lipo") {
            return { stdout: path === helper ? "arm64\n" : "arm64 x86_64\n", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      }),
    /Expected values to be strictly deep-equal/u,
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-runtime-release-"));
  t.after(async () => removeTestTree(root));
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const publicKeyPath = join(root, "manifest-public.txt");
  const keychain = join(root, "release.keychain-db");
  await writeFile(publicKeyPath, `${spki.subarray(spki.length - 32).toString("base64url")}\n`, {
    mode: 0o600,
  });
  await writeFile(keychain, "fixture");
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    DATABASE_URL: "must-not-pass",
    LAUNDRY_RUNTIME_CODESIGN_IDENTITY: "Developer ID Application: Laundry Desk (ABCDE12345)",
    LAUNDRY_RUNTIME_APPLE_KEYCHAIN: keychain,
    LAUNDRY_RUNTIME_NOTARY_PROFILE: "laundry-runtime-notary",
    LAUNDRY_RUNTIME_MANIFEST_PUBLIC_KEY_FILE: publicKeyPath,
  };
  const repositoryRoot = join(root, "repository");
  const kitRoot = join(repositoryRoot, "tools", "runtime-kit");
  await mkdir(join(kitRoot, "Sources"), { recursive: true });
  await mkdir(join(repositoryRoot, "tools", "compose"), { recursive: true });
  await writeFile(join(kitRoot, "build-app.mjs"), "// fixture build\n");
  await writeFile(join(kitRoot, "inspect-app.mjs"), "// fixture inspect\n");
  await writeFile(join(kitRoot, "Sources", "main.swift"), "// fixture source\n");
  await writeFile(
    join(repositoryRoot, "tools", "compose", "docker-compose.runtime.yml"),
    "services: {}\n",
  );
  await writeFile(
    join(repositoryRoot, "tools", "compose", "docker-compose.runtime-lan.yml"),
    "services: {}\n",
  );
  return { root, env, kitRoot, publicKeyPath };
}

test("Runtime release requires keychain, notary profile, identity, and public key", async (t) => {
  const setup = await fixture(t);
  const parsed = parseRuntimeReleaseEnvironment(setup.env, "darwin");
  assert.equal(parsed.profile, "laundry-runtime-notary");
  assert.throws(
    () => parseRuntimeReleaseEnvironment({ ...setup.env, APPLE_ID: "forbidden" }, "darwin"),
    /APPLE_ID/u,
  );
  assert.throws(
    () =>
      parseRuntimeReleaseEnvironment(
        { ...setup.env, LAUNDRY_RUNTIME_CODESIGN_IDENTITY: "Developer ID Application: x;rm" },
        "darwin",
      ),
    /CODESIGN_IDENTITY/u,
  );
  assert.throws(() => parseRuntimeReleaseEnvironment(setup.env, "linux"), /requires Darwin/u);
});

test("credential-free release fails before executing any external command", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runRuntimeRelease(
        {},
        {
          platform: "darwin",
          execute: async () => {
            calls += 1;
            return { stdout: "", stderr: "" };
          },
        },
      ),
    /LAUNDRY_RUNTIME_CODESIGN_IDENTITY is required/u,
  );
  assert.equal(calls, 0);
});

test("invalid manifest public key fails before keychain or notary access", async (t) => {
  const setup = await fixture(t);
  await writeFile(setup.publicKeyPath, "invalid\n");
  let calls = 0;
  await assert.rejects(
    () =>
      runRuntimeRelease(setup.env, {
        platform: "darwin",
        kitRoot: setup.root,
        execute: async () => {
          calls += 1;
          return { stdout: "", stderr: "" };
        },
      }),
    /public key is invalid/u,
  );
  assert.equal(calls, 0);
});

test("release child environment and command plan exclude unrelated host secrets", async (t) => {
  const setup = await fixture(t);
  const parsed = parseRuntimeReleaseEnvironment(setup.env, "darwin");
  const child = createRuntimeReleaseChildEnvironment(setup.env, parsed);
  assert.equal(child.DATABASE_URL, undefined);
  assert.equal(child.LAUNDRY_RUNTIME_MANIFEST_PUBLIC_KEY_FILE, undefined);
  assert.equal(child.CSC_NAME, parsed.identity);
  const plan = createRuntimeReleasePlan(parsed, setup.root);
  assert.deepEqual(plan[0].args.slice(-1), ["--release"]);
  assert.equal(
    plan.some((step) => step.file === "/bin/sh"),
    false,
  );
  assert.equal(
    plan.some((step) => step.args.some((argument) => argument === setup.env.DATABASE_URL)),
    false,
  );
  assert.equal(
    plan.filter((step) => step.args.includes("notarytool") && step.args.includes("submit")).length,
    2,
  );
});

test("release staging accepts only a bounded raw Ed25519 public key", async (t) => {
  const setup = await fixture(t);
  const parsed = parseRuntimeReleaseEnvironment(setup.env, "darwin");
  const staged = await stageRuntimeManifestPublicKey(parsed, setup.root);
  assert.equal(await readFile(staged.path, "utf8"), await readFile(setup.publicKeyPath, "utf8"));

  const invalid = await fixture(t);
  await writeFile(invalid.publicKeyPath, "not-a-key\n");
  await assert.rejects(
    () =>
      stageRuntimeManifestPublicKey(
        parseRuntimeReleaseEnvironment(invalid.env, "darwin"),
        invalid.root,
      ),
    /public key is invalid/u,
  );
});

test("release public key rejects permissive permissions and hard links", async (t) => {
  const permissive = await fixture(t);
  await chmod(permissive.publicKeyPath, 0o644);
  await assert.rejects(
    () =>
      stageRuntimeManifestPublicKey(
        parseRuntimeReleaseEnvironment(permissive.env, "darwin"),
        permissive.root,
      ),
    /0600/u,
  );

  const linked = await fixture(t);
  await link(linked.publicKeyPath, join(linked.root, "second-public-key-link"));
  await assert.rejects(
    () =>
      stageRuntimeManifestPublicKey(
        parseRuntimeReleaseEnvironment(linked.env, "darwin"),
        linked.root,
      ),
    /single-link/u,
  );
});

test("Runtime release refuses an existing destination without deleting it", async (t) => {
  const setup = await fixture(t);
  const finalRoot = join(setup.kitRoot, "dist", "release");
  const sentinel = join(finalRoot, "owned-by-user.txt");
  await mkdir(finalRoot, { recursive: true });
  await writeFile(sentinel, "keep\n");
  let calls = 0;
  await assert.rejects(
    () =>
      runRuntimeRelease(setup.env, {
        platform: "darwin",
        kitRoot: setup.kitRoot,
        execute: async () => {
          calls += 1;
          return { stdout: "", stderr: "" };
        },
      }),
    /destination already exists/u,
  );
  assert.equal(calls, 0);
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
});

function successfulCredentialOutput(setup, file, arguments_) {
  if (file === "/usr/bin/security") {
    return {
      stdout: `1) ABCDEF "${setup.env.LAUNDRY_RUNTIME_CODESIGN_IDENTITY}"\n`,
      stderr: "",
    };
  }
  if (file === "/usr/bin/xcrun" && arguments_.includes("history")) {
    return { stdout: "{}\n", stderr: "" };
  }
  return undefined;
}

function successfulReleaseExecutor(setup) {
  return async (file, arguments_) => {
    const credential = successfulCredentialOutput(setup, file, arguments_);
    if (credential !== undefined) return credential;
    if (file === process.execPath && arguments_.at(-1) === "--release") {
      const stagedKitRoot = dirname(arguments_[0]);
      const stagedComposeRoot = join(stagedKitRoot, "..", "compose");
      assert.equal(
        await readFile(join(stagedComposeRoot, "docker-compose.runtime.yml"), "utf8"),
        "services: {}\n",
      );
      assert.equal(
        await readFile(join(stagedComposeRoot, "docker-compose.runtime-lan.yml"), "utf8"),
        "services: {}\n",
      );
      const appRoot = join(stagedKitRoot, "dist", "Laundry Desk Runtime.app");
      await fakeRuntimeApp(appRoot, (await readFile(setup.publicKeyPath, "utf8")).trim());
    }
    const destination = arguments_.at(-1);
    if (file === "/usr/bin/ditto" && arguments_[0] === "-c") {
      await writeFile(destination, "ZIP");
    }
    if (file === "/usr/bin/hdiutil" && arguments_[0] === "create") {
      await writeFile(destination, "DMG");
    }
    return { stdout: "", stderr: "" };
  };
}

test("failed Runtime release removes its unique workspace and partial ZIP", async (t) => {
  const setup = await fixture(t);
  let partialZip;
  await assert.rejects(
    () =>
      runRuntimeRelease(setup.env, {
        platform: "darwin",
        kitRoot: setup.kitRoot,
        execute: async (file, arguments_) => {
          const credential = successfulCredentialOutput(setup, file, arguments_);
          if (credential !== undefined) return credential;
          const destination = arguments_.at(-1);
          if (file === "/usr/bin/ditto" && destination?.endsWith(".notary-upload.zip")) {
            await writeFile(destination, "temporary notary ZIP");
          }
          if (file === "/usr/bin/ditto" && destination?.endsWith("-universal.zip")) {
            partialZip = destination;
            await writeFile(destination, "partial ZIP");
            throw new Error("simulated ZIP failure");
          }
          return { stdout: "", stderr: "" };
        },
      }),
    /simulated ZIP failure/u,
  );
  assert.equal(typeof partialZip, "string");
  await assert.rejects(() => readFile(partialZip), { code: "ENOENT" });
  await assert.rejects(() => readdir(join(setup.kitRoot, "dist", "release")), {
    code: "ENOENT",
  });
  const buildEntries = await readdir(join(setup.kitRoot, "build"));
  assert.equal(
    buildEntries.some((entry) => entry.startsWith(".release-work-")),
    false,
  );
});

test("successful Runtime release atomically publishes only complete artifacts", async (t) => {
  const setup = await fixture(t);
  let stagedReleaseRoot;
  const result = await runRuntimeRelease(setup.env, {
    platform: "darwin",
    kitRoot: setup.kitRoot,
    execute: successfulReleaseExecutor(setup),
    verifyArtifacts: async (paths) => {
      stagedReleaseRoot = paths.releaseRoot;
      assert.match(paths.releaseRoot, /\.release-work-/u);
      assert.equal((await readFile(paths.zipPath, "utf8")).length > 0, true);
      assert.equal((await readFile(paths.dmgPath, "utf8")).length > 0, true);
      return await createRuntimeArtifactSeal(paths);
    },
  });
  const expectedRoot = join(setup.kitRoot, "dist", "release");
  assert.equal(dirname(result.appPath), expectedRoot);
  assert.deepEqual((await readdir(expectedRoot)).sort(), [
    "Laundry Desk Runtime.app",
    "Laundry-Desk-Runtime-0.1.0-universal.dmg",
    "Laundry-Desk-Runtime-0.1.0-universal.zip",
  ]);
  assert.equal(Number((await lstat(expectedRoot, { bigint: true })).mode & 0o777n), 0o700);
  assert.equal(Number((await lstat(result.zipPath, { bigint: true })).mode & 0o222n), 0);
  assert.equal(Number((await lstat(result.appPath, { bigint: true })).mode & 0o222n), 0);
  assert.equal(
    Number(
      (
        await lstat(join(result.appPath, "Contents", "MacOS", "Laundry Desk Runtime"), {
          bigint: true,
        })
      ).mode & 0o111n,
    ),
    0o111,
  );
  await assert.rejects(() => readdir(stagedReleaseRoot), { code: "ENOENT" });
});

test("Runtime release refuses artifacts changed after verification", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    () =>
      runRuntimeRelease(setup.env, {
        platform: "darwin",
        kitRoot: setup.kitRoot,
        execute: successfulReleaseExecutor(setup),
        verifyArtifacts: async (paths) => {
          const seal = await createRuntimeArtifactSeal(paths);
          await chmod(paths.zipPath, 0o600);
          await writeFile(paths.zipPath, "tampered ZIP");
          return seal;
        },
      }),
    /changed after verification/u,
  );
  await assert.rejects(() => readdir(join(setup.kitRoot, "dist", "release")), {
    code: "ENOENT",
  });
});

test("Runtime release detects ctime-only mutation after the final seal", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    () =>
      runRuntimeRelease(setup.env, {
        platform: "darwin",
        kitRoot: setup.kitRoot,
        execute: successfulReleaseExecutor(setup),
        verifyArtifacts: createRuntimeArtifactSeal,
        beforePublishRename: async (paths) => {
          const originalMode = Number((await lstat(paths.zipPath, { bigint: true })).mode & 0o777n);
          await chmod(paths.zipPath, originalMode | 0o200);
          await chmod(paths.zipPath, originalMode);
        },
      }),
    /changed before publication/u,
  );
  await assert.rejects(() => readdir(join(setup.kitRoot, "dist", "release")), {
    code: "ENOENT",
  });
});

test("Runtime release detects same-byte replacement after the final seal", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    () =>
      runRuntimeRelease(setup.env, {
        platform: "darwin",
        kitRoot: setup.kitRoot,
        execute: successfulReleaseExecutor(setup),
        verifyArtifacts: createRuntimeArtifactSeal,
        beforePublishRename: async (paths) => {
          const rootMode = Number((await lstat(paths.releaseRoot, { bigint: true })).mode & 0o777n);
          const zipMode = Number((await lstat(paths.zipPath, { bigint: true })).mode & 0o777n);
          const replaced = `${paths.zipPath}.replaced`;
          await chmod(paths.releaseRoot, rootMode | 0o200);
          await rename(paths.zipPath, replaced);
          await writeFile(paths.zipPath, "ZIP", { mode: zipMode });
          await chmod(paths.zipPath, zipMode);
          await rm(replaced);
          await chmod(paths.releaseRoot, rootMode);
        },
      }),
    /changed before publication/u,
  );
  await assert.rejects(() => readdir(join(setup.kitRoot, "dist", "release")), {
    code: "ENOENT",
  });
});

test("post-commit cleanup failure reports committed release without false failure", async (t) => {
  const setup = await fixture(t);
  const result = await runRuntimeRelease(setup.env, {
    platform: "darwin",
    kitRoot: setup.kitRoot,
    execute: successfulReleaseExecutor(setup),
    verifyArtifacts: createRuntimeArtifactSeal,
    cleanupWorkspace: async () => {
      throw new Error("simulated cleanup failure");
    },
  });
  assert.equal(result.committed, true);
  assert.equal(result.cleanup, "pending");
  assert.deepEqual((await readdir(join(setup.kitRoot, "dist", "release"))).sort(), [
    "Laundry Desk Runtime.app",
    "Laundry-Desk-Runtime-0.1.0-universal.dmg",
    "Laundry-Desk-Runtime-0.1.0-universal.zip",
  ]);
});

test("ZIP and DMG verification binds both contained apps to the signed app", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-runtime-artifacts-"));
  t.after(async () => removeTestTree(root));
  const appPath = join(root, "source", "Laundry Desk Runtime.app");
  const zipPath = join(root, "runtime.zip");
  const dmgPath = join(root, "runtime.dmg");
  await fakeRuntimeApp(appPath);
  await writeFile(zipPath, "ZIP");
  await writeFile(dmgPath, "DMG");
  let mismatchContainer;
  let packageVersion = "0.1.0";
  const execute = async (file, arguments_) => {
    if (file === "/usr/bin/ditto") {
      await cp(appPath, join(arguments_.at(-1), "Laundry Desk Runtime.app"), { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (file === "/usr/bin/hdiutil" && arguments_[0] === "attach") {
      const mountPoint = arguments_[arguments_.indexOf("-mountpoint") + 1];
      await cp(appPath, join(mountPoint, "Laundry Desk Runtime.app"), { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (file === "/usr/bin/hdiutil") return { stdout: "", stderr: "" };
    if (file === "/usr/libexec/PlistBuddy") {
      return {
        stdout: `${arguments_[1].includes("CFBundleVersion") ? "1" : packageVersion}\n`,
        stderr: "",
      };
    }
    assert.equal(file, "/usr/bin/codesign");
    const inspectedApp = arguments_.at(-1);
    if (arguments_.includes("--requirements")) {
      return { stdout: "", stderr: '# designated => identifier "com.laundry-desk.runtime"\n' };
    }
    const cdHash = inspectedApp.includes(mismatchContainer ?? "\0") ? "b" : "a";
    return {
      stdout: "",
      stderr: [
        "Identifier=com.laundry-desk.runtime",
        "TeamIdentifier=ABCDE12345",
        `CDHash=${cdHash.repeat(40)}`,
      ].join("\n"),
    };
  };
  const paths = { appPath, dmgPath, workspaceRoot: root, zipPath };
  const identity = await verifyRuntimeReleaseArtifacts(paths, {
    execute,
    expectedTeamIdentifier: "ABCDE12345",
    inspectApp: async () => undefined,
  });
  assert.equal(identity.identity.cdHash, "a".repeat(40));

  packageVersion = "9.9.9";
  await assert.rejects(
    () =>
      verifyRuntimeReleaseArtifacts(paths, {
        execute,
        expectedTeamIdentifier: "ABCDE12345",
        inspectApp: async () => undefined,
      }),
    /release contract/u,
  );
  packageVersion = "0.1.0";
  mismatchContainer = "/artifact-validation/dmg/";
  await assert.rejects(
    () =>
      verifyRuntimeReleaseArtifacts(paths, {
        execute,
        expectedTeamIdentifier: "ABCDE12345",
        inspectApp: async () => undefined,
      }),
    /Runtime DMG app code identity differs/u,
  );
});
