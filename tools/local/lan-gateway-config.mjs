import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, parse as parsePath, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAXIMUM_PEM_BYTES = 64 * 1024;
const MAXIMUM_RUNTIME_CONFIG_BYTES = 16 * 1024;
const MINIMUM_LAN_PORT = 1024;
const MAXIMUM_PORT = 65_535;
const RESERVED_LAN_PORTS = new Set([8543, 8787]);
const SHA256 = /^[0-9a-f]{64}$/u;
const RUNTIME_CONFIG_KEYS = Object.freeze([
  "owner_spa_sha256",
  "public_host",
  "public_port",
  "schema_version",
]);
const RUNTIME_HEALTHCHECK_PATH_KEYS = Object.freeze(["certPath", "configPath"]);
const RUNTIME_PATH_KEYS = Object.freeze(["certPath", "configPath", "keyPath", "webRoot"]);
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const WEB_ROOT = resolve(REPOSITORY_ROOT, "apps/web/dist-spa");

export class LanGatewayConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "LanGatewayConfigError";
    this.code = code;
  }
}

function fail(code) {
  throw new LanGatewayConfigError(code);
}

export function isPrivateLanIpv4(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function requireExactString(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${name}_INVALID`);
  }
  return value;
}

function hasExactKeys(value, keys) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function parseLanOrigin(environment) {
  const raw = requireExactString(environment, "LAUNDRY_LAN_ORIGIN");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("LAUNDRY_LAN_ORIGIN_INVALID");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== raw ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !isPrivateLanIpv4(parsed.hostname) ||
    !Number.isSafeInteger(port) ||
    port < MINIMUM_LAN_PORT ||
    port > MAXIMUM_PORT
  ) {
    fail("LAUNDRY_LAN_ORIGIN_INVALID");
  }
  return Object.freeze({ raw, host: parsed.hostname, authority: parsed.host, port });
}

function assertExternalPath(candidatePath, name) {
  if (
    !isAbsolute(candidatePath) ||
    resolve(candidatePath) !== candidatePath ||
    candidatePath === parsePath(candidatePath).root
  ) {
    fail(`${name}_INVALID`);
  }
  const repositoryRelative = relative(REPOSITORY_ROOT, candidatePath);
  if (
    repositoryRelative === "" ||
    (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative))
  ) {
    fail(`${name}_INSIDE_REPOSITORY`);
  }
}

async function readPemFile(candidatePath, name, privateFile) {
  assertExternalPath(candidatePath, name);
  let handle;
  try {
    handle = await open(candidatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const [metadata, canonicalPath] = await Promise.all([handle.stat(), realpath(candidatePath)]);
    assertExternalPath(canonicalPath, name);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAXIMUM_PEM_BYTES) {
      fail(`${name}_INVALID`);
    }
    if (privateFile && metadata.nlink !== 1) {
      fail(`${name}_HARDLINKS`);
    }
    const privatePermissionsInvalid =
      (metadata.mode & 0o400) === 0 || (metadata.mode & 0o177) !== 0;
    if (privateFile && privatePermissionsInvalid) {
      fail(`${name}_PERMISSIONS`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof LanGatewayConfigError) throw error;
    fail(`${name}_UNREADABLE`);
  } finally {
    await handle?.close();
  }
}

async function readRuntimeConfigFile(candidatePath) {
  const name = "LAUNDRY_LAN_CONFIG_FILE";
  assertExternalPath(candidatePath, name);
  let handle;
  try {
    handle = await open(candidatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const [metadata, canonicalPath] = await Promise.all([handle.stat(), realpath(candidatePath)]);
    assertExternalPath(canonicalPath, name);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size <= 0 ||
      metadata.size > MAXIMUM_RUNTIME_CONFIG_BYTES ||
      (metadata.mode & 0o400) === 0 ||
      (metadata.mode & 0o177) !== 0
    ) {
      fail(`${name}_INVALID`);
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof LanGatewayConfigError) throw error;
    fail(`${name}_UNREADABLE`);
  } finally {
    await handle?.close();
  }
}

function parseRuntimeProfile(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("LAUNDRY_LAN_CONFIG_INVALID");
  }
  if (!hasExactKeys(value, RUNTIME_CONFIG_KEYS)) fail("LAUNDRY_LAN_CONFIG_INVALID");
  if (
    value.schema_version !== 1 ||
    !isPrivateLanIpv4(value.public_host) ||
    !Number.isSafeInteger(value.public_port) ||
    value.public_port < MINIMUM_LAN_PORT ||
    value.public_port > MAXIMUM_PORT ||
    RESERVED_LAN_PORTS.has(value.public_port) ||
    typeof value.owner_spa_sha256 !== "string" ||
    !SHA256.test(value.owner_spa_sha256)
  ) {
    fail("LAUNDRY_LAN_CONFIG_INVALID");
  }
  return Object.freeze({
    publicHost: value.public_host,
    publicPort: value.public_port,
    ownerSpaSha256: value.owner_spa_sha256,
  });
}

export async function loadLanGatewayConfig(environment = process.env) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    fail("ENVIRONMENT_INVALID");
  }
  const origin = parseLanOrigin(environment);
  const bindHost = requireExactString(environment, "LAUNDRY_LAN_BIND_HOST");
  if (bindHost !== origin.host || !isPrivateLanIpv4(bindHost)) {
    fail("LAUNDRY_LAN_BIND_HOST_INVALID");
  }
  const certPath = requireExactString(environment, "LAUNDRY_TLS_CERT_FILE");
  const keyPath = requireExactString(environment, "LAUNDRY_TLS_KEY_FILE");
  if (certPath === keyPath) fail("LAUNDRY_TLS_FILES_MUST_DIFFER");

  const [cert, key] = await Promise.all([
    readPemFile(certPath, "LAUNDRY_TLS_CERT_FILE", false),
    readPemFile(keyPath, "LAUNDRY_TLS_KEY_FILE", true),
  ]);
  return Object.freeze({
    origin: origin.raw,
    authority: origin.authority,
    bindHost,
    port: origin.port,
    cert,
    key,
    webRoot: WEB_ROOT,
    backendHost: "127.0.0.1",
    backendPort: 8787,
  });
}

export async function loadRuntimeLanGatewayConfig(paths) {
  if (!hasExactKeys(paths, RUNTIME_PATH_KEYS)) fail("LAUNDRY_LAN_RUNTIME_PATHS_INVALID");
  for (const name of RUNTIME_PATH_KEYS) {
    if (typeof paths[name] !== "string" || paths[name].length === 0) {
      fail("LAUNDRY_LAN_RUNTIME_PATHS_INVALID");
    }
  }
  if (!isAbsolute(paths.webRoot) || resolve(paths.webRoot) !== paths.webRoot) {
    fail("LAUNDRY_LAN_WEB_ROOT_INVALID");
  }
  if (
    paths.certPath === paths.keyPath ||
    paths.configPath === paths.certPath ||
    paths.configPath === paths.keyPath
  ) {
    fail("LAUNDRY_LAN_RUNTIME_FILES_MUST_DIFFER");
  }
  const [rawProfile, cert, key] = await Promise.all([
    readRuntimeConfigFile(paths.configPath),
    readPemFile(paths.certPath, "LAUNDRY_TLS_CERT_FILE", false),
    readPemFile(paths.keyPath, "LAUNDRY_TLS_KEY_FILE", true),
  ]);
  const profile = parseRuntimeProfile(rawProfile);
  const authority = `${profile.publicHost}:${profile.publicPort}`;
  return Object.freeze({
    origin: `https://${authority}`,
    authority,
    bindHost: profile.publicHost,
    listenHost: "0.0.0.0",
    port: profile.publicPort,
    ownerSpaSha256: profile.ownerSpaSha256,
    cert,
    key,
    webRoot: paths.webRoot,
    backendHost: "127.0.0.1",
    backendPort: 8787,
  });
}

export async function loadRuntimeLanHealthcheckConfig(paths) {
  if (!hasExactKeys(paths, RUNTIME_HEALTHCHECK_PATH_KEYS)) {
    fail("LAUNDRY_LAN_HEALTHCHECK_PATHS_INVALID");
  }
  for (const name of RUNTIME_HEALTHCHECK_PATH_KEYS) {
    if (typeof paths[name] !== "string" || paths[name].length === 0) {
      fail("LAUNDRY_LAN_HEALTHCHECK_PATHS_INVALID");
    }
  }
  if (paths.configPath === paths.certPath) {
    fail("LAUNDRY_LAN_HEALTHCHECK_FILES_MUST_DIFFER");
  }
  const [rawProfile, cert] = await Promise.all([
    readRuntimeConfigFile(paths.configPath),
    readPemFile(paths.certPath, "LAUNDRY_TLS_CERT_FILE", false),
  ]);
  const profile = parseRuntimeProfile(rawProfile);
  return Object.freeze({
    authority: `${profile.publicHost}:${profile.publicPort}`,
    bindHost: profile.publicHost,
    port: profile.publicPort,
    cert,
  });
}
