import { execFile, spawn } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/u;
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
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
  const identityPrefix = "Developer ID Application: ";
  if (
    !identity.startsWith(identityPrefix) ||
    !SAFE_NAME.test(identity.slice(identityPrefix.length))
  ) {
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
  });
}

export function createReleaseChildEnvironment(env, releaseEnvironment) {
  const selected = Object.fromEntries(
    PASSTHROUGH_ENV.flatMap((key) => (typeof env[key] === "string" ? [[key, env[key]]] : [])),
  );
  return Object.freeze({
    ...selected,
    CSC_NAME: releaseEnvironment.identity,
    CSC_KEYCHAIN: releaseEnvironment.keychain,
    APPLE_KEYCHAIN: releaseEnvironment.keychain,
    APPLE_KEYCHAIN_PROFILE: releaseEnvironment.profile,
    LAUNDRY_UPDATE_PRIVATE_KEY_FILE: releaseEnvironment.privateKeyPath,
    LAUNDRY_UPDATE_PUBLIC_KEY_FILE: releaseEnvironment.publicKeyPath,
    LAUNDRY_RELEASE_POLICY_FILE: releaseEnvironment.policyPath,
  });
}

async function readPrivateFile(path, label, maximumBytes, privateMode) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a real file`);
  if (metadata.size < 1 || metadata.size > maximumBytes)
    throw new Error(`${label} size is invalid`);
  if (privateMode && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must exclude group and other access`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`${label} changed while opening`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function stageUpdatePublicKey(releaseEnvironment, root = packageRoot) {
  const [privateBytes, publicBytes] = await Promise.all([
    readPrivateFile(releaseEnvironment.privateKeyPath, "update private key", 16 * 1024, true),
    readPrivateFile(releaseEnvironment.publicKeyPath, "update public key", 16 * 1024, false),
    readPrivateFile(releaseEnvironment.policyPath, "release policy", 64 * 1024, false),
  ]);
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("update key pair must be Ed25519");
  }
  const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const supplied = publicKey.export({ format: "der", type: "spki" });
  if (!derived.equals(supplied)) throw new Error("update public key does not match private key");

  const stagingDirectory = join(root, "build", "release");
  const stagingPath = join(stagingDirectory, "update-public-key.pem");
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await writeFile(stagingPath, publicKey.export({ format: "pem", type: "spki" }), {
    flag: "wx",
    mode: 0o644,
  });
  return Object.freeze({ stagingDirectory, stagingPath });
}

async function cleanupStagedKey(staged) {
  try {
    await unlink(staged.stagingPath);
    await rmdir(staged.stagingDirectory);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
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
  if (!identities.stdout.includes(releaseEnvironment.identity)) {
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

async function locateReleaseArtifacts() {
  const releaseDirectory = join(packageRoot, "release");
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  const diskImages = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"));
  const archives = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".zip"));
  const appPaths = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const children = await readdir(join(releaseDirectory, entry.name), { withFileTypes: true });
    appPaths.push(
      ...children
        .filter((child) => child.isDirectory() && child.name.endsWith(".app"))
        .map((child) => join(releaseDirectory, entry.name, child.name)),
    );
  }
  if (diskImages.length !== 1 || archives.length !== 1 || appPaths.length !== 1) {
    throw new Error("release output must contain exactly one app, DMG, and ZIP");
  }
  return Object.freeze({
    appPath: appPaths[0],
    dmgPath: join(releaseDirectory, diskImages[0].name),
  });
}

async function validateReleaseArtifacts(artifacts, environment) {
  await runCaptured(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", artifacts.appPath],
    environment,
  );
  await runCaptured(
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", "--verbose=4", artifacts.appPath],
    environment,
  );
  await runCaptured("/usr/bin/xcrun", ["stapler", "validate", artifacts.appPath], environment);
  await runCaptured(
    "/usr/sbin/spctl",
    ["--assess", "--type", "open", "--context", "context:primary-signature", artifacts.dmgPath],
    environment,
  );
}

export async function runMacRelease(env = process.env) {
  const releaseEnvironment = parseReleaseEnvironment(env);
  const childEnvironment = createReleaseChildEnvironment(env, releaseEnvironment);
  await preflightApple(releaseEnvironment, childEnvironment);
  const staged = await stageUpdatePublicKey(releaseEnvironment);
  try {
    await runVisible(
      "pnpm",
      ["exec", "turbo", "run", "build", "--filter=@laundry/edge-agent"],
      childEnvironment,
    );
    await runVisible("pnpm", ["run", "preload:bundle"], childEnvironment);
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
      childEnvironment,
    );
    const artifacts = await locateReleaseArtifacts();
    await validateReleaseArtifacts(artifacts, childEnvironment);
    await runVisible("node", ["dist/upgrade/release-bundle-cli.js"], childEnvironment);
    return Object.freeze({ ok: true, ...artifacts });
  } finally {
    await cleanupStagedKey(staged);
  }
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
