import { execFile, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateReleaseApplicationEquivalence } from "./release-inspection.mjs";
import { createReleaseInputDescriptor, stageReleaseResources } from "./release-resources.mjs";
import { withAtomicReleaseDirectory } from "./release-transaction.mjs";
import { createReleaseTreeVersion, sealReleaseTreePermissions } from "./release-tree.mjs";

export { stageReleaseResources } from "./release-resources.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/u;
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const FORBIDDEN_AUTH_ENV = [
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
];
const PASSTHROUGH_ENV = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "PNPM_HOME",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
];

function requiredEnvironment(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function requireCanonicalAbsolutePath(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return value;
}

export function parseReleaseEnvironment(env = process.env, platform = process.platform) {
  if (platform !== "darwin") throw new Error("macOS release requires Darwin");
  for (const key of FORBIDDEN_AUTH_ENV) {
    if (env[key] !== undefined)
      throw new Error(`${key} is not accepted by the keychain-only release`);
  }
  const identity = requiredEnvironment(env, "CSC_NAME");
  const identityMatch = identity.match(/^Developer ID Application: (.+) \(([A-Z0-9]{10})\)$/u);
  if (identityMatch === null || !SAFE_NAME.test(identityMatch[1])) {
    throw new Error("CSC_NAME must be one exact Developer ID Application identity");
  }
  const keychain = requireCanonicalAbsolutePath(
    requiredEnvironment(env, "APPLE_KEYCHAIN"),
    "APPLE_KEYCHAIN",
  );
  const profile = requiredEnvironment(env, "APPLE_KEYCHAIN_PROFILE");
  if (!SAFE_PROFILE.test(profile)) throw new Error("APPLE_KEYCHAIN_PROFILE is invalid");
  return Object.freeze({
    identity,
    teamIdentifier: identityMatch[2],
    keychain,
    profile,
    privateKeyPath: requireCanonicalAbsolutePath(
      requiredEnvironment(env, "LAUNDRY_UPDATE_PRIVATE_KEY_FILE"),
      "LAUNDRY_UPDATE_PRIVATE_KEY_FILE",
    ),
    publicKeyPath: requireCanonicalAbsolutePath(
      requiredEnvironment(env, "LAUNDRY_UPDATE_PUBLIC_KEY_FILE"),
      "LAUNDRY_UPDATE_PUBLIC_KEY_FILE",
    ),
    policyPath: requireCanonicalAbsolutePath(
      requiredEnvironment(env, "LAUNDRY_RELEASE_POLICY_FILE"),
      "LAUNDRY_RELEASE_POLICY_FILE",
    ),
    updateConfigPath: requireCanonicalAbsolutePath(
      requiredEnvironment(env, "LAUNDRY_UPDATE_CONFIG_FILE"),
      "LAUNDRY_UPDATE_CONFIG_FILE",
    ),
  });
}

function selectedEnvironment(env) {
  return Object.fromEntries(
    PASSTHROUGH_ENV.flatMap((key) => (typeof env[key] === "string" ? [[key, env[key]]] : [])),
  );
}

export function createReleaseBuildEnvironment(
  env,
  releaseEnvironment,
  stagingDirectory,
  stagedResources,
) {
  const selected = selectedEnvironment(env);
  return Object.freeze({
    ...selected,
    CSC_NAME: releaseEnvironment.identity,
    CSC_KEYCHAIN: releaseEnvironment.keychain,
    APPLE_KEYCHAIN: releaseEnvironment.keychain,
    APPLE_KEYCHAIN_PROFILE: releaseEnvironment.profile,
    LAUNDRY_RELEASE_OUTPUT_DIRECTORY: stagingDirectory,
    LAUNDRY_RELEASE_UPDATE_PUBLIC_KEY_FILE: stagedResources.publicKeyStagingPath,
    LAUNDRY_RELEASE_UPDATE_CONFIG_FILE: stagedResources.updateConfigStagingPath,
  });
}

export function createReleaseSignerEnvironment(releaseEnvironment, stagingDirectory, descriptor) {
  return Object.freeze({
    LAUNDRY_UPDATE_PRIVATE_KEY_FILE: releaseEnvironment.privateKeyPath,
    LAUNDRY_RELEASE_POLICY_FILE: releaseEnvironment.policyPath,
    LAUNDRY_RELEASE_DIRECTORY: stagingDirectory,
    LAUNDRY_RELEASE_INPUT_DESCRIPTOR: JSON.stringify(descriptor),
  });
}

export function createReleaseVerifierEnvironment(stagingDirectory, artifacts, descriptor) {
  return Object.freeze({
    LAUNDRY_RELEASE_DIRECTORY: stagingDirectory,
    LAUNDRY_RELEASE_INPUT_DESCRIPTOR: JSON.stringify(descriptor),
    LAUNDRY_RELEASE_VERIFY_PUBLIC_KEY_FILE: join(
      artifacts.appPath,
      "Contents",
      "Resources",
      "update",
      "update-public-key.pem",
    ),
    LAUNDRY_RELEASE_VERIFY_UPDATE_CONFIG_FILE: join(
      artifacts.appPath,
      "Contents",
      "Resources",
      "update",
      "update-config.json",
    ),
  });
}

export function createReleaseSignerCommand() {
  return Object.freeze({
    file: process.execPath,
    args: Object.freeze(["dist/upgrade/release-bundle-cli.js"]),
  });
}

async function runCaptured(file, args, environment) {
  return await execFileAsync(file, [...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function runVisible(file, args, environment) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, [...args], {
      cwd: packageRoot,
      env: environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${file} exited with status ${String(code)}`));
    });
  });
}

async function preflightApple(releaseEnvironment, environment) {
  const identities = await runCaptured(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning", releaseEnvironment.keychain],
    environment,
  );
  if (
    !identities.stdout.split("\n").some((line) => line.includes(`"${releaseEnvironment.identity}"`))
  ) {
    throw new Error("configured Developer ID identity is not available in the selected keychain");
  }
  await runCaptured(
    "/usr/bin/xcrun",
    [
      "notarytool",
      "history",
      "--keychain",
      releaseEnvironment.keychain,
      "--keychain-profile",
      releaseEnvironment.profile,
      "--output-format",
      "json",
    ],
    environment,
  );
}

export async function locateReleaseArtifacts(releaseDirectory, includesManifest = false) {
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error("release output must not contain symlinks");
  }
  const diskImages = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"));
  const archives = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".zip"));
  const containers = entries.filter((entry) => entry.isDirectory());
  const appPaths = [];
  for (const entry of containers) {
    const children = await readdir(join(releaseDirectory, entry.name), { withFileTypes: true });
    if (
      children.length !== 1 ||
      !children[0]?.isDirectory() ||
      children[0].isSymbolicLink() ||
      !children[0].name.endsWith(".app")
    ) {
      throw new Error("release app container must contain exactly one real app");
    }
    appPaths.push(join(releaseDirectory, entry.name, children[0].name));
  }
  const manifests = entries.filter(
    (entry) => entry.isFile() && entry.name === "latest-laundry-v2.json",
  );
  const expectedCount = includesManifest ? 4 : 3;
  if (
    entries.length !== expectedCount ||
    diskImages.length !== 1 ||
    archives.length !== 1 ||
    containers.length !== 1 ||
    appPaths.length !== 1 ||
    manifests.length !== (includesManifest ? 1 : 0)
  ) {
    throw new Error("release output must contain exactly one app, DMG, and ZIP");
  }
  return Object.freeze({
    appPath: appPaths[0],
    dmgPath: join(releaseDirectory, diskImages[0].name),
    zipPath: join(releaseDirectory, archives[0].name),
  });
}

async function validateReleaseArtifacts(artifacts, environment, expectedIdentity) {
  const application = await validateReleaseApplicationEquivalence(
    artifacts,
    async (file, args) => await runCaptured(file, args, environment),
    expectedIdentity,
  );
  await runCaptured(
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", "--verbose=4", artifacts.appPath],
    environment,
  );
  await runCaptured("/usr/bin/xcrun", ["stapler", "validate", artifacts.appPath], environment);
  await runCaptured("/usr/bin/xcrun", ["stapler", "validate", artifacts.dmgPath], environment);
  await runCaptured(
    "/usr/sbin/spctl",
    ["--assess", "--type", "open", "--context", "context:primary-signature", artifacts.dmgPath],
    environment,
  );
  return application;
}

async function readPackageVersion() {
  const candidate = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !SAFE_VERSION.test(candidate.version)
  ) {
    throw new Error("package version is invalid");
  }
  return candidate.version;
}

export async function runMacRelease(env = process.env) {
  const releaseEnvironment = parseReleaseEnvironment(env);
  const version = await readPackageVersion();
  const transaction = await withAtomicReleaseDirectory(
    packageRoot,
    async ({ stagingRoot, stagingDirectory, setBeforeCommit }) => {
      const staged = await stageReleaseResources(releaseEnvironment, stagingRoot);
      const buildEnvironment = createReleaseBuildEnvironment(
        env,
        releaseEnvironment,
        stagingDirectory,
        staged,
      );
      await preflightApple(releaseEnvironment, buildEnvironment);
      await runVisible(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=@laundry/edge-agent"],
        buildEnvironment,
      );
      await runVisible("pnpm", ["run", "preload:bundle"], buildEnvironment);
      await runVisible(
        "pnpm",
        [
          "exec",
          "electron-builder",
          "--config",
          "electron-builder.release.yml",
          "--mac",
          "--publish",
          "never",
        ],
        buildEnvironment,
      );
      const artifacts = await locateReleaseArtifacts(stagingDirectory);
      const application = await validateReleaseArtifacts(artifacts, buildEnvironment, {
        bundleIdentifier: "com.laundry-desk.v2",
        version,
        teamIdentifier: releaseEnvironment.teamIdentifier,
      });
      await sealReleaseTreePermissions([artifacts.appPath, artifacts.dmgPath, artifacts.zipPath]);
      const descriptor = await createReleaseInputDescriptor(
        staged,
        artifacts,
        version,
        application,
      );
      const signer = createReleaseSignerCommand();
      await runVisible(
        signer.file,
        signer.args,
        createReleaseSignerEnvironment(releaseEnvironment, stagingDirectory, descriptor),
      );
      setBeforeCommit(async () => {
        const current = await locateReleaseArtifacts(stagingDirectory, true);
        if (
          current.appPath !== artifacts.appPath ||
          current.dmgPath !== artifacts.dmgPath ||
          current.zipPath !== artifacts.zipPath
        ) {
          throw new Error("release artifacts changed before final verification");
        }
        await sealReleaseTreePermissions(
          (await readdir(stagingDirectory)).map((name) => join(stagingDirectory, name)),
        );
        await runVisible(
          signer.file,
          signer.args,
          createReleaseVerifierEnvironment(stagingDirectory, artifacts, descriptor),
        );
        await sealReleaseTreePermissions(
          (await readdir(stagingDirectory)).map((name) => join(stagingDirectory, name)),
        );
        return await createReleaseTreeVersion(stagingDirectory);
      });
      return Object.freeze({
        appRelativePath: relative(stagingDirectory, artifacts.appPath),
        dmgName: basename(artifacts.dmgPath),
        zipName: basename(artifacts.zipPath),
      });
    },
  );
  return Object.freeze({
    ok: true,
    appPath: join(transaction.finalDirectory, transaction.result.appRelativePath),
    dmgPath: join(transaction.finalDirectory, transaction.result.dmgName),
    zipPath: join(transaction.finalDirectory, transaction.result.zipName),
  });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runMacRelease()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const message = error instanceof Error ? error.message : "macOS release failed";
      process.stderr.write(`[release:mac] ${message}\n`);
      process.exitCode = 1;
    });
}
