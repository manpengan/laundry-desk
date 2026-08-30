import { constants, type Stats } from "node:fs";
import { link, lstat, mkdtemp, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  flushDirectoryDurably,
  inspectPrivateDirectory,
  inspectPrivateFileLinks,
  securePrivateDirectory,
  securePrivateFile,
  type PrivateFileSecurity,
} from "@laundry/platform-fs";

export type DeviceIdentityOptions = Readonly<{
  userDataPath: string;
  randomUUID: () => string;
}>;

const IDENTITY_DIRECTORY_NAME = "device-identity";
const IDENTITY_FILE_NAME = "device-id";
const STAGING_DIRECTORY_PREFIX = ".device-id-";
const ROOT_STAGING_DIRECTORY_PREFIX = ".device-identity-root-";
const STAGING_FILE_NAME = "candidate";
const FILE_MODE = 0o600;
const UUID_BYTES = 36;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MANAGED_STAGING_PATTERN = /^\.device-id-[A-Za-z0-9]{6}$/u;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

async function ensureIdentityDirectory(userDataPath: string): Promise<string> {
  if (!isAbsolute(userDataPath)) {
    throw new Error("Device identity userData path must be absolute");
  }
  const path = join(userDataPath, IDENTITY_DIRECTORY_NAME);
  let existing = true;
  try {
    await lstat(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    existing = false;
  }
  if (!existing) {
    const staging = await mkdtemp(join(userDataPath, ROOT_STAGING_DIRECTORY_PREFIX));
    let installed = false;
    try {
      await securePrivateDirectory(staging);
      try {
        await rename(staging, path);
        installed = true;
        await flushDirectoryDurably(userDataPath);
      } catch (error) {
        let finalExists = true;
        try {
          await lstat(path);
        } catch (finalError) {
          if (hasErrorCode(finalError, "ENOENT")) finalExists = false;
          else throw finalError;
        }
        if (!finalExists) throw error;
      }
    } finally {
      if (!installed) await removeStagingDirectory(staging);
    }
  }

  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Device identity directory is not secure");
  }
  try {
    await inspectPrivateDirectory(path);
  } catch (error) {
    throw new Error("Device identity directory is not secure", { cause: error });
  }
  return path;
}

function assertSecureIdentityFile(stat: Stats, expectedLinks: 1 | 2 = 1): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== expectedLinks) {
    throw new Error("Device identity file is not secure");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameSecurity(left: PrivateFileSecurity, right: PrivateFileSecurity): boolean {
  return left.scheme === right.scheme && left.descriptorSha256 === right.descriptorSha256;
}

async function inspectIdentityFile(
  path: string,
  expectedLinks: 1 | 2,
): Promise<PrivateFileSecurity> {
  try {
    return await inspectPrivateFileLinks(path, expectedLinks);
  } catch (error) {
    throw new Error("Device identity file is not secure", { cause: error });
  }
}

function parseStoredIdentity(buffer: Buffer, bytesRead: number, size: number): string {
  if (size !== UUID_BYTES || bytesRead !== UUID_BYTES) {
    throw new Error("Stored device identity is invalid");
  }
  const deviceId = buffer.subarray(0, bytesRead).toString("utf8");
  if (!UUID_PATTERN.test(deviceId)) {
    throw new Error("Stored device identity is invalid");
  }
  return deviceId;
}

async function readIdentityFile(path: string, expectedLinks: 1 | 2 = 1): Promise<string | null> {
  let pathBefore: Stats;
  try {
    pathBefore = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  assertSecureIdentityFile(pathBefore, expectedLinks);
  const securityBefore = await inspectIdentityFile(path, expectedLinks);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    if (hasErrorCode(error, "ELOOP")) {
      throw new Error("Device identity file is not secure");
    }
    throw error;
  }

  try {
    const beforeRead = await file.stat();
    assertSecureIdentityFile(beforeRead, expectedLinks);
    if (!sameFile(pathBefore, beforeRead)) {
      throw new Error("Device identity file is not secure");
    }
    const buffer = Buffer.alloc(UUID_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    const afterRead = await file.stat();
    const pathAfter = await lstat(path);
    assertSecureIdentityFile(afterRead, expectedLinks);
    assertSecureIdentityFile(pathAfter, expectedLinks);
    const securityAfter = await inspectIdentityFile(path, expectedLinks);
    if (
      !sameFile(beforeRead, afterRead) ||
      !sameFile(afterRead, pathAfter) ||
      !sameSecurity(securityBefore, securityAfter)
    ) {
      throw new Error("Device identity file is not secure");
    }
    return parseStoredIdentity(buffer, bytesRead, afterRead.size);
  } finally {
    await file.close();
  }
}

async function writeStagedIdentity(path: string, deviceId: string): Promise<void> {
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const file = await open(path, flags, FILE_MODE);
  try {
    await securePrivateFile(path);
    await file.writeFile(deviceId, "utf8");
    await file.sync();
    assertSecureIdentityFile(await file.stat());
    await inspectIdentityFile(path, 1);
  } finally {
    await file.close();
  }
}

async function removeStagingFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

async function removeStagingDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

async function syncIdentityDirectory(path: string): Promise<void> {
  try {
    await inspectPrivateDirectory(path);
    await flushDirectoryDurably(path);
    await inspectPrivateDirectory(path);
  } catch (error) {
    throw new Error("Device identity directory is not secure", { cause: error });
  }
}

async function installIdentityFile(
  directory: string,
  finalPath: string,
  deviceId: string,
): Promise<boolean> {
  const stagingDirectory = await mkdtemp(join(directory, STAGING_DIRECTORY_PREFIX));
  const stagingPath = join(stagingDirectory, STAGING_FILE_NAME);
  await securePrivateDirectory(stagingDirectory);
  let installed = false;
  try {
    await writeStagedIdentity(stagingPath, deviceId);
    try {
      await link(stagingPath, finalPath);
      await inspectIdentityFile(stagingPath, 2);
      await inspectIdentityFile(finalPath, 2);
      installed = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
  } finally {
    await removeStagingFile(stagingPath);
    await removeStagingDirectory(stagingDirectory);
  }
  await syncIdentityDirectory(directory);
  return installed;
}

async function inspectManagedCandidate(
  directory: string,
  name: string,
  identityStat: Stats,
): Promise<string | null> {
  const stagingDirectory = join(directory, name);
  const directoryStat = await lstat(stagingDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    return null;
  }
  try {
    await inspectPrivateDirectory(stagingDirectory);
  } catch {
    return null;
  }
  const entries = await readdir(stagingDirectory);
  if (entries.length !== 1 || entries[0] !== STAGING_FILE_NAME) return null;

  const candidatePath = join(stagingDirectory, STAGING_FILE_NAME);
  const candidateStat = await lstat(candidatePath);
  if (
    !candidateStat.isFile() ||
    candidateStat.nlink !== 2 ||
    candidateStat.dev !== identityStat.dev ||
    candidateStat.ino !== identityStat.ino
  ) {
    return null;
  }
  try {
    await inspectPrivateFileLinks(candidatePath, 2);
  } catch {
    return null;
  }
  return candidatePath;
}

async function findManagedCandidate(directory: string, identityStat: Stats): Promise<string> {
  const names = (await readdir(directory))
    .filter((name) => MANAGED_STAGING_PATTERN.test(name))
    .sort();
  const candidates = (
    await Promise.all(names.map((name) => inspectManagedCandidate(directory, name, identityStat)))
  ).filter((candidate): candidate is string => candidate !== null);
  if (candidates.length !== 1) {
    throw new Error("Device identity file is not secure");
  }
  const [candidate] = candidates;
  if (candidate === undefined) {
    throw new Error("Device identity file is not secure");
  }
  return candidate;
}

async function recoverInterruptedInstall(
  directory: string,
  identityPath: string,
  identityStat: Stats,
): Promise<string> {
  assertSecureIdentityFile(identityStat, 2);
  await inspectIdentityFile(identityPath, 2);
  const candidatePath = await findManagedCandidate(directory, identityStat);
  const deviceId = await readIdentityFile(identityPath, 2);
  if (deviceId === null) throw new Error("Device identity file is not secure");

  await unlink(candidatePath);
  await removeStagingDirectory(join(candidatePath, ".."));
  await syncIdentityDirectory(directory);
  const recoveredId = await readIdentityFile(identityPath);
  if (recoveredId === null) throw new Error("Device identity file is not secure");
  return recoveredId;
}

async function loadExistingIdentity(
  directory: string,
  identityPath: string,
): Promise<string | null> {
  let stat: Stats;
  try {
    stat = await lstat(identityPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (stat.isFile() && stat.nlink === 1) {
    return readIdentityFile(identityPath);
  }
  if (stat.isFile() && stat.nlink === 2) {
    return recoverInterruptedInstall(directory, identityPath, stat);
  }
  throw new Error("Device identity file is not secure");
}

function validateGeneratedIdentity(deviceId: string): string {
  if (!UUID_PATTERN.test(deviceId)) {
    throw new Error("Generated device identity is invalid");
  }
  return deviceId;
}

export async function loadOrCreateDeviceId(options: DeviceIdentityOptions): Promise<string> {
  const identityDirectory = await ensureIdentityDirectory(options.userDataPath);
  const identityFile = join(identityDirectory, IDENTITY_FILE_NAME);
  const existingId = await loadExistingIdentity(identityDirectory, identityFile);
  if (existingId !== null) return existingId;

  const generatedId = validateGeneratedIdentity(options.randomUUID());
  if (await installIdentityFile(identityDirectory, identityFile, generatedId)) {
    return generatedId;
  }
  const concurrentlyCreatedId = await loadExistingIdentity(identityDirectory, identityFile);
  if (concurrentlyCreatedId === null) {
    throw new Error("Device identity file is not secure");
  }
  return concurrentlyCreatedId;
}
