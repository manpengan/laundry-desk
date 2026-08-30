import { chmodSync, lstatSync } from "node:fs";
import { chmod, lstat } from "node:fs/promises";

import { runWindowsHelper, runWindowsHelperSync } from "./helper-client.js";
import type { PlatformFileOptions } from "./durable.js";

const PRIVATE_MODE = 0o600;
const DESCRIPTOR_SHA256 = /^[0-9a-f]{64}$/u;

export type PrivateFileSecurity = Readonly<{
  scheme: "posix-mode-v1" | "windows-dacl-v1";
  descriptorSha256: string;
}>;

export type PrivateDirectorySecurity = PrivateFileSecurity;

function runtimePlatform(options?: PlatformFileOptions): NodeJS.Platform {
  return options?.platform ?? process.platform;
}

function posixSecurity(mode: number): PrivateFileSecurity {
  return Object.freeze({
    scheme: "posix-mode-v1",
    descriptorSha256: `mode-${(mode & 0o777).toString(8).padStart(3, "0")}`,
  });
}

function windowsSecurity(result: Readonly<Record<string, unknown>>): PrivateFileSecurity {
  const digest = result.descriptor_sha256;
  if (typeof digest !== "string" || !DESCRIPTOR_SHA256.test(digest)) {
    throw new Error("WINDOWS_PRIVATE_FILE_DESCRIPTOR_INVALID");
  }
  return Object.freeze({ scheme: "windows-dacl-v1", descriptorSha256: digest });
}

type PosixFileMetadata = Readonly<{
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  mode: number;
  nlink: number;
}>;

function assertPosixMetadata(metadata: PosixFileMetadata, expectedLinks = 1): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== expectedLinks ||
    (metadata.mode & 0o777) !== PRIVATE_MODE
  ) {
    throw new Error("PRIVATE_FILE_SECURITY_INVALID");
  }
}

export async function securePrivateFile(
  path: string,
  options?: PlatformFileOptions,
): Promise<void> {
  if (runtimePlatform(options) === "win32") {
    await runWindowsHelper(["secure-file", path]);
    return;
  }
  await chmod(path, PRIVATE_MODE);
  assertPosixMetadata(await lstat(path));
}

export function securePrivateFileSync(path: string, options?: PlatformFileOptions): void {
  if (runtimePlatform(options) === "win32") {
    runWindowsHelperSync(["secure-file", path]);
    return;
  }
  chmodSync(path, PRIVATE_MODE);
  assertPosixMetadata(lstatSync(path));
}

export async function inspectPrivateFile(
  path: string,
  options?: PlatformFileOptions,
): Promise<PrivateFileSecurity> {
  return inspectPrivateFileLinks(path, 1, options);
}

export async function inspectPrivateFileLinks(
  path: string,
  expectedLinks: 1 | 2,
  options?: PlatformFileOptions,
): Promise<PrivateFileSecurity> {
  if (runtimePlatform(options) === "win32") {
    return windowsSecurity(
      await runWindowsHelper(["inspect-private-file-links", path, String(expectedLinks)]),
    );
  }
  const metadata = await lstat(path);
  assertPosixMetadata(metadata, expectedLinks);
  return posixSecurity(metadata.mode);
}

export function inspectPrivateFileSync(
  path: string,
  options?: PlatformFileOptions,
): PrivateFileSecurity {
  return inspectPrivateFileLinksSync(path, 1, options);
}

export function inspectPrivateFileLinksSync(
  path: string,
  expectedLinks: 1 | 2,
  options?: PlatformFileOptions,
): PrivateFileSecurity {
  if (runtimePlatform(options) === "win32") {
    return windowsSecurity(
      runWindowsHelperSync(["inspect-private-file-links", path, String(expectedLinks)]),
    );
  }
  const metadata = lstatSync(path);
  assertPosixMetadata(metadata, expectedLinks);
  return posixSecurity(metadata.mode);
}

export async function securePrivateDirectory(
  path: string,
  options?: PlatformFileOptions,
): Promise<void> {
  if (runtimePlatform(options) === "win32") {
    await runWindowsHelper(["secure-directory", path]);
    return;
  }
  await chmod(path, 0o700);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("PRIVATE_DIRECTORY_SECURITY_INVALID");
  }
}

export function securePrivateDirectorySync(path: string, options?: PlatformFileOptions): void {
  if (runtimePlatform(options) === "win32") {
    runWindowsHelperSync(["secure-directory", path]);
    return;
  }
  chmodSync(path, 0o700);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("PRIVATE_DIRECTORY_SECURITY_INVALID");
  }
}

export async function inspectPrivateDirectory(
  path: string,
  options?: PlatformFileOptions,
): Promise<PrivateDirectorySecurity> {
  if (runtimePlatform(options) === "win32") {
    return windowsSecurity(await runWindowsHelper(["inspect-private-directory", path]));
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("PRIVATE_DIRECTORY_SECURITY_INVALID");
  }
  return posixSecurity(metadata.mode);
}

export function inspectPrivateDirectorySync(
  path: string,
  options?: PlatformFileOptions,
): PrivateDirectorySecurity {
  if (runtimePlatform(options) === "win32") {
    return windowsSecurity(runWindowsHelperSync(["inspect-private-directory", path]));
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("PRIVATE_DIRECTORY_SECURITY_INVALID");
  }
  return posixSecurity(metadata.mode);
}
