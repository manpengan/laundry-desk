import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MACH_O_MAGICS = new Set([
  "bebafeca",
  "bfbafeca",
  "cafebabe",
  "cafebabf",
  "cefaedfe",
  "cffaedfe",
  "feedface",
  "feedfacf",
]);
const SAFE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/u;
const SAFE_BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u;
const SAFE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const TEAM_ID = /^[A-Z0-9]{10}$/u;
const CD_HASH = /^[0-9a-f]{40,64}$/u;

function parseArchitectures(output) {
  const architectures = output.trim().split(/\s+/u).filter(Boolean).sort();
  if (JSON.stringify(architectures) !== JSON.stringify(["arm64", "x86_64"])) {
    throw new Error("every packaged Mach-O must be universal arm64/x86_64");
  }
}

async function isMachO(path, metadata) {
  if (metadata.size < 4) return false;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error("packaged file changed while opening");
    }
    const magic = Buffer.allocUnsafe(4);
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGICS.has(magic.toString("hex"));
  } finally {
    await handle.close();
  }
}

async function collectMachOFiles(root, directory, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target)) throw new Error("application bundle contains an absolute symlink");
      const lexicalTarget = resolve(dirname(path), target);
      const lexicalRelative = relative(root, lexicalTarget);
      if (
        lexicalRelative === ".." ||
        lexicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(lexicalRelative)
      ) {
        throw new Error("application bundle symlink escapes its root");
      }
      let resolvedTarget;
      try {
        resolvedTarget = await realpath(path);
      } catch {
        throw new Error("application bundle contains a broken symlink");
      }
      const resolvedRelative = relative(await realpath(root), resolvedTarget);
      if (
        resolvedRelative === ".." ||
        resolvedRelative.startsWith(`..${sep}`) ||
        isAbsolute(resolvedRelative)
      ) {
        throw new Error("application bundle symlink escapes its root");
      }
      continue;
    }
    if (metadata.isDirectory()) {
      await collectMachOFiles(root, path, output);
    } else if (metadata.isFile()) {
      if (await isMachO(path, metadata)) output.push(relative(root, path));
    } else {
      throw new Error("application bundle contains an unsupported filesystem entry");
    }
  }
}

export async function discoverMachOFiles(appPath) {
  const metadata = await lstat(appPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("release app must be a real directory");
  }
  const files = [];
  await collectMachOFiles(appPath, appPath, files);
  files.sort();
  if (files.length === 0) throw new Error("release app contains no Mach-O files");
  return Object.freeze(files);
}

export function parseCodeSigningIdentity(output) {
  const value = (label) => output.match(new RegExp(`^${label}=(.+)$`, "mu"))?.[1]?.trim();
  const identifier = value("Identifier");
  const teamIdentifier = value("TeamIdentifier");
  const cdHash = value("CDHash")?.toLowerCase();
  const designatedRequirement = output.match(/^# designated => (.+)$/mu)?.[1]?.trim();
  if (
    identifier === undefined ||
    !SAFE_BUNDLE_ID.test(identifier) ||
    teamIdentifier === undefined ||
    !TEAM_ID.test(teamIdentifier) ||
    cdHash === undefined ||
    !CD_HASH.test(cdHash) ||
    designatedRequirement === undefined ||
    designatedRequirement.length === 0
  ) {
    throw new Error("release app code-signing identity is incomplete");
  }
  return Object.freeze({ identifier, teamIdentifier, cdHash, designatedRequirement });
}

export function assertEquivalentApplication(expected, actual, label) {
  for (const key of [
    "bundleIdentifier",
    "version",
    "teamIdentifier",
    "cdHash",
    "designatedRequirement",
  ]) {
    if (expected[key] !== actual[key]) throw new Error(`${label} app identity does not match`);
  }
  if (JSON.stringify(expected.machOFiles) !== JSON.stringify(actual.machOFiles)) {
    throw new Error(`${label} Mach-O inventory does not match`);
  }
}

export function assertExpectedApplication(actual, expected) {
  for (const key of ["bundleIdentifier", "version", "teamIdentifier"]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`release app ${key} does not match the configured release`);
    }
  }
}

export async function inspectSignedUniversalApplication(appPath, run) {
  const plist = join(appPath, "Contents", "Info.plist");
  const [executable, version, bundleIdentifier] = await Promise.all([
    run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]),
    run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist]),
    run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist]),
  ]);
  const executableName = executable.stdout.trim();
  const normalizedVersion = version.stdout.trim();
  const normalizedBundleIdentifier = bundleIdentifier.stdout.trim();
  if (
    !SAFE_EXECUTABLE.test(executableName) ||
    !SAFE_VERSION.test(normalizedVersion) ||
    !SAFE_BUNDLE_ID.test(normalizedBundleIdentifier)
  ) {
    throw new Error("release app metadata is invalid");
  }
  const machOFiles = await discoverMachOFiles(appPath);
  for (const file of machOFiles) {
    const architectures = await run("/usr/bin/lipo", ["-archs", join(appPath, file)]);
    parseArchitectures(architectures.stdout);
  }
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const signing = await run("/usr/bin/codesign", [
    "--display",
    "--verbose=4",
    "--requirements",
    "-",
    appPath,
  ]);
  const identity = parseCodeSigningIdentity(`${signing.stdout}\n${signing.stderr}`);
  if (identity.identifier !== normalizedBundleIdentifier) {
    throw new Error("code-signing identifier does not match CFBundleIdentifier");
  }
  return Object.freeze({
    appName: basename(appPath),
    executableName,
    version: normalizedVersion,
    bundleIdentifier: normalizedBundleIdentifier,
    machOFiles,
    ...identity,
  });
}

async function extractedZipApplication(zipPath, run) {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-release-zip-"));
  try {
    await run("/usr/bin/ditto", ["-x", "-k", zipPath, temporary]);
    const entries = await readdir(temporary, { withFileTypes: true });
    const apps = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (entries.length !== 1 || apps.length !== 1) {
      throw new Error("release ZIP must contain exactly one app");
    }
    return await inspectSignedUniversalApplication(join(temporary, apps[0].name), run);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function mountedDmgApplication(dmgPath, run) {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-release-dmg-"));
  const mountPoint = join(temporary, "volume");
  await mkdir(mountPoint, { mode: 0o700 });
  let attached = false;
  try {
    await run("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPoint,
      dmgPath,
    ]);
    attached = true;
    const entries = await readdir(mountPoint, { withFileTypes: true });
    const apps = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("release DMG must contain exactly one app");
    return await inspectSignedUniversalApplication(join(mountPoint, apps[0].name), run);
  } finally {
    if (attached) await run("/usr/bin/hdiutil", ["detach", mountPoint]);
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function validateReleaseApplicationEquivalence(artifacts, run, expectedIdentity) {
  const unpacked = await inspectSignedUniversalApplication(artifacts.appPath, run);
  assertExpectedApplication(unpacked, expectedIdentity);
  const archived = await extractedZipApplication(artifacts.zipPath, run);
  assertEquivalentApplication(unpacked, archived, "ZIP");
  const diskImage = await mountedDmgApplication(artifacts.dmgPath, run);
  assertEquivalentApplication(unpacked, diskImage, "DMG");
  return unpacked;
}
