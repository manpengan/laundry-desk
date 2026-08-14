import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  activeBundleRootFromSpaRoot,
  loadCanonicalManifest,
  verifySpaIntegrity,
} from "../dist/lib/integrity.js";
import { hashAppTree } from "./hash-app.mjs";
import { planSpaRetention } from "./prune-packaged-spa.mjs";

const APP_NAME = "laundry-desk V2.app";
const BUNDLE_IDENTIFIER = "com.laundry-desk.v2";
const EXECUTABLE_NAME = "laundry-desk V2";
const PACKAGE_VERSION = "0.1.0";
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const RELEASE_ROOT = join(PACKAGE_ROOT, "release");
const execFileAsync = promisify(execFile);

function isWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function assertRealDirectory(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function openRegularFile(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const opened = await handle.stat();
  if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || !opened.isFile()) {
    await handle.close();
    throw new Error(`${label} changed while opening`);
  }
  return Object.freeze({ handle, metadata: opened });
}

async function readBoundedRegularFile(path, label, maximumBytes) {
  const { handle, metadata } = await openRegularFile(path, label);
  try {
    if (metadata.size > maximumBytes) throw new Error(`${label} is too large`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertNonemptyRegularFile(path, label) {
  const { handle, metadata } = await openRegularFile(path, label);
  await handle.close();
  if (metadata.size === 0) throw new Error(`${label} must not be empty`);
}

export async function findPackagedMacApplication(releaseRoot) {
  if (typeof releaseRoot !== "string" || !isAbsolute(releaseRoot)) {
    throw new Error("package release root must be absolute");
  }
  await assertRealDirectory(releaseRoot, "package release root");
  const canonicalReleaseRoot = await realpath(releaseRoot);
  if (canonicalReleaseRoot !== releaseRoot) {
    throw new Error("package release root must be canonical");
  }

  const candidates = [];
  for (const entry of await readdir(releaseRoot, { withFileTypes: true })) {
    if (!/^(?:mac|mac-[A-Za-z0-9._-]+)$/u.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error("mac package output must be a real directory");
    const candidate = join(releaseRoot, entry.name, APP_NAME);
    try {
      await assertRealDirectory(candidate, "packaged macOS application");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const canonicalCandidate = await realpath(candidate);
    if (!isWithin(canonicalReleaseRoot, canonicalCandidate)) {
      throw new Error("packaged macOS application escapes its release root");
    }
    candidates.push(canonicalCandidate);
  }
  if (candidates.length !== 1)
    throw new Error("exactly one packaged macOS application is required");
  return candidates[0];
}

async function defaultRun(file, args) {
  return await execFileAsync(file, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    maxBuffer: 8_192,
    timeout: 10_000,
  });
}

async function exactCommandLine(run, file, args, label) {
  const result = await run(file, args);
  if (
    typeof result?.stdout !== "string" ||
    typeof result?.stderr !== "string" ||
    result.stderr !== "" ||
    !/^[^\r\n]+\n?$/u.test(result.stdout)
  ) {
    throw new Error(`${label} output is invalid`);
  }
  return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
}

async function plistValue(run, plistPath, key) {
  return await exactCommandLine(
    run,
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plistPath],
    `Info.plist ${key}`,
  );
}

function parseDisabledUpdateConfig(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("packaged development update configuration is invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["enabled", "schema_version"]) ||
    parsed.schema_version !== 1 ||
    parsed.enabled !== false
  ) {
    throw new Error("packaged development update configuration must be exactly disabled");
  }
}

export async function inspectPackagedMacSoftware(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("macOS package inspection requires Darwin");
  const releaseRoot = options.releaseRoot ?? RELEASE_ROOT;
  const run = options.run ?? defaultRun;
  const appPath = await findPackagedMacApplication(releaseRoot);
  const contentsPath = join(appPath, "Contents");
  const plistPath = join(contentsPath, "Info.plist");
  const macOsPath = join(contentsPath, "MacOS");
  const executablePath = join(macOsPath, EXECUTABLE_NAME);
  const resourcesPath = join(contentsPath, "Resources");

  await assertRealDirectory(contentsPath, "packaged Contents directory");
  await assertRealDirectory(macOsPath, "packaged MacOS directory");
  await assertRealDirectory(resourcesPath, "packaged Resources directory");
  const { handle: plistHandle } = await openRegularFile(plistPath, "packaged Info.plist");
  await plistHandle.close();

  const [bundleIdentifier, executableName, version, architecture] = await Promise.all([
    plistValue(run, plistPath, "CFBundleIdentifier"),
    plistValue(run, plistPath, "CFBundleExecutable"),
    plistValue(run, plistPath, "CFBundleShortVersionString"),
    exactCommandLine(run, "/usr/bin/lipo", ["-archs", executablePath], "packaged architecture"),
  ]);
  if (
    bundleIdentifier !== BUNDLE_IDENTIFIER ||
    executableName !== EXECUTABLE_NAME ||
    version !== PACKAGE_VERSION ||
    (architecture !== "arm64" && architecture !== "x86_64")
  ) {
    throw new Error("packaged application identity is invalid");
  }
  await assertNonemptyRegularFile(executablePath, "packaged executable");
  await assertNonemptyRegularFile(join(resourcesPath, "app.asar"), "packaged app.asar");

  const updatePath = join(resourcesPath, "update");
  await assertRealDirectory(updatePath, "packaged update directory");
  const updateEntries = await readdir(updatePath, { withFileTypes: true });
  if (
    updateEntries.length !== 1 ||
    updateEntries[0]?.name !== "update-config.json" ||
    !updateEntries[0].isFile()
  ) {
    throw new Error("local package update resources must contain only its disabled configuration");
  }
  parseDisabledUpdateConfig(
    await readBoundedRegularFile(
      join(updatePath, "update-config.json"),
      "packaged development update configuration",
      4_096,
    ),
  );

  const unresolvedSpaPath = join(resourcesPath, "spa");
  await assertRealDirectory(unresolvedSpaPath, "packaged SPA directory");
  const spaPath = await realpath(unresolvedSpaPath);
  if (!isWithin(appPath, spaPath)) throw new Error("packaged SPA escapes its application");
  const retention = await planSpaRetention(spaPath);
  if (
    retention.bundle_count !== 1 ||
    retention.inactive_bundles.length !== 0 ||
    retention.packaged_retained_bundles.length !== 1
  ) {
    throw new Error("packaged SPA must contain exactly its active bundle");
  }
  const loaded = loadCanonicalManifest(join(spaPath, "manifest.json"));
  if (loaded.bundleId !== retention.active_bundle) {
    throw new Error("packaged SPA manifest and active bundle disagree");
  }
  verifySpaIntegrity(activeBundleRootFromSpaRoot(spaPath, loaded.bundleId), loaded.manifest);

  return Object.freeze({
    app_sha256: await hashAppTree(appPath),
    architecture,
    assurance: "software_only",
    bundle_identifier: bundleIdentifier,
    spa_bundle: loaded.bundleId,
    spa_entry_count: Object.keys(loaded.manifest.entries).length,
    version,
  });
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  if (process.argv.length !== 2) {
    process.stderr.write("MAC_PACKAGE_SOFTWARE_ARGS_INVALID\n");
    process.exitCode = 1;
  } else {
    inspectPackagedMacSoftware()
      .then((evidence) =>
        process.stdout.write(`MAC_PACKAGE_SOFTWARE_OK ${JSON.stringify(evidence)}\n`),
      )
      .catch(() => {
        process.stderr.write("MAC_PACKAGE_SOFTWARE_FAILED\n");
        process.exitCode = 1;
      });
  }
}
