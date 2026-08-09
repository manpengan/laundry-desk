import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { RUNTIME_APP_BUILD_VERSION, RUNTIME_APP_VERSION } from "./build-app.mjs";
import { inspectRuntimeApp } from "./inspect-app.mjs";

const APP_NAME = "Laundry Desk Runtime.app";
const EXPECTED_IDENTIFIER = "com.laundry-desk.runtime";
const MAX_ARTIFACT_BYTES = 8n * 1024n * 1024n * 1024n;
function sameFileVersion(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}
function fileVersion(metadata) {
  return Object.freeze({
    ctimeNs: metadata.ctimeNs.toString(),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    nlink: metadata.nlink.toString(),
    size: metadata.size.toString(),
  });
}
async function digestRegularFile(path, label, allowEmpty = false) {
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    (!allowEmpty && before.size < 1n) ||
    before.size > MAX_ARTIFACT_BYTES
  ) {
    throw new Error(`${label} must be a non-empty real file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFileVersion(before, opened)) throw new Error(`${label} changed while opening`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < Number(opened.size)) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error(`${label} changed while reading`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameFileVersion(opened, afterRead) || !sameFileVersion(opened, afterPath)) {
      throw new Error(`${label} changed while reading`);
    }
    return Object.freeze({
      bytes: opened.size.toString(),
      sha256: hash.digest("hex"),
      version: fileVersion(opened),
    });
  } finally {
    await handle.close();
  }
}
async function digestRuntimeApp(appPath) {
  const hash = createHash("sha256");
  const entries = [];
  async function visit(path) {
    const metadata = await lstat(path, { bigint: true });
    const name = relative(appPath, path) || ".";
    if (metadata.isSymbolicLink()) throw new Error("Runtime app symlink is forbidden");
    if (metadata.isDirectory()) {
      hash.update(`directory\0${name}\0${metadata.mode & 0o777n}\0`);
      const children = await readdir(path);
      for (const child of children.sort()) await visit(join(path, child));
      const after = await lstat(path, { bigint: true });
      if (!sameFileVersion(metadata, after)) {
        throw new Error(`Runtime app directory ${name} changed while reading`);
      }
      entries.push(Object.freeze({ name, type: "directory", version: fileVersion(after) }));
      return;
    }
    if (!metadata.isFile()) throw new Error("Runtime app special file is forbidden");
    const digest = await digestRegularFile(path, `Runtime app file ${name}`, true);
    hash.update(`file\0${name}\0${metadata.mode & 0o777n}\0${digest.bytes}\0${digest.sha256}\0`);
    entries.push(Object.freeze({ name, type: "file", version: digest.version }));
  }
  await visit(appPath);
  return Object.freeze({ entries: Object.freeze(entries), sha256: hash.digest("hex") });
}
export async function createRuntimeArtifactSeal(paths) {
  const [app, zip, dmg, container] = await Promise.all([
    digestRuntimeApp(paths.appPath),
    digestRegularFile(paths.zipPath, "Runtime ZIP"),
    digestRegularFile(paths.dmgPath, "Runtime DMG"),
    digestRuntimeReleaseContainer(paths),
  ]);
  return Object.freeze({ appEntries: app.entries, appSha256: app.sha256, container, dmg, zip });
}
async function digestRuntimeReleaseContainer(paths) {
  if (paths.releaseRoot === undefined) return null;
  const before = await lstat(paths.releaseRoot, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Runtime release container must be a real directory");
  }
  const entries = (await readdir(paths.releaseRoot)).sort();
  const after = await lstat(paths.releaseRoot, { bigint: true });
  if (!sameFileVersion(before, after)) {
    throw new Error("Runtime release container changed while reading");
  }
  return Object.freeze({ entries: Object.freeze(entries), version: fileVersion(after) });
}
async function assertMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists`);
}
async function ensureRealDirectory(path, label) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}
export async function assertRuntimeReleaseDestinationAvailable(kitRoot) {
  const distributionRoot = join(kitRoot, "dist");
  await ensureRealDirectory(distributionRoot, "Runtime distribution root");
  await assertMissing(join(distributionRoot, "release"), "Runtime release destination");
}
export async function createRuntimeReleaseWorkspace(sourceKitRoot) {
  const buildRoot = join(sourceKitRoot, "build");
  await ensureRealDirectory(buildRoot, "Runtime build root");
  const root = await mkdtemp(join(buildRoot, ".release-work-"));
  const repositoryRoot = join(root, "repository");
  const kitRoot = join(repositoryRoot, "tools", "runtime-kit");
  try {
    await chmod(root, 0o700);
    await mkdir(kitRoot, { recursive: true, mode: 0o700 });
    for (const file of ["build-app.mjs", "inspect-app.mjs"]) {
      await cp(join(sourceKitRoot, file), join(kitRoot, file), {
        errorOnExist: true,
        force: false,
      });
    }
    await cp(join(sourceKitRoot, "Sources"), join(kitRoot, "Sources"), {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    const composeRoot = join(repositoryRoot, "tools", "compose");
    await mkdir(composeRoot, { recursive: true, mode: 0o700 });
    for (const file of ["docker-compose.runtime.yml", "docker-compose.runtime-lan.yml"]) {
      await cp(resolve(sourceKitRoot, `../compose/${file}`), join(composeRoot, file), {
        errorOnExist: true,
        force: false,
      });
    }
    return Object.freeze({ kitRoot, root });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
async function removeWriteBits(path) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink()) throw new Error("Runtime release symlink is forbidden");
  if (!before.isDirectory() && !before.isFile()) {
    throw new Error("Runtime release special file is forbidden");
  }
  if (before.isFile() && before.nlink !== 1n) {
    throw new Error("Runtime release hard link is forbidden");
  }
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (before.isDirectory() ? (constants.O_DIRECTORY ?? 0) : 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFileVersion(before, opened)) {
      throw new Error("Runtime release entry changed while sealing");
    }
    if (opened.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await removeWriteBits(join(path, child));
    }
    const current = await lstat(path, { bigint: true });
    if (!sameFileVersion(opened, current)) {
      throw new Error("Runtime release entry changed while sealing");
    }
    const sealedMode = current.mode & 0o555n;
    await handle.chmod(Number(sealedMode));
    const sealedHandle = await handle.stat({ bigint: true });
    const sealedPath = await lstat(path, { bigint: true });
    if (
      !sameFileVersion(sealedHandle, sealedPath) ||
      sealedHandle.dev !== current.dev ||
      sealedHandle.ino !== current.ino ||
      sealedHandle.nlink !== current.nlink ||
      sealedHandle.size !== current.size ||
      sealedHandle.mtimeNs !== current.mtimeNs ||
      (sealedHandle.mode & 0o777n) !== sealedMode
    ) {
      throw new Error("Runtime release entry changed while sealing");
    }
  } finally {
    await handle.close();
  }
}

async function assertRuntimeReleaseContents(paths) {
  assert.deepEqual((await readdir(paths.releaseRoot)).sort(), [
    APP_NAME,
    paths.dmgName,
    paths.zipName,
  ]);
}

export async function prepareRuntimeReleaseArtifacts(paths) {
  // Darwin requires the source container itself to remain writable for the atomic rename.
  await chmod(paths.releaseRoot, 0o700);
  const publishedApp = join(paths.releaseRoot, APP_NAME);
  await assertMissing(publishedApp, "Staged Runtime app destination");
  await rename(paths.appPath, publishedApp);
  const stagedPaths = Object.freeze({ ...paths, appPath: publishedApp });
  await assertRuntimeReleaseContents(stagedPaths);
  for (const child of (await readdir(stagedPaths.releaseRoot)).sort()) {
    await removeWriteBits(join(stagedPaths.releaseRoot, child));
  }
  return stagedPaths;
}

function singleField(text, name, pattern) {
  const matches = [...text.matchAll(new RegExp(`^${name}=(${pattern})$`, "gmu"))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`Runtime code identity is missing one ${name}`);
  }
  return matches[0][1];
}

async function readCodeIdentity(appPath, run) {
  const display = await run("/usr/bin/codesign", ["--display", "--verbose=4", appPath], {
    encoding: "utf8",
    maxBuffer: 512 * 1024,
  });
  const displayText = `${display.stdout ?? ""}\n${display.stderr ?? ""}`;
  const requirements = await run(
    "/usr/bin/codesign",
    ["--display", "--requirements", "-", appPath],
    { encoding: "utf8", maxBuffer: 512 * 1024 },
  );
  const requirementLines = `${requirements.stdout ?? ""}\n${requirements.stderr ?? ""}`
    .split("\n")
    .map((line) => line.trim().replace(/^#\s*/u, ""))
    .filter((line) => line.startsWith("designated =>"));
  if (requirementLines.length !== 1) {
    throw new Error("Runtime code identity is missing one designated requirement");
  }
  const infoPlist = join(appPath, "Contents", "Info.plist");
  const plistValue = async (key) => {
    const result = await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, infoPlist], {
      encoding: "utf8",
      maxBuffer: 512 * 1024,
    });
    return result.stdout.trim();
  };
  const identity = Object.freeze({
    buildVersion: await plistValue("CFBundleVersion"),
    cdHash: singleField(displayText, "CDHash", "[A-Fa-f0-9]{40,64}"),
    identifier: singleField(displayText, "Identifier", "[^\\r\\n]+"),
    requirement: requirementLines[0],
    teamIdentifier: singleField(displayText, "TeamIdentifier", "[A-Z0-9]{10}"),
    version: await plistValue("CFBundleShortVersionString"),
  });
  assert.equal(identity.identifier, EXPECTED_IDENTIFIER);
  return identity;
}

async function onlyRuntimeApp(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== APP_NAME || !entries[0].isDirectory()) {
    throw new Error("Runtime release container must contain exactly one Runtime app");
  }
  return join(directory, APP_NAME);
}

async function inspectAndIdentify(appPath, run, inspectApp) {
  await inspectApp(appPath, { execute: run });
  return await readCodeIdentity(appPath, run);
}

export async function verifyRuntimeReleaseArtifacts(paths, dependencies = {}) {
  const run = dependencies.execute;
  if (typeof run !== "function") throw new Error("Runtime artifact executor is required");
  const inspectApp = dependencies.inspectApp ?? inspectRuntimeApp;
  const expectedTeamIdentifier = dependencies.expectedTeamIdentifier;
  if (!/^[A-Z0-9]{10}$/u.test(expectedTeamIdentifier ?? "")) {
    throw new Error("Runtime expected TeamIdentifier is required");
  }
  const beforeSeal = await createRuntimeArtifactSeal(paths);
  const reference = await inspectAndIdentify(paths.appPath, run, inspectApp);
  assert.deepEqual(
    {
      buildVersion: reference.buildVersion,
      identifier: reference.identifier,
      teamIdentifier: reference.teamIdentifier,
      version: reference.version,
    },
    {
      buildVersion: RUNTIME_APP_BUILD_VERSION,
      identifier: EXPECTED_IDENTIFIER,
      teamIdentifier: expectedTeamIdentifier,
      version: RUNTIME_APP_VERSION,
    },
    "Runtime package identity differs from the release contract",
  );
  const validationRoot = join(paths.workspaceRoot, "artifact-validation");
  const zipRoot = join(validationRoot, "zip");
  const mountRoot = join(validationRoot, "dmg");
  await mkdir(zipRoot, { recursive: true, mode: 0o700 });
  await run("/usr/bin/ditto", ["-x", "-k", paths.zipPath, zipRoot], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const zipIdentity = await inspectAndIdentify(await onlyRuntimeApp(zipRoot), run, inspectApp);
  assert.deepEqual(zipIdentity, reference, "Runtime ZIP app code identity differs");

  await mkdir(mountRoot, { recursive: true, mode: 0o700 });
  let attached = false;
  try {
    await run(
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountRoot, paths.dmgPath],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    attached = true;
    const dmgIdentity = await inspectAndIdentify(await onlyRuntimeApp(mountRoot), run, inspectApp);
    assert.deepEqual(dmgIdentity, reference, "Runtime DMG app code identity differs");
  } finally {
    if (attached) {
      await run("/usr/bin/hdiutil", ["detach", mountRoot], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
    }
  }
  const afterSeal = await createRuntimeArtifactSeal(paths);
  assert.deepEqual(afterSeal, beforeSeal, "Runtime artifacts changed during verification");
  return Object.freeze({ ...afterSeal, identity: reference });
}

export async function publishRuntimeRelease(
  stagedPaths,
  sourceKitRoot,
  verifiedSeal,
  dependencies = {},
) {
  const finalRoot = join(sourceKitRoot, "dist", "release");
  await assertMissing(finalRoot, "Runtime release destination");
  const currentSeal = await createRuntimeArtifactSeal(stagedPaths);
  assert.deepEqual(
    currentSeal,
    {
      appEntries: verifiedSeal.appEntries,
      appSha256: verifiedSeal.appSha256,
      container: verifiedSeal.container,
      dmg: verifiedSeal.dmg,
      zip: verifiedSeal.zip,
    },
    "Runtime artifacts changed after verification",
  );
  await assertRuntimeReleaseContents(stagedPaths);
  if (dependencies.beforeRename !== undefined) {
    await dependencies.beforeRename(stagedPaths);
  }
  await assertRuntimeReleaseContents(stagedPaths);
  assert.deepEqual(
    await createRuntimeArtifactSeal(stagedPaths),
    currentSeal,
    "Runtime artifacts changed before publication",
  );
  await rename(stagedPaths.releaseRoot, finalRoot);
  return Object.freeze({
    appPath: join(finalRoot, APP_NAME),
    dmgPath: join(finalRoot, stagedPaths.dmgName),
    releaseRoot: finalRoot,
    zipPath: join(finalRoot, stagedPaths.zipName),
  });
}
