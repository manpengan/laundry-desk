import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type DeviceIdentityOptions = Readonly<{
  userDataPath: string;
  randomUUID: () => string;
}>;

const IDENTITY_DIRECTORY_NAME = "device-identity";
const IDENTITY_FILE_NAME = "device-id";
const STAGING_DIRECTORY_PREFIX = ".device-id-";
const STAGING_FILE_NAME = "candidate";
const DIRECTORY_MODE = 0o700;
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
  let created = false;
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  if (created) await chmod(path, DIRECTORY_MODE);

  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error("Device identity directory is not secure");
  }
  return path;
}

function assertSecureIdentityFile(stat: Stats, expectedLinks = 1): void {
  if (!stat.isFile() || stat.nlink !== expectedLinks || (stat.mode & 0o777) !== FILE_MODE) {
    throw new Error("Device identity file is not secure");
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

async function readIdentityFile(path: string, expectedLinks = 1): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    const buffer = Buffer.alloc(UUID_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    const afterRead = await file.stat();
    assertSecureIdentityFile(afterRead, expectedLinks);
    return parseStoredIdentity(buffer, bytesRead, afterRead.size);
  } finally {
    await file.close();
  }
}

async function writeStagedIdentity(path: string, deviceId: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const file = await open(path, flags, FILE_MODE);
  try {
    await file.chmod(FILE_MODE);
    await file.writeFile(deviceId, "utf8");
    await file.sync();
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
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const directory = await open(path, flags);
  try {
    const stat = await directory.stat();
    if (!stat.isDirectory() || (stat.mode & 0o777) !== DIRECTORY_MODE) {
      throw new Error("Device identity directory is not secure");
    }
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function installIdentityFile(
  directory: string,
  finalPath: string,
  deviceId: string,
): Promise<boolean> {
  const stagingDirectory = await mkdtemp(join(directory, STAGING_DIRECTORY_PREFIX));
  const stagingPath = join(stagingDirectory, STAGING_FILE_NAME);
  await chmod(stagingDirectory, DIRECTORY_MODE);
  let installed = false;
  try {
    await writeStagedIdentity(stagingPath, deviceId);
    try {
      await link(stagingPath, finalPath);
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
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    (directoryStat.mode & 0o777) !== DIRECTORY_MODE
  ) {
    return null;
  }
  const entries = await readdir(stagingDirectory);
  if (entries.length !== 1 || entries[0] !== STAGING_FILE_NAME) return null;

  const candidatePath = join(stagingDirectory, STAGING_FILE_NAME);
  const candidateStat = await lstat(candidatePath);
  if (
    !candidateStat.isFile() ||
    candidateStat.nlink !== 2 ||
    (candidateStat.mode & 0o777) !== FILE_MODE ||
    candidateStat.dev !== identityStat.dev ||
    candidateStat.ino !== identityStat.ino
  ) {
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
  if (stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === FILE_MODE) {
    return readIdentityFile(identityPath);
  }
  if (stat.isFile() && stat.nlink === 2 && (stat.mode & 0o777) === FILE_MODE) {
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
