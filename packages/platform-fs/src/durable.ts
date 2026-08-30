import { closeSync, constants, fsyncSync, openSync, renameSync } from "node:fs";
import { open, rename } from "node:fs/promises";

import { runWindowsHelper, runWindowsHelperSync } from "./helper-client.js";

export type PlatformFileOptions = Readonly<{ platform?: NodeJS.Platform }>;

function runtimePlatform(options?: PlatformFileOptions): NodeJS.Platform {
  return options?.platform ?? process.platform;
}

export async function flushDirectoryDurably(
  path: string,
  options?: PlatformFileOptions,
): Promise<void> {
  if (runtimePlatform(options) === "win32") {
    await runWindowsHelper(["flush-directory", path]);
    return;
  }
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function flushDirectoryDurablySync(path: string, options?: PlatformFileOptions): void {
  if (runtimePlatform(options) === "win32") {
    runWindowsHelperSync(["flush-directory", path]);
    return;
  }
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function replaceFileWriteThrough(
  source: string,
  destination: string,
  options?: PlatformFileOptions,
): Promise<void> {
  if (runtimePlatform(options) === "win32") {
    await runWindowsHelper(["replace-file", source, destination]);
    return;
  }
  await rename(source, destination);
}

export function replaceFileWriteThroughSync(
  source: string,
  destination: string,
  options?: PlatformFileOptions,
): void {
  if (runtimePlatform(options) === "win32") {
    runWindowsHelperSync(["replace-file", source, destination]);
    return;
  }
  renameSync(source, destination);
}
