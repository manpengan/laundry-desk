import { createHash, randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  LOCAL_VOLUME_LABEL_KEYS,
  composeCommand,
  createExecFileCaptureRunner,
  localVolumeLabels,
  resolveComposeProject,
  volumeInspectLabelsCommand,
} from "./compose.mjs";
import { loadLocalConfig, resolveLocalConfigPaths, toLocalConfigEnvironment } from "./config.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const BACKUP_NAME = /^laundry-v2-(?:backup|pre-restore)-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump$/u;

export class LocalDataError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "LocalDataError";
    this.code = code;
  }
}

const fail = (code, cause) => {
  throw new LocalDataError(code, cause === undefined ? undefined : { cause });
};

function contained(rootPath, candidatePath) {
  const path = relative(rootPath, candidatePath);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function assertPrivateDirectory(path) {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o7777) !== DIRECTORY_MODE
  ) {
    fail("LOCAL_BACKUP_DIRECTORY_INVALID");
  }
}

async function ensureBackupDirectory(configDirectory) {
  const canonicalConfig = await realpath(configDirectory);
  const backupDirectory = join(canonicalConfig, "backups");
  await mkdir(backupDirectory, { recursive: true, mode: DIRECTORY_MODE });
  await assertPrivateDirectory(backupDirectory);
  return realpath(backupDirectory);
}

function validateLabels(labels, project, instanceId) {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
    fail("LOCAL_DATA_VOLUME_OWNERSHIP_UNVERIFIED");
  }
  const expected = localVolumeLabels({ project, instanceId });
  for (const key of Object.values(LOCAL_VOLUME_LABEL_KEYS)) {
    if (labels[key] !== expected[key]) fail("LOCAL_DATA_VOLUME_OWNERSHIP_UNVERIFIED");
  }
}

export const createDataToolDependencies = () =>
  Object.freeze({
    loadLocalConfig,
    resolveLocalConfigPaths,
    toLocalConfigEnvironment,
    capture: createExecFileCaptureRunner(),
    stream: createStreamRunner(),
    now: () => new Date(),
    randomUUID,
  });

export async function prepareLocalDataContext(options, dependencies) {
  const project = resolveComposeProject(options.env);
  const config = await dependencies.loadLocalConfig({ env: options.env });
  const paths = dependencies.resolveLocalConfigPaths({ env: options.env });
  const env = Object.freeze({
    ...options.env,
    ...dependencies.toLocalConfigEnvironment(config),
  });
  let labels;
  try {
    labels = JSON.parse(
      await dependencies.capture(volumeInspectLabelsCommand(project), {
        cwd: options.cwd,
        env,
      }),
    );
  } catch (error) {
    fail("LOCAL_DATA_VOLUME_OWNERSHIP_UNVERIFIED", error);
  }
  validateLabels(labels, project, config.instanceId);
  const backupDirectory = await ensureBackupDirectory(paths.directoryPath);
  return Object.freeze({ project, config, env, backupDirectory });
}

// Keep ACLs in the dump: the restored migration ledger prevents already-applied
// migrations from replaying grants, while --no-owner keeps the archive portable.
export const postgresDumpCommand = (project) =>
  composeCommand(
    [
      "exec",
      "-T",
      "--user",
      "postgres",
      "postgres",
      "pg_dump",
      "--dbname=laundry_v2",
      "--format=custom",
      "--no-owner",
    ],
    { project },
  );

export const postgresRestoreCommand = (project) =>
  composeCommand(
    [
      "exec",
      "-T",
      "--user",
      "postgres",
      "postgres",
      "pg_restore",
      "--dbname=laundry_v2",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--exit-on-error",
      "--single-transaction",
    ],
    { project },
  );

export function createStreamRunner({ spawn = nodeSpawn } = {}) {
  return async (command, options) =>
    await new Promise((resolveRun, rejectRun) => {
      let child;
      try {
        child = spawn(command.file, [...command.args], {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: [
            options.inputFd === undefined ? "ignore" : options.inputFd,
            options.outputFd === undefined ? "inherit" : options.outputFd,
            "inherit",
          ],
        });
      } catch (error) {
        rejectRun(new LocalDataError("LOCAL_DATA_COMMAND_FAILED", { cause: error }));
        return;
      }
      child.once("error", (error) =>
        rejectRun(new LocalDataError("LOCAL_DATA_COMMAND_FAILED", { cause: error })),
      );
      child.once("exit", (code) => {
        if (code === 0) resolveRun();
        else rejectRun(new LocalDataError("LOCAL_DATA_COMMAND_FAILED"));
      });
    });
}

function timestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) fail("LOCAL_BACKUP_CLOCK_INVALID");
  return `${date.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "")}Z`;
}

async function sha256File(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", rejectHash);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function writePrivateJson(path, value) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createDatabaseBackup(context, options, dependencies) {
  const suffix = dependencies.randomUUID().replaceAll("-", "").slice(0, 8);
  const name = `laundry-v2-${options.kind}-${timestamp(dependencies.now())}-${suffix}.dump`;
  if (!BACKUP_NAME.test(name)) fail("LOCAL_BACKUP_NAME_INVALID");
  const finalPath = join(context.backupDirectory, name);
  const temporaryPath = join(context.backupDirectory, `.${name}.tmp`);
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    FILE_MODE,
  );
  try {
    await dependencies.stream(postgresDumpCommand(context.project), {
      cwd: options.cwd,
      env: context.env,
      outputFd: handle.fd,
    });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    fail("LOCAL_BACKUP_DUMP_FAILED", error);
  }
  await handle.close();
  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    fail("LOCAL_BACKUP_PUBLISH_FAILED", error);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  const metadata = await lstat(finalPath);
  if (!metadata.isFile() || metadata.size < 1 || (metadata.mode & 0o7777) !== FILE_MODE) {
    fail("LOCAL_BACKUP_FILE_INVALID");
  }
  const sha256 = await sha256File(finalPath);
  const manifest = Object.freeze({
    version: 1,
    file: name,
    sha256,
    bytes: metadata.size,
    created_at: options.createdAt ?? dependencies.now().toISOString(),
    instance_id: context.config.instanceId,
  });
  try {
    await writePrivateJson(`${finalPath}.json`, manifest);
  } catch (error) {
    await unlink(finalPath).catch(() => undefined);
    fail("LOCAL_BACKUP_MANIFEST_WRITE_FAILED", error);
  }
  return Object.freeze({ path: finalPath, sha256, bytes: metadata.size });
}

export async function verifyBackupFile(context, inputPath, expectedSha256) {
  if (!isAbsolute(inputPath) || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    fail("LOCAL_RESTORE_ARGS_INVALID");
  }
  const candidate = resolve(inputPath);
  if (
    !contained(context.backupDirectory, candidate) ||
    dirname(candidate) !== context.backupDirectory ||
    !BACKUP_NAME.test(basename(candidate))
  ) {
    fail("LOCAL_RESTORE_FILE_FORBIDDEN");
  }
  const metadata = await lstat(candidate).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    (metadata.mode & 0o7777) !== FILE_MODE
  ) {
    fail("LOCAL_RESTORE_FILE_INVALID");
  }
  const actualSha256 = await sha256File(candidate);
  if (actualSha256 !== expectedSha256) fail("LOCAL_RESTORE_CHECKSUM_MISMATCH");
  let manifest;
  try {
    const manifestMetadata = await lstat(`${candidate}.json`);
    if (
      !manifestMetadata.isFile() ||
      manifestMetadata.isSymbolicLink() ||
      manifestMetadata.size < 1 ||
      manifestMetadata.size > 16_384 ||
      (manifestMetadata.mode & 0o7777) !== FILE_MODE
    ) {
      fail("LOCAL_RESTORE_MANIFEST_INVALID");
    }
    manifest = JSON.parse(await readFile(`${candidate}.json`, "utf8"));
  } catch (error) {
    if (error instanceof LocalDataError) throw error;
    fail("LOCAL_RESTORE_MANIFEST_INVALID", error);
  }
  const manifestKeys =
    manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      ? Object.keys(manifest).sort()
      : [];
  if (
    manifestKeys.join(",") !== "bytes,created_at,file,instance_id,sha256,version" ||
    manifest?.version !== 1 ||
    manifest.file !== basename(candidate) ||
    manifest.sha256 !== actualSha256 ||
    manifest.bytes !== metadata.size ||
    manifest.instance_id !== context.config.instanceId
  ) {
    fail("LOCAL_RESTORE_MANIFEST_INVALID");
  }
  return Object.freeze({ path: candidate, sha256: actualSha256, bytes: metadata.size });
}

export const dataToolErrorCode = (error, fallback) =>
  error instanceof LocalDataError ? error.code : fallback;

export { BACKUP_NAME };
