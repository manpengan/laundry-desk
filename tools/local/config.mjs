import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
} from "node:path";
import { randomBytes as secureRandomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const CONFIG_VERSION = 1;
const CONFIG_DIRECTORY_NAME = "laundry-desk-v2";
const CONFIG_FILE_NAME = "config.json";
const MINIMUM_INSTANCE_ID_BYTES = 16;
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_INSTANCE_ID_CHARACTERS = 128;
const MAXIMUM_SECRET_CHARACTERS = 512;
const MAXIMUM_CONFIG_BYTES = 16 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SECRET_FIELDS = Object.freeze([
  "postgresSuperuserPassword",
  "postgresAppPassword",
  "accessTokenSecret",
  "csrfProofSecret",
]);
const CONFIG_FIELDS = Object.freeze(["version", "instanceId", ...SECRET_FIELDS]);

class LocalConfigError extends Error {
  constructor(reason, code = "INVALID_LOCAL_CONFIG") {
    super(`Invalid local configuration: ${reason}`);
    this.name = "LocalConfigError";
    this.code = code;
  }
}

function fail(reason, code) {
  throw new LocalConfigError(reason, code);
}

function assertAbsoluteDirectoryPath(value, fieldName) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    !isAbsolute(value)
  ) {
    fail(`${fieldName} must be a non-empty absolute path`);
  }

  const normalizedPath = resolve(value);
  if (normalizedPath === parsePath(normalizedPath).root) {
    fail(`${fieldName} must not be a filesystem root`);
  }
  return normalizedPath;
}

function defaultApplicationSupportDirectory({ platform, homeDir }) {
  const normalizedHome = assertAbsoluteDirectoryPath(homeDir, "home directory");
  return platform === "darwin"
    ? join(normalizedHome, "Library", "Application Support")
    : join(normalizedHome, ".local", "share");
}

function assertSupportedPlatform(platform) {
  if (platform !== "darwin" && platform !== "linux") {
    fail("platform must be darwin or linux");
  }
}

function isInsideDirectory(rootPath, candidatePath) {
  const repositoryRelativePath = relative(rootPath, candidatePath);
  return (
    repositoryRelativePath === "" ||
    (!repositoryRelativePath.startsWith("..") && !isAbsolute(repositoryRelativePath))
  );
}

function assertRepositoryExternal(directoryPath) {
  if (isInsideDirectory(REPOSITORY_ROOT, directoryPath)) {
    fail("config directory must be outside the repository");
  }
}

async function canonicalizeUsingExistingAncestor(directoryPath) {
  const unresolvedNames = [];
  let candidatePath = directoryPath;

  while (true) {
    try {
      const canonicalAncestor = await realpath(candidatePath);
      return resolve(canonicalAncestor, ...unresolvedNames);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        fail("config path ancestors could not be canonicalized");
      }
    }

    const parentPath = dirname(candidatePath);
    if (parentPath === candidatePath) {
      fail("config path ancestors could not be canonicalized");
    }
    unresolvedNames.unshift(basename(candidatePath));
    candidatePath = parentPath;
  }
}

async function assertCanonicalRepositoryExternal(directoryPath) {
  let canonicalRepository;
  try {
    canonicalRepository = await realpath(REPOSITORY_ROOT);
  } catch {
    fail("repository path could not be canonicalized");
  }
  const canonicalDirectory = await canonicalizeUsingExistingAncestor(directoryPath);
  if (isInsideDirectory(canonicalRepository, canonicalDirectory)) {
    fail("config directory must be outside the repository");
  }
}

export function resolveLocalConfigPaths({
  platform = process.platform,
  homeDir = homedir(),
  env = process.env,
} = {}) {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    fail("environment must be an object");
  }
  assertSupportedPlatform(platform);

  const override = env.LAUNDRY_LOCAL_CONFIG_DIR;
  const directoryPath =
    override === undefined
      ? join(
          defaultApplicationSupportDirectory({ platform, homeDir }),
          CONFIG_DIRECTORY_NAME,
          "local",
        )
      : assertAbsoluteDirectoryPath(override, "LAUNDRY_LOCAL_CONFIG_DIR");
  assertRepositoryExternal(directoryPath);

  return Object.freeze({
    directoryPath,
    filePath: join(directoryPath, CONFIG_FILE_NAME),
  });
}

function encodeSecret(randomSource) {
  let bytes;
  try {
    bytes = randomSource(MINIMUM_SECRET_BYTES);
  } catch {
    fail("secret generation failed");
  }

  if (!(bytes instanceof Uint8Array) || bytes.byteLength < MINIMUM_SECRET_BYTES) {
    fail(`secret generation requires at least ${MINIMUM_SECRET_BYTES} random bytes`);
  }
  return Buffer.from(bytes).toString("base64url");
}

function encodeInstanceId(randomSource) {
  let bytes;
  try {
    bytes = randomSource(MINIMUM_INSTANCE_ID_BYTES);
  } catch {
    fail("instance identifier generation failed");
  }

  if (!(bytes instanceof Uint8Array) || bytes.byteLength < MINIMUM_INSTANCE_ID_BYTES) {
    fail(
      `instance identifier generation requires at least ${MINIMUM_INSTANCE_ID_BYTES} random bytes`,
    );
  }
  return Buffer.from(bytes).toString("base64url");
}

export function generateLocalConfig({ randomBytes = secureRandomBytes } = {}) {
  if (typeof randomBytes !== "function") {
    fail("randomBytes must be a function");
  }

  const secrets = SECRET_FIELDS.map(() => encodeSecret(randomBytes));
  if (new Set(secrets).size !== secrets.length) {
    fail("generated secrets must be independent");
  }

  return Object.freeze({
    version: CONFIG_VERSION,
    instanceId: encodeInstanceId(randomBytes),
    postgresSuperuserPassword: secrets[0],
    postgresAppPassword: secrets[1],
    accessTokenSecret: secrets[2],
    csrfProofSecret: secrets[3],
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalSecret(value) {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_SECRET_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return false;
  }

  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength >= MINIMUM_SECRET_BYTES && bytes.toString("base64url") === value;
}

function isCanonicalInstanceId(value) {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_INSTANCE_ID_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return false;
  }

  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength >= MINIMUM_INSTANCE_ID_BYTES && bytes.toString("base64url") === value;
}

export function parseLocalConfig(value) {
  if (!isPlainObject(value)) {
    fail("content must be an object");
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = [...CONFIG_FIELDS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail("content has missing or unexpected fields");
  }
  if (value.version !== CONFIG_VERSION) {
    fail(`version must equal ${CONFIG_VERSION}`);
  }
  if (!isCanonicalInstanceId(value.instanceId)) {
    fail("instanceId must be canonical base64url encoding of at least 16 bytes");
  }

  for (const field of SECRET_FIELDS) {
    if (!isCanonicalSecret(value[field])) {
      fail(`${field} must be canonical base64url encoding of at least 32 bytes`);
    }
  }

  const secrets = SECRET_FIELDS.map((field) => value[field]);
  if (new Set(secrets).size !== secrets.length) {
    fail("all generated secrets must be independent");
  }

  return Object.freeze({
    version: CONFIG_VERSION,
    instanceId: value.instanceId,
    postgresSuperuserPassword: value.postgresSuperuserPassword,
    postgresAppPassword: value.postgresAppPassword,
    accessTokenSecret: value.accessTokenSecret,
    csrfProofSecret: value.csrfProofSecret,
  });
}

function serializeConfig(config) {
  return `${JSON.stringify(parseLocalConfig(config), null, 2)}\n`;
}

async function assertNoSymbolicLinkAncestors(directoryPath) {
  const filesystemRoot = parsePath(directoryPath).root;
  let candidatePath = directoryPath;

  while (true) {
    try {
      const metadata = await lstat(candidatePath);
      if (metadata.isSymbolicLink()) {
        fail("config path must not contain a symbolic-link ancestor");
      }
      if (!metadata.isDirectory()) {
        fail("config path ancestors must be regular directories");
      }
    } catch (error) {
      if (error instanceof LocalConfigError) {
        throw error;
      }
      if (error?.code !== "ENOENT") {
        fail("config path ancestors could not be inspected");
      }
    }

    if (candidatePath === filesystemRoot) {
      return;
    }
    candidatePath = dirname(candidatePath);
  }
}

async function assertPrivateDirectory(directoryPath, { create }) {
  await assertNoSymbolicLinkAncestors(directoryPath);
  await assertCanonicalRepositoryExternal(directoryPath);

  if (create) {
    try {
      await mkdir(directoryPath, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    } catch {
      fail("private config directory could not be created");
    }
  }

  await assertNoSymbolicLinkAncestors(directoryPath);
  await assertCanonicalRepositoryExternal(directoryPath);

  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("private config directory does not exist", "CONFIG_NOT_FOUND");
    }
    fail("private config directory could not be inspected");
  }

  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("config directory must be a regular directory");
  }
  if ((metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
    fail("config directory must have mode 0700");
  }
}

function assertPrivateConfigFileMetadata(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("config file must be a regular file");
  }
  if ((metadata.mode & 0o7777) !== PRIVATE_FILE_MODE) {
    fail("config file must have mode 0600");
  }
  if (metadata.size === 0 || metadata.size > MAXIMUM_CONFIG_BYTES) {
    fail(`config file must contain between 1 and ${MAXIMUM_CONFIG_BYTES} bytes`);
  }
}

function parseConfigContents(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("config file must contain valid JSON");
  }

  const config = parseLocalConfig(parsed);
  if (contents !== serializeConfig(config)) {
    fail("config file must use the canonical generated format");
  }
  return config;
}

async function readConfigFile(paths) {
  await assertPrivateDirectory(paths.directoryPath, { create: false });

  let metadata;
  try {
    metadata = await lstat(paths.filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("config file does not exist", "CONFIG_NOT_FOUND");
    }
    fail("config file could not be inspected");
  }

  assertPrivateConfigFileMetadata(metadata);

  let handle;
  try {
    handle = await open(paths.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedMetadata = await handle.stat();
    assertPrivateConfigFileMetadata(openedMetadata);
    if (metadata.dev !== openedMetadata.dev || metadata.ino !== openedMetadata.ino) {
      fail("config file changed during validation");
    }

    return parseConfigContents(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof LocalConfigError) {
      throw error;
    }
    fail("config file could not be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function loadLocalConfig(locationOptions = {}) {
  return readConfigFile(resolveLocalConfigPaths(locationOptions));
}

async function removeTemporaryFile(temporaryPath) {
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail("temporary config file could not be removed");
    }
  }
}

async function publishConfig(paths, config) {
  const temporaryPath = join(paths.directoryPath, `.config.${process.pid}.${randomUUID()}.tmp`);
  let handle;

  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(serializeConfig(config), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    await link(temporaryPath, paths.filePath);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail("config file could not be created atomically");
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await removeTemporaryFile(temporaryPath);
  }

  return readConfigFile(paths);
}

export async function ensureLocalConfig(options = {}) {
  const paths = resolveLocalConfigPaths(options);
  await assertPrivateDirectory(paths.directoryPath, { create: true });

  try {
    return await readConfigFile(paths);
  } catch (error) {
    if (!(error instanceof LocalConfigError) || error.code !== "CONFIG_NOT_FOUND") {
      throw error;
    }
  }

  const config = generateLocalConfig({ randomBytes: options.randomBytes });
  return publishConfig(paths, config);
}

export function toLocalConfigEnvironment(value) {
  const config = parseLocalConfig(value);
  return Object.freeze({
    POSTGRES_PASSWORD: config.postgresSuperuserPassword,
    LAUNDRY_APP_PASSWORD: config.postgresAppPassword,
    LAUNDRY_ACCESS_TOKEN_SECRET: config.accessTokenSecret,
    LAUNDRY_CSRF_PROOF_SECRET: config.csrfProofSecret,
    LAUNDRY_LOCAL_INSTANCE_ID: config.instanceId,
  });
}
