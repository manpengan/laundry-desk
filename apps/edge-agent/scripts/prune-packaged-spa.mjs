import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

const DARWIN_PLATFORM = "darwin";
const MANIFEST_FILE = "manifest.json";
const BUNDLES_DIRECTORY = "bundles";
const SHA256_DIRECTORY = /^[0-9a-f]{64}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWithinRoot(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function assertRealDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function resolvePackagedSpaPath(context) {
  if (!isRecord(context) || context.electronPlatformName !== DARWIN_PLATFORM) {
    throw new Error("SPA snapshot pruning requires a darwin package");
  }
  if (typeof context.appOutDir !== "string" || !isAbsolute(context.appOutDir)) {
    throw new Error("afterPack appOutDir must be an absolute path");
  }

  const productFilename = context.packager?.appInfo?.productFilename;
  if (
    typeof productFilename !== "string" ||
    productFilename.length === 0 ||
    basename(productFilename) !== productFilename ||
    productFilename === "." ||
    productFilename === ".."
  ) {
    throw new Error("afterPack product filename is invalid");
  }

  await assertRealDirectory(context.appOutDir, "afterPack output directory");
  const realOutputPath = await realpath(context.appOutDir);
  const appPath = join(context.appOutDir, `${productFilename}.app`);
  await assertRealDirectory(appPath, "packaged macOS application");
  const realAppPath = await realpath(appPath);
  if (!isWithinRoot(realOutputPath, realAppPath)) {
    throw new Error("packaged macOS application escapes the output directory");
  }

  const spaPath = join(appPath, "Contents", "Resources", "spa");
  await assertRealDirectory(spaPath, "packaged SPA snapshot");
  const realSpaPath = await realpath(spaPath);
  if (!isWithinRoot(realAppPath, realSpaPath)) {
    throw new Error("packaged SPA snapshot escapes the application");
  }
  return realSpaPath;
}

async function readManifest(spaPath) {
  const manifestPath = join(spaPath, MANIFEST_FILE);
  let metadata;
  try {
    metadata = await lstat(manifestPath);
  } catch {
    throw new Error("packaged SPA manifest is unavailable");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("packaged SPA manifest must be a real file");
  }

  const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedMetadata = await handle.stat();
    if (openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino) {
      throw new Error("packaged SPA manifest changed while opening");
    }
    const bytes = await handle.readFile();
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("packaged SPA manifest is not valid JSON");
    }
    if (!isRecord(parsed)) {
      throw new Error("packaged SPA manifest must contain an object");
    }
    return Object.freeze({
      activeBundle: createHash("sha256").update(bytes).digest("hex"),
      metadata: openedMetadata,
    });
  } finally {
    await handle.close();
  }
}

async function validateBundleDirectories(bundlesPath) {
  await assertRealDirectory(bundlesPath, "packaged SPA bundles directory");
  const entries = await readdir(bundlesPath, { withFileTypes: true });
  const bundleIds = entries.map((entry) => entry.name);

  for (const bundleId of bundleIds) {
    if (!SHA256_DIRECTORY.test(bundleId)) {
      throw new Error(`invalid bundle entry in packaged SPA snapshot: ${bundleId}`);
    }
    await assertRealDirectory(join(bundlesPath, bundleId), `packaged SPA bundle ${bundleId}`);
  }
  return Object.freeze(bundleIds);
}

export async function prunePackagedSpa(context) {
  const spaPath = await resolvePackagedSpaPath(context);
  const { activeBundle } = await readManifest(spaPath);
  const bundlesPath = join(spaPath, BUNDLES_DIRECTORY);
  const bundleIds = await validateBundleDirectories(bundlesPath);
  if (!bundleIds.includes(activeBundle)) {
    throw new Error(`packaged SPA active bundle is missing: ${activeBundle}`);
  }

  const inactiveBundleIds = bundleIds.filter((bundleId) => bundleId !== activeBundle);
  for (const bundleId of inactiveBundleIds) {
    await rm(join(bundlesPath, bundleId), { recursive: true });
  }

  const retainedBundleIds = await validateBundleDirectories(bundlesPath);
  if (retainedBundleIds.length !== 1 || retainedBundleIds[0] !== activeBundle) {
    throw new Error("packaged SPA snapshot was not reduced to its active bundle");
  }
}

export async function afterPack(context) {
  await prunePackagedSpa(context);
}

export default afterPack;
