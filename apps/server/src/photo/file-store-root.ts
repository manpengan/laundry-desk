import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  flushDirectoryDurably,
  inspectPrivateDirectory,
  inspectPrivateFile,
  securePrivateDirectory,
  securePrivateFile,
} from "@laundry/platform-fs";

import { PhotoFileError } from "./file-store-error.js";

export const PHOTO_STORE_MARKER = ".laundry-photo-store-v1";
export const PHOTO_STORE_MARKER_CONTENT = "laundry-desk-photo-store:v1\n";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as Readonly<{ code?: unknown }>).code === "ENOENT"
  );
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function assertRealDirectoryChain(rootPath: string): Promise<void> {
  const pathRoot = parse(rootPath).root;
  const parts = relative(pathRoot, rootPath).split(sep).filter(Boolean);
  let current = pathRoot;
  for (const part of parts) {
    current = join(current, part);
    const metadata = await lstatIfPresent(current);
    if (metadata === null) return;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new PhotoFileError("PHOTO_ROOT_INVALID", "photo root chain must use real directories");
    }
  }
}

async function validateMarker(markerPath: string): Promise<void> {
  const metadata = await lstatIfPresent(markerPath);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PhotoFileError("PHOTO_ROOT_UNOWNED", "photo root ownership marker is invalid");
  }
  const handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    () => null,
  );
  if (handle === null) {
    throw new PhotoFileError("PHOTO_ROOT_UNOWNED", "photo root ownership marker is invalid");
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      (await handle.readFile("utf8")) !== PHOTO_STORE_MARKER_CONTENT
    ) {
      throw new PhotoFileError("PHOTO_ROOT_UNOWNED", "photo root ownership marker is invalid");
    }
  } finally {
    await handle.close();
  }
  try {
    await securePrivateFile(markerPath);
    await inspectPrivateFile(markerPath);
  } catch {
    throw new PhotoFileError("PHOTO_ROOT_UNOWNED", "photo root ownership marker is invalid");
  }
}

async function establishStoreOwnership(rootPath: string): Promise<void> {
  const markerPath = join(rootPath, PHOTO_STORE_MARKER);
  if ((await lstatIfPresent(markerPath)) !== null) {
    await validateMarker(markerPath);
    return;
  }
  if ((await readdir(rootPath)).length !== 0) {
    throw new PhotoFileError(
      "PHOTO_ROOT_UNOWNED",
      "photo root must be empty before its ownership marker is created",
    );
  }
  const handle = await open(
    markerPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    await securePrivateFile(markerPath);
    await handle.writeFile(PHOTO_STORE_MARKER_CONTENT, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await flushDirectoryDurably(rootPath);
  await validateMarker(markerPath);
}

export async function securePhotoStoreRoot(rootPath: string): Promise<string> {
  const normalized = resolve(rootPath);
  if (normalized === parse(normalized).root || dirname(normalized) === normalized) {
    throw new PhotoFileError("PHOTO_ROOT_INVALID", "filesystem root cannot be a photo store");
  }
  await assertRealDirectoryChain(normalized);
  await mkdir(normalized, { recursive: true, mode: DIRECTORY_MODE });
  await assertRealDirectoryChain(normalized);
  const metadata = await lstat(normalized);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PhotoFileError("PHOTO_ROOT_INVALID", "photo root must be a real directory");
  }
  const canonical = await realpath(normalized);
  if (canonical !== normalized) {
    throw new PhotoFileError("PHOTO_ROOT_INVALID", "photo root must not traverse aliases");
  }
  await establishStoreOwnership(canonical);
  await securePrivateDirectory(canonical);
  await inspectPrivateDirectory(canonical);
  const handle = await open(
    canonical,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new PhotoFileError("PHOTO_ROOT_INVALID", "photo root changed during initialization");
    }
  } finally {
    await handle.close();
  }
  await flushDirectoryDurably(canonical);
  await assertRealDirectoryChain(canonical);
  return canonical;
}
