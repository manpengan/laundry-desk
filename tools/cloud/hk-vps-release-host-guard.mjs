import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { assertRetainedBackups } from "./hk-vps-release-backup-retention.mjs";
import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import { KB_HEALTH_URL, KB_LOOPBACK_HEALTH_URL, fail } from "./hk-vps-release-core.mjs";
import { assertRetainedReleaseControllers } from "./hk-vps-release-controller-retention.mjs";
import { assertRetainedFinalizeEvidence } from "./hk-vps-release-evidence-retention.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import { HISTORY_ROOT, releasePaths } from "./hk-vps-release-remote-support.mjs";

export const MINIMUM_RELEASE_FREE_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_RETAINED_RELEASES = 8;

const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});
const OPT_ROOT = dirname(PROFILE.paths.liveRoot);
const POSTGRESQL_ROOT = PROFILE.paths.postgresDataRoot;
const { postgresDatabase, postgresHost, postgresPort } = PROFILE.services;
const SHA = "[0-9a-f]{40}";
const TOKEN = "[0-9a-f]{32}";
const ARTIFACT_PATTERNS = Object.freeze([
  Object.freeze({ pattern: new RegExp(`^laundry-desk\\.next-${SHA}$`, "u"), type: "directory" }),
  Object.freeze({ pattern: new RegExp(`^laundry-desk\\.failed-${SHA}$`, "u"), type: "directory" }),
  Object.freeze({
    pattern: new RegExp(`^laundry-desk\\.rollback-${SHA}-before-${SHA}$`, "u"),
    type: "directory",
  }),
  Object.freeze({
    pattern: /^laundry-desk\.rollback-pre-[0-9a-f]{7}-\d{8}T\d{6}Z$/u,
    type: "directory",
  }),
  Object.freeze({
    pattern: new RegExp(`^laundry-desk\\.incoming-${SHA}-${TOKEN}\\.tar$`, "u"),
    type: "archive",
  }),
]);
const HISTORY_PATTERN = new RegExp(`^${SHA}-${TOKEN}-(?:committed|rolled_back)\\.json$`, "u");

function commandOptions(label, signal) {
  return Object.freeze({
    cwd: "/",
    environment: COMMAND_ENVIRONMENT,
    label,
    signal,
    timeoutMs: 2 * 60_000,
  });
}

async function command(file, arguments_, label, signal, dependencies) {
  const execute = dependencies.runCloudCommand ?? runCloudCommand;
  return await execute(file, arguments_, commandOptions(label, signal));
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function parseAvailableBytes(source) {
  if (typeof source !== "string") fail("CLOUD_RELEASE_CAPACITY_INVALID");
  const match = /^\s*Avail\s*\n\s*(\d+)\s*\n?$/u.exec(source);
  const bytes = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail("CLOUD_RELEASE_CAPACITY_INVALID");
  return bytes;
}

function parseIdentity(source, code) {
  if (typeof source !== "string" || !/^\d+\n?$/u.test(source)) fail(code);
  const value = Number(source.trim());
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

async function identity(flag, user, label, signal, code, dependencies) {
  const result = await command("/usr/bin/id", [flag, user], label, signal, dependencies);
  return parseIdentity(result.stdout, code);
}

export function assertLoopbackBindings(source, port, code) {
  if (typeof source !== "string" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    fail(code);
  }
  const allowed = new Set([`127.0.0.1:${port}`, `[::1]:${port}`]);
  const lines = source
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 1) fail(code);
  for (const line of lines) {
    const fields = line.split(/\s+/u);
    if (fields.length < 5 || fields[0] !== "LISTEN" || !allowed.has(fields[3])) fail(code);
  }
}

function assertExactOk(source, code) {
  if (typeof source !== "string" || !/^ok\n?$/u.test(source)) fail(code);
}

async function assertRoot(path, mode, code, dependencies, allowMissing = false, expectedGid = 0) {
  let metadata;
  try {
    metadata = await (dependencies.lstat ?? lstat)(path);
  } catch (error) {
    if (allowMissing && isMissing(error)) return false;
    fail(code, error);
  }
  const canonical = await (dependencies.realpath ?? realpath)(path).catch(() => null);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== expectedGid ||
    (metadata.mode & 0o7777) !== mode ||
    canonical !== path
  ) {
    fail(code);
  }
  return true;
}

async function assertEntry(path, type, code, dependencies) {
  const metadata = await (dependencies.lstat ?? lstat)(path).catch(() => null);
  const canonical =
    metadata === null ? null : await (dependencies.realpath ?? realpath)(path).catch(() => null);
  const ordinary =
    metadata !== null &&
    !metadata.isSymbolicLink() &&
    metadata.uid === 0 &&
    metadata.gid === 0 &&
    canonical === path;
  const valid =
    type === "directory"
      ? ordinary && metadata.isDirectory() && (metadata.mode & 0o7777) === 0o755
      : ordinary &&
        metadata.isFile() &&
        (metadata.mode & 0o7777) === 0o600 &&
        metadata.size >= (type === "manifest" || type === "history" ? 2 : 1) &&
        (type !== "manifest" && type !== "history" ? true : metadata.size <= 64 * 1024);
  if (!valid) fail(code);
}

async function namesIn(path, code, dependencies) {
  let names;
  try {
    names = await (dependencies.readdir ?? readdir)(path);
  } catch (error) {
    fail(code, error);
  }
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) fail(code);
  return names;
}

function assertRoomForRelease(count, code) {
  if (!Number.isSafeInteger(count) || count < 0 || count >= MAX_RETAINED_RELEASES) fail(code);
}

async function readArtifactRetention(dependencies) {
  await assertRoot(OPT_ROOT, 0o755, "CLOUD_RELEASE_ARTIFACT_RETENTION_INVALID", dependencies);
  const names = (
    await namesIn(OPT_ROOT, "CLOUD_RELEASE_ARTIFACT_RETENTION_INVALID", dependencies)
  ).filter((name) => name.startsWith(`${basename(PROFILE.paths.liveRoot)}.`));
  for (const name of names) {
    const specification = ARTIFACT_PATTERNS.find(({ pattern }) => pattern.test(name));
    if (specification === undefined) fail("CLOUD_RELEASE_ARTIFACT_RETENTION_INVALID");
    await assertEntry(
      join(OPT_ROOT, name),
      specification.type,
      "CLOUD_RELEASE_ARTIFACT_RETENTION_INVALID",
      dependencies,
    );
  }
  return names.length;
}

async function readHistoryRetention(dependencies) {
  await assertRoot(HISTORY_ROOT, 0o700, "CLOUD_RELEASE_HISTORY_RETENTION_INVALID", dependencies);
  const names = await namesIn(
    HISTORY_ROOT,
    "CLOUD_RELEASE_HISTORY_RETENTION_INVALID",
    dependencies,
  );
  for (const name of names) {
    if (!HISTORY_PATTERN.test(name)) fail("CLOUD_RELEASE_HISTORY_RETENTION_INVALID");
    await assertEntry(
      join(HISTORY_ROOT, name),
      "history",
      "CLOUD_RELEASE_HISTORY_RETENTION_INVALID",
      dependencies,
    );
  }
  return names.length;
}

async function availableBytes(path, label, signal, dependencies) {
  const result = await command(
    "/usr/bin/df",
    ["--block-size=1", "--output=avail", "--", path],
    `CLOUD_RELEASE_${label}_CAPACITY`,
    signal,
    dependencies,
  );
  return parseAvailableBytes(result.stdout);
}

export async function readReleaseHostSnapshot(signal, dependencies = {}) {
  const optAvailableBytes = await availableBytes(OPT_ROOT, "OPT", signal, dependencies);
  const postgresqlAvailableBytes = await availableBytes(
    POSTGRESQL_ROOT,
    "POSTGRESQL",
    signal,
    dependencies,
  );
  const optResident = await readArtifactRetention(dependencies);
  const historyActive = await readHistoryRetention(dependencies);
  return Object.freeze({
    historyActive,
    optAvailableBytes,
    optResident,
    postgresqlAvailableBytes,
  });
}

export async function assertReleasePreflight(signal, dependencies = {}) {
  for (const [path, label] of [
    [OPT_ROOT, "OPT"],
    [POSTGRESQL_ROOT, "POSTGRESQL"],
  ]) {
    if ((await availableBytes(path, label, signal, dependencies)) < MINIMUM_RELEASE_FREE_BYTES) {
      fail("CLOUD_RELEASE_CAPACITY_LOW");
    }
  }
  assertRoomForRelease(
    await readArtifactRetention(dependencies),
    "CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT",
  );
  assertRoomForRelease(
    await readHistoryRetention(dependencies),
    "CLOUD_RELEASE_HISTORY_RETENTION_LIMIT",
  );
  await (dependencies.assertRetainedEvidence ?? assertRetainedFinalizeEvidence)(dependencies);
  await (dependencies.assertRetainedControllers ?? assertRetainedReleaseControllers)(dependencies);
  const postgresGid = await identity(
    "-g",
    "postgres",
    "CLOUD_RELEASE_POSTGRES_GID",
    signal,
    "CLOUD_RELEASE_POSTGRES_IDENTITY_INVALID",
    dependencies,
  );
  await (dependencies.assertRetainedBackups ?? assertRetainedBackups)({
    ...dependencies,
    postgresGid,
  });
}

async function curl(url, label, signal, dependencies) {
  return await command(
    "/usr/bin/curl",
    ["--fail", "--silent", "--show-error", "--max-time", "15", url],
    label,
    signal,
    dependencies,
  );
}

export async function assertSharedInfrastructure(signal, dependencies = {}) {
  for (const [service, label] of [
    [PROFILE.services.kb, "KB_WEB"],
    [PROFILE.services.caddy, "CADDY"],
    [PROFILE.services.postgres, "POSTGRESQL"],
  ]) {
    await command(
      "/usr/bin/systemctl",
      ["is-active", "--quiet", service],
      `CLOUD_RELEASE_${label}_ACTIVE`,
      signal,
      dependencies,
    );
  }
  const failed = await command(
    "/usr/bin/systemctl",
    ["--failed", "--no-legend", "--plain"],
    "CLOUD_RELEASE_FAILED_UNITS",
    signal,
    dependencies,
  );
  if (failed.stdout.trim() !== "") fail("CLOUD_RELEASE_FAILED_UNITS_PRESENT");

  const localKb = await curl(
    KB_LOOPBACK_HEALTH_URL,
    "CLOUD_RELEASE_KB_LOOPBACK_HEALTH",
    signal,
    dependencies,
  );
  const publicKb = await curl(
    KB_HEALTH_URL,
    "CLOUD_RELEASE_KB_PUBLIC_HEALTH",
    signal,
    dependencies,
  );
  assertExactOk(localKb.stdout, "CLOUD_RELEASE_KB_LOOPBACK_HEALTH_INVALID");
  assertExactOk(publicKb.stdout, "CLOUD_RELEASE_KB_PUBLIC_HEALTH_INVALID");

  await command(
    "/usr/bin/pg_isready",
    [`--host=${postgresHost}`, `--port=${postgresPort}`, `--dbname=${postgresDatabase}`],
    "CLOUD_RELEASE_POSTGRES_READY",
    signal,
    dependencies,
  );
  for (const [port, label, code] of [
    [postgresPort, "POSTGRES", "CLOUD_RELEASE_POSTGRES_BINDING_INVALID"],
    [PROFILE.services.kbPort, "KB", "CLOUD_RELEASE_KB_BINDING_INVALID"],
  ]) {
    const sockets = await command(
      "/usr/bin/ss",
      ["-H", "-ltn", "sport", "=", `:${port}`],
      `CLOUD_RELEASE_${label}_BINDING`,
      signal,
      dependencies,
    );
    assertLoopbackBindings(sockets.stdout, port, code);
  }
}

export async function removeOrphanStaging(record, signal, dependencies = {}) {
  let expected;
  try {
    expected = releasePaths(record.candidate_sha, record.expected_sha).staging;
  } catch (error) {
    fail("CLOUD_RELEASE_STAGING_PATH_INVALID", error);
  }
  if (record.staging_path !== expected) fail("CLOUD_RELEASE_STAGING_PATH_INVALID");
  const stat = dependencies.lstat ?? lstat;
  let metadata;
  try {
    metadata = await stat(expected);
  } catch (error) {
    if (isMissing(error)) return false;
    fail("CLOUD_RELEASE_STAGING_PATH_INVALID", error);
  }
  const parent = await stat(OPT_ROOT).catch(() => null);
  const canonical = await (dependencies.realpath ?? realpath)(expected).catch(() => null);
  const canonicalParent = await (dependencies.realpath ?? realpath)(OPT_ROOT).catch(() => null);
  const laundryUid = await identity(
    "-u",
    "laundry",
    "CLOUD_RELEASE_LAUNDRY_UID",
    signal,
    "CLOUD_RELEASE_LAUNDRY_IDENTITY_INVALID",
    dependencies,
  );
  const laundryGid = await identity(
    "-g",
    "laundry",
    "CLOUD_RELEASE_LAUNDRY_GID",
    signal,
    "CLOUD_RELEASE_LAUNDRY_IDENTITY_INVALID",
    dependencies,
  );
  const ownerValid =
    (metadata.uid === 0 && metadata.gid === 0) ||
    (metadata.uid === laundryUid && metadata.gid === laundryGid);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !ownerValid ||
    (metadata.mode & 0o7777) !== 0o755 ||
    parent === null ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0 ||
    parent.gid !== 0 ||
    (parent.mode & 0o7777) !== 0o755 ||
    metadata.dev !== parent.dev ||
    canonicalParent !== OPT_ROOT ||
    canonical !== expected
  ) {
    fail("CLOUD_RELEASE_STAGING_PATH_INVALID");
  }
  await command(
    "/usr/bin/rm",
    ["-rf", "--one-file-system", "--", expected],
    "CLOUD_RELEASE_STAGING_CLEANUP",
    signal,
    dependencies,
  );
  try {
    await stat(expected);
  } catch (error) {
    if (isMissing(error)) return true;
    fail("CLOUD_RELEASE_STAGING_CLEANUP_FAILED", error);
  }
  fail("CLOUD_RELEASE_STAGING_CLEANUP_FAILED");
}
