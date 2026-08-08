import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { RUNTIME_APP_VERSION } from "./build-app.mjs";
import {
  assertRuntimeReleaseDestinationAvailable,
  createRuntimeReleaseWorkspace,
  prepareRuntimeReleaseArtifacts,
  publishRuntimeRelease,
  verifyRuntimeReleaseArtifacts,
} from "./release-artifacts.mjs";
const execute = promisify(execFile);
const defaultKitRoot = dirname(fileURLToPath(import.meta.url));
const SAFE_IDENTITY = /^Developer ID Application: [A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/u;
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const RAW_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u;
const PASSTHROUGH_ENV = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
]);
const FORBIDDEN_CREDENTIAL_ENV = Object.freeze([
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
]);
function requiredEnvironment(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}
function canonicalAbsolutePath(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return value;
}

export function parseRuntimeReleaseEnvironment(env = process.env, platform = process.platform) {
  if (platform !== "darwin") throw new Error("Runtime release requires Darwin");
  for (const key of FORBIDDEN_CREDENTIAL_ENV) {
    if (env[key] !== undefined)
      throw new Error(`${key} is not accepted by the keychain-only release`);
  }
  const identity = requiredEnvironment(env, "LAUNDRY_RUNTIME_CODESIGN_IDENTITY");
  if (!SAFE_IDENTITY.test(identity)) {
    throw new Error("LAUNDRY_RUNTIME_CODESIGN_IDENTITY must be one exact Developer ID identity");
  }
  const teamMatch = identity.match(/ \(([A-Z0-9]{10})\)$/u);
  if (teamMatch?.[1] === undefined) {
    throw new Error("LAUNDRY_RUNTIME_CODESIGN_IDENTITY must end with one TeamIdentifier");
  }
  const profile = requiredEnvironment(env, "LAUNDRY_RUNTIME_NOTARY_PROFILE");
  if (!SAFE_PROFILE.test(profile)) throw new Error("LAUNDRY_RUNTIME_NOTARY_PROFILE is invalid");
  return Object.freeze({
    identity,
    teamIdentifier: teamMatch[1],
    profile,
    keychain: canonicalAbsolutePath(
      requiredEnvironment(env, "LAUNDRY_RUNTIME_APPLE_KEYCHAIN"),
      "LAUNDRY_RUNTIME_APPLE_KEYCHAIN",
    ),
    publicKeyPath: canonicalAbsolutePath(
      requiredEnvironment(env, "LAUNDRY_RUNTIME_MANIFEST_PUBLIC_KEY_FILE"),
      "LAUNDRY_RUNTIME_MANIFEST_PUBLIC_KEY_FILE",
    ),
  });
}

export function createRuntimeReleaseChildEnvironment(env, releaseEnvironment) {
  const selected = Object.fromEntries(
    PASSTHROUGH_ENV.flatMap((key) => (typeof env[key] === "string" ? [[key, env[key]]] : [])),
  );
  return Object.freeze({
    ...selected,
    CSC_NAME: releaseEnvironment.identity,
    CSC_KEYCHAIN: releaseEnvironment.keychain,
  });
}

async function readBoundedRealFile(path, label, maximumBytes) {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < 1n ||
    metadata.size > BigInt(maximumBytes) ||
    (metadata.mode & 0o777n) !== 0o600n
  ) {
    throw new Error(`${label} must be a bounded 0600 single-link real file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const unchanged = (candidate) =>
      candidate.isFile() &&
      candidate.dev === metadata.dev &&
      candidate.ino === metadata.ino &&
      candidate.mode === metadata.mode &&
      candidate.nlink === metadata.nlink &&
      candidate.size === metadata.size &&
      candidate.ctimeNs === metadata.ctimeNs &&
      candidate.mtimeNs === metadata.mtimeNs;
    if (!unchanged(opened)) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!unchanged(afterRead) || !unchanged(afterPath)) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readRuntimeManifestPublicKey(releaseEnvironment) {
  const bytes = await readBoundedRealFile(
    releaseEnvironment.publicKeyPath,
    "Runtime manifest public key",
    16_384,
  );
  const text = bytes.toString("utf8");
  if (!RAW_PUBLIC_KEY.test(text.trim()) || Buffer.from(text.trim(), "base64url").length !== 32) {
    throw new Error("Runtime manifest public key is invalid");
  }
  return text.trim();
}

async function stageValidatedRuntimeManifestPublicKey(publicKey, kitRoot) {
  const directory = join(kitRoot, "build", "release");
  const path = join(directory, "trusted-manifest-public-key.txt");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${publicKey}\n`, { flag: "wx", mode: 0o644 });
  return Object.freeze({ directory, path, publicKey });
}

export async function stageRuntimeManifestPublicKey(releaseEnvironment, kitRoot = defaultKitRoot) {
  return await stageValidatedRuntimeManifestPublicKey(
    await readRuntimeManifestPublicKey(releaseEnvironment),
    kitRoot,
  );
}

function releasePaths(kitRoot) {
  const appPath = join(kitRoot, "dist", "Laundry Desk Runtime.app");
  const executablePath = join(appPath, "Contents", "MacOS", "Laundry Desk Runtime");
  const embeddedKeyPath = join(appPath, "Contents", "Resources", "trusted-manifest-public-key.txt");
  const releaseRoot = join(kitRoot, "dist", "release");
  const stem = `Laundry-Desk-Runtime-${RUNTIME_APP_VERSION}-universal`;
  const zipName = `${stem}.zip`;
  const dmgName = `${stem}.dmg`;
  return Object.freeze({
    appPath,
    dmgName,
    embeddedKeyPath,
    executablePath,
    releaseRoot,
    zipName,
    zipPath: join(releaseRoot, zipName),
    dmgPath: join(releaseRoot, dmgName),
    temporaryNotaryZip: join(kitRoot, "build", "release", ".notary-upload.zip"),
  });
}

export function createRuntimeReleasePlan(releaseEnvironment, kitRoot = defaultKitRoot) {
  const paths = releasePaths(kitRoot);
  const notary = [
    "--keychain",
    releaseEnvironment.keychain,
    "--keychain-profile",
    releaseEnvironment.profile,
    "--wait",
    "--output-format",
    "json",
  ];
  return Object.freeze([
    Object.freeze({ file: process.execPath, args: [join(kitRoot, "build-app.mjs"), "--release"] }),
    Object.freeze({
      file: "/usr/bin/codesign",
      args: [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--sign",
        releaseEnvironment.identity,
        "--keychain",
        releaseEnvironment.keychain,
        paths.appPath,
      ],
    }),
    Object.freeze({
      file: process.execPath,
      args: [join(kitRoot, "inspect-app.mjs"), paths.appPath],
    }),
    Object.freeze({
      file: "/usr/bin/ditto",
      args: ["-c", "-k", "--keepParent", paths.appPath, paths.temporaryNotaryZip],
    }),
    Object.freeze({
      file: "/usr/bin/xcrun",
      args: ["notarytool", "submit", paths.temporaryNotaryZip, ...notary],
    }),
    Object.freeze({ file: "/usr/bin/xcrun", args: ["stapler", "staple", paths.appPath] }),
    Object.freeze({ file: "/usr/bin/xcrun", args: ["stapler", "validate", paths.appPath] }),
    Object.freeze({
      file: "/usr/bin/ditto",
      args: ["-c", "-k", "--keepParent", paths.appPath, paths.zipPath],
    }),
    Object.freeze({
      file: "/usr/bin/hdiutil",
      args: [
        "create",
        "-volname",
        "Laundry Desk Runtime",
        "-srcfolder",
        paths.appPath,
        "-format",
        "UDZO",
        paths.dmgPath,
      ],
    }),
    Object.freeze({
      file: "/usr/bin/codesign",
      args: [
        "--force",
        "--timestamp",
        "--sign",
        releaseEnvironment.identity,
        "--keychain",
        releaseEnvironment.keychain,
        paths.dmgPath,
      ],
    }),
    Object.freeze({
      file: "/usr/bin/xcrun",
      args: ["notarytool", "submit", paths.dmgPath, ...notary],
    }),
    Object.freeze({ file: "/usr/bin/xcrun", args: ["stapler", "staple", paths.dmgPath] }),
    Object.freeze({ file: "/usr/bin/xcrun", args: ["stapler", "validate", paths.dmgPath] }),
    Object.freeze({
      file: "/usr/sbin/spctl",
      args: ["--assess", "--type", "execute", "--verbose=4", paths.appPath],
    }),
    Object.freeze({
      file: "/usr/sbin/spctl",
      args: ["--assess", "--type", "open", "--context", "context:primary-signature", paths.dmgPath],
    }),
  ]);
}

async function runCommand(run, command, environment, cwd) {
  return await run(command.file, [...command.args], {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function removeRuntimeReleaseWorkspace(root) {
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

export async function runRuntimeRelease(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.execute ?? execute;
  const kitRoot = options.kitRoot ?? defaultKitRoot;
  const releaseEnvironment = parseRuntimeReleaseEnvironment(env, platform);
  const childEnvironment = createRuntimeReleaseChildEnvironment(env, releaseEnvironment);
  const publicKey = await readRuntimeManifestPublicKey(releaseEnvironment);
  await assertRuntimeReleaseDestinationAvailable(kitRoot);
  const identity = await run(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning", releaseEnvironment.keychain],
    { env: childEnvironment, encoding: "utf8", maxBuffer: 512 * 1024 },
  );
  const identities = [...identity.stdout.matchAll(/"([^"\r\n]+)"/gu)].map((match) => match[1]);
  if (!identities.includes(releaseEnvironment.identity)) {
    throw new Error("configured Developer ID identity is unavailable in the selected keychain");
  }
  await run(
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
    { env: childEnvironment, encoding: "utf8", maxBuffer: 512 * 1024 },
  );
  const workspace = await createRuntimeReleaseWorkspace(kitRoot);
  const cleanupWorkspace = options.cleanupWorkspace ?? removeRuntimeReleaseWorkspace;
  let published;
  try {
    const staged = await stageValidatedRuntimeManifestPublicKey(publicKey, workspace.kitRoot);
    const paths = releasePaths(workspace.kitRoot);
    await mkdir(paths.releaseRoot, { recursive: true, mode: 0o700 });
    for (const command of createRuntimeReleasePlan(releaseEnvironment, workspace.kitRoot)) {
      await runCommand(run, command, childEnvironment, workspace.kitRoot);
    }
    const embeddedKey = (await readFile(paths.embeddedKeyPath, "utf8")).trim();
    if (embeddedKey !== staged.publicKey) {
      throw new Error("packaged Runtime manifest public key does not match release input");
    }
    const preparedPaths = await prepareRuntimeReleaseArtifacts(paths);
    const verifyArtifacts = options.verifyArtifacts ?? verifyRuntimeReleaseArtifacts;
    const verifiedSeal = await verifyArtifacts(
      { ...preparedPaths, workspaceRoot: workspace.root },
      { execute: run, expectedTeamIdentifier: releaseEnvironment.teamIdentifier },
    );
    published = await publishRuntimeRelease(preparedPaths, kitRoot, verifiedSeal, {
      beforeRename: options.beforePublishRename,
    });
  } catch (error) {
    try {
      await cleanupWorkspace(workspace.root);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Runtime release failed and its workspace could not be removed",
      );
    }
    throw error;
  }
  let cleanup = "complete";
  try {
    await cleanupWorkspace(workspace.root);
  } catch {
    cleanup = "pending";
  }
  return Object.freeze({
    ok: true,
    committed: true,
    cleanup,
    appPath: published.appPath,
    zipPath: published.zipPath,
    dmgPath: published.dmgPath,
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("RUNTIME_RELEASE_ARGS_INVALID");
  const result = await runRuntimeRelease();
  if (result.cleanup === "pending") {
    process.stderr.write("[runtime-release] release committed; workspace cleanup is pending\n");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Runtime release failed";
    process.stderr.write(`[runtime-release] ${message}\n`);
    process.exitCode = 1;
  });
}
