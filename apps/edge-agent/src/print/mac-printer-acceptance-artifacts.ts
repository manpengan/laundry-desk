import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { PackagedMacAppEvidence } from "./mac-printer-acceptance.js";
import { InfoPlistError, parsePackagedMacAppInfoPlist } from "./mac-printer-acceptance-plist.js";

const MAX_APP_ASAR_BYTES = 1024 * 1024 * 1024;
const MAX_SPA_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_INFO_PLIST_BYTES = 2 * 1024 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

class PackagedAppEvidenceError extends Error {}

export type PackagedAppHashHooks = Readonly<{
  afterLstat?: (path: string) => Promise<void>;
  afterRead?: (path: string) => Promise<void>;
  beforeDirectoryRecheck?: () => Promise<void>;
}>;

type StableFileDigest = Readonly<{
  sha256: string;
  metadata: BigIntStats;
  bytes: Buffer | null;
}>;

function sameFileVersion(expected: BigIntStats, observed: BigIntStats): boolean {
  return (
    observed.isFile() &&
    observed.dev === expected.dev &&
    observed.ino === expected.ino &&
    observed.mode === expected.mode &&
    observed.nlink === expected.nlink &&
    observed.size === expected.size &&
    observed.ctimeNs === expected.ctimeNs &&
    observed.mtimeNs === expected.mtimeNs
  );
}

function sameDirectoryVersion(expected: BigIntStats, observed: BigIntStats): boolean {
  return (
    observed.isDirectory() &&
    observed.dev === expected.dev &&
    observed.ino === expected.ino &&
    observed.mode === expected.mode &&
    observed.nlink === expected.nlink &&
    observed.ctimeNs === expected.ctimeNs &&
    observed.mtimeNs === expected.mtimeNs
  );
}

async function snapshotRealDirectory(path: string, label: string): Promise<BigIntStats> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new PackagedAppEvidenceError(`${label} must be a real directory`);
  }
  return metadata;
}

async function assertDirectoryStillStable(
  path: string,
  label: string,
  metadata: BigIntStats,
): Promise<void> {
  const observed = await lstat(path, { bigint: true });
  if (!sameDirectoryVersion(metadata, observed) || (await realpath(path)) !== path) {
    throw new PackagedAppEvidenceError(`${label} changed before evidence was finalized`);
  }
}

export function assertCanonicalPackagedAppPath(appPath: string): void {
  if (
    !isAbsolute(appPath) ||
    resolve(appPath) !== appPath ||
    appPath.length > 4_096 ||
    CONTROL_CHARACTER.test(appPath) ||
    basename(appPath).length < 5 ||
    basename(appPath).length > 255 ||
    !basename(appPath).endsWith(".app")
  ) {
    throw new PackagedAppEvidenceError(
      "packaged app path must be canonical, absolute, and end in .app",
    );
  }
}

async function hashStableFile(
  path: string,
  label: string,
  maximumBytes: number,
  hooks: PackagedAppHashHooks,
  captureBytes = false,
): Promise<StableFileDigest> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < 1n ||
    metadata.size > BigInt(maximumBytes) ||
    (await realpath(path)) !== path
  ) {
    throw new PackagedAppEvidenceError(`${label} must be a bounded single-link real file`);
  }
  await hooks.afterLstat?.(path);
  if (constants.O_NOFOLLOW === undefined) {
    throw new PackagedAppEvidenceError("packaged app hashing requires no-follow file support");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFileVersion(metadata, opened)) {
      throw new PackagedAppEvidenceError(`${label} changed while opening`);
    }
    const digest = createHash("sha256");
    const chunks: Buffer[] = [];
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Buffer);
      digest.update(bytes);
      if (captureBytes) chunks.push(bytes);
    }
    await hooks.afterRead?.(path);
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      !sameFileVersion(metadata, afterRead) ||
      !sameFileVersion(metadata, afterPath) ||
      (await realpath(path)) !== path
    ) {
      throw new PackagedAppEvidenceError(`${label} changed while reading`);
    }
    return Object.freeze({
      sha256: digest.digest("hex"),
      metadata,
      bytes: captureBytes ? Buffer.concat(chunks) : null,
    });
  } finally {
    await handle.close();
  }
}

async function assertFileStillStable(
  path: string,
  label: string,
  metadata: BigIntStats,
): Promise<void> {
  const observed = await lstat(path, { bigint: true });
  if (!sameFileVersion(metadata, observed) || (await realpath(path)) !== path) {
    throw new PackagedAppEvidenceError(`${label} changed before evidence was finalized`);
  }
}

async function hashPackagedMacAppUnsafe(
  appPath: string,
  hooks: PackagedAppHashHooks,
): Promise<PackagedMacAppEvidence> {
  assertCanonicalPackagedAppPath(appPath);
  const contents = join(appPath, "Contents");
  const resources = join(contents, "Resources");
  const spa = join(resources, "spa");
  const appMetadata = await snapshotRealDirectory(appPath, "packaged app");
  const contentsMetadata = await snapshotRealDirectory(contents, "packaged app Contents");
  const resourcesMetadata = await snapshotRealDirectory(resources, "packaged app Resources");
  const spaMetadata = await snapshotRealDirectory(spa, "packaged app SPA resources");
  const appAsar = join(resources, "app.asar");
  const spaManifest = join(spa, "manifest.json");
  const infoPlist = join(contents, "Info.plist");
  const appAsarDigest = await hashStableFile(
    appAsar,
    "packaged app app.asar",
    MAX_APP_ASAR_BYTES,
    hooks,
  );
  const spaManifestDigest = await hashStableFile(
    spaManifest,
    "packaged app SPA manifest",
    MAX_SPA_MANIFEST_BYTES,
    hooks,
  );
  const infoPlistDigest = await hashStableFile(
    infoPlist,
    "packaged app Info.plist",
    MAX_INFO_PLIST_BYTES,
    hooks,
    true,
  );
  if (infoPlistDigest.bytes === null) {
    throw new PackagedAppEvidenceError("packaged app Info.plist could not be read safely");
  }
  const identity = parsePackagedMacAppInfoPlist(infoPlistDigest.bytes);
  await assertFileStillStable(appAsar, "packaged app app.asar", appAsarDigest.metadata);
  await assertFileStillStable(spaManifest, "packaged app SPA manifest", spaManifestDigest.metadata);
  await assertFileStillStable(infoPlist, "packaged app Info.plist", infoPlistDigest.metadata);
  await hooks.beforeDirectoryRecheck?.();
  await assertDirectoryStillStable(appPath, "packaged app", appMetadata);
  await assertDirectoryStillStable(contents, "packaged app Contents", contentsMetadata);
  await assertDirectoryStillStable(resources, "packaged app Resources", resourcesMetadata);
  await assertDirectoryStillStable(spa, "packaged app SPA resources", spaMetadata);
  return Object.freeze({
    ...identity,
    app_asar_sha256: appAsarDigest.sha256,
    spa_manifest_sha256: spaManifestDigest.sha256,
    info_plist_sha256: infoPlistDigest.sha256,
  });
}

export async function hashPackagedMacApp(
  appPath: string,
  hooks: PackagedAppHashHooks = {},
): Promise<PackagedMacAppEvidence> {
  try {
    return await hashPackagedMacAppUnsafe(appPath, hooks);
  } catch (error) {
    if (error instanceof PackagedAppEvidenceError || error instanceof InfoPlistError) throw error;
    throw new PackagedAppEvidenceError("packaged app evidence could not be read safely");
  }
}
