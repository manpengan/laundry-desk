import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import {
  fail,
  incomingArchivePath,
  requireDigest,
  requireMigrationHead,
  requireSha,
  requireToken,
  sha256File,
} from "./hk-vps-release-core.mjs";
import { validateController } from "./hk-vps-release-controller-launcher.mjs";
import {
  MIGRATION_RUNNER_RELATIVE,
  parseMigrationAuthority,
  verifyMigrationAuthority,
} from "./hk-vps-release-migration-authority.mjs";
import { MIGRATION_SCRIPT } from "./hk-vps-release-migration-script.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import { STATE_ROOT, releasePaths } from "./hk-vps-release-remote-support.mjs";

const REQUEST_KEYS = Object.freeze([
  "archive_sha256",
  "authority",
  "candidate_sha",
  "controller_sha256",
  "expected_sha",
  "migration_head",
  "schema",
  "token",
  "version",
]);
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseMigrationExecutionRequest(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail("CLOUD_RELEASE_MIGRATION_REQUEST_INVALID", error);
  }
  if (
    !exactKeys(value, REQUEST_KEYS) ||
    value.schema !== "laundry.cloud-release.migration-request" ||
    value.version !== 1 ||
    source !== JSON.stringify(value)
  ) {
    fail("CLOUD_RELEASE_MIGRATION_REQUEST_INVALID");
  }
  const authority = parseMigrationAuthority(value.authority);
  const migrationHead = requireMigrationHead(value.migration_head);
  if (authority.migrations.at(-1)?.filename !== migrationHead) {
    fail("CLOUD_RELEASE_MIGRATION_REQUEST_INVALID");
  }
  return Object.freeze({
    archive_sha256: requireDigest(value.archive_sha256),
    authority,
    candidate_sha: requireSha(value.candidate_sha),
    controller_sha256: requireDigest(value.controller_sha256),
    expected_sha: requireSha(value.expected_sha),
    migration_head: migrationHead,
    schema: value.schema,
    token: requireToken(value.token),
    version: value.version,
  });
}

function commandOptions(label, signal, timeoutMs = 2 * 60_000, input = "") {
  return Object.freeze({
    cwd: "/",
    environment: COMMAND_ENVIRONMENT,
    input,
    label,
    signal,
    timeoutMs,
  });
}

async function assertPrivateArchive(path, expectedDigest, dependencies) {
  const metadata = await dependencies.lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o7777) !== 0o600 ||
    metadata.size < 1 ||
    (await dependencies.realpath(path).catch(() => null)) !== path ||
    (await dependencies.sha256File(path)) !== expectedDigest
  ) {
    fail("CLOUD_RELEASE_MIGRATION_ARCHIVE_INVALID");
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function archiveMembers(authority) {
  return Object.freeze([
    MIGRATION_RUNNER_RELATIVE,
    ...authority.migrations.map(({ filename }) => `packages/db/src/migrations/${filename}`),
  ]);
}

async function extractMigrationBundle(archive, target, authority, signal, dependencies) {
  await dependencies.runCloudCommand(
    "/usr/bin/tar",
    [
      "--extract",
      "--file",
      archive,
      "--directory",
      target,
      "--no-same-owner",
      "--no-same-permissions",
      "--no-overwrite-dir",
      "--",
      ...archiveMembers(authority),
    ],
    commandOptions("CLOUD_RELEASE_MIGRATION_EXTRACT", signal, 2 * 60_000),
  );
  await dependencies.chmod(target, 0o700);
  await dependencies.syncDirectory(target);
}

async function readInput(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) fail("CLOUD_RELEASE_MIGRATION_REQUEST_INVALID");
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export async function executeMigrationRequest(source, signal, inputDependencies = {}) {
  const request = parseMigrationExecutionRequest(source);
  const dependencies = Object.freeze({
    chmod: inputDependencies.chmod ?? chmod,
    lstat: inputDependencies.lstat ?? lstat,
    mkdtemp: inputDependencies.mkdtemp ?? mkdtemp,
    realpath: inputDependencies.realpath ?? realpath,
    rm: inputDependencies.rm ?? rm,
    runCloudCommand: inputDependencies.runCloudCommand ?? runCloudCommand,
    sha256File: inputDependencies.sha256File ?? sha256File,
    syncDirectory: inputDependencies.syncDirectory ?? syncDirectory,
    validateController: inputDependencies.validateController ?? validateController,
    verifyMigrationAuthority:
      inputDependencies.verifyMigrationAuthority ?? verifyMigrationAuthority,
  });
  const controller = await dependencies.validateController(request);
  if (
    controller.digest !== request.controller_sha256 ||
    controller.metadata.archive_sha256 !== request.archive_sha256
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_BINDING_INVALID");
  }
  const archive = incomingArchivePath(request.candidate_sha, request.token);
  await assertPrivateArchive(archive, request.archive_sha256, dependencies);
  const staging = releasePaths(request.candidate_sha, request.expected_sha).staging;
  const temporary = await dependencies.mkdtemp(
    join(STATE_ROOT, `.migration-${request.candidate_sha}-`),
  );
  try {
    await extractMigrationBundle(archive, temporary, request.authority, signal, dependencies);
    await dependencies.verifyMigrationAuthority(staging, request.authority);
    await dependencies.verifyMigrationAuthority(temporary, request.authority);
    await dependencies.runCloudCommand(
      "/usr/bin/bash",
      ["-c", MIGRATION_SCRIPT, "cloud-release-migrate", temporary],
      commandOptions("CLOUD_RELEASE_MIGRATE", signal, 10 * 60_000),
    );
  } finally {
    await dependencies.rm(temporary, { force: true, recursive: true });
  }
}

async function main() {
  if (process.getuid?.() !== 0) fail("CLOUD_RELEASE_ROOT_REQUIRED");
  await executeMigrationRequest(await readInput());
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error?.code?.startsWith?.("CLOUD_RELEASE_") ? error.code : "CLOUD_RELEASE_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
