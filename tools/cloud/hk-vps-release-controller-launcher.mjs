import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";

const ROOT = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.paths.controllerRoot;
const STATE = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.paths.releaseStateRoot;
const ENTRY = "tools/cloud/hk-vps-release-rollback-entry.mjs";
const ROLLBACK_PHASES = new Set([
  "staged",
  "write_frozen",
  "recovery_ready",
  "migrating",
  "switched",
  "awaiting_external_verification",
  "recovery_required",
]);
const REQUEST_KEYS = [
  "candidate_sha",
  "expected_sha",
  "migration_head",
  "schema",
  "token",
  "version",
];
const METADATA_KEYS = [
  "archive_sha256",
  "candidate_sha",
  "controller_sha256",
  "expected_sha",
  "migration_head",
  "schema",
  "token_sha256",
  "version",
];
const ITEM_KEYS = ["path", "sha256", "size"];
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TOKEN = /^[0-9a-f]{32}$/u;
const MIGRATION = /^\d{4}_[a-z0-9_]+\.sql$/u;
const CONTROLLER_FILE_PATH = /^tools\/cloud(?:\/[a-z0-9][a-z0-9.-]*)+$/u;

function fail(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function controllerPath(request, root = ROOT) {
  return join(root, `${request.candidate_sha}-${tokenDigest(request.token)}.controller`);
}

function parseRequest(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail("CLOUD_RELEASE_ROLLBACK_REQUEST_INVALID", error);
  }
  const canonical = JSON.stringify({
    candidate_sha: value?.candidate_sha,
    expected_sha: value?.expected_sha,
    migration_head: value?.migration_head,
    schema: value?.schema,
    token: value?.token,
    version: value?.version,
  });
  if (
    !exactKeys(value, REQUEST_KEYS) ||
    value.schema !== "laundry.cloud-release.rollback-request" ||
    value.version !== 1 ||
    !SHA.test(value.candidate_sha) ||
    !SHA.test(value.expected_sha) ||
    !MIGRATION.test(value.migration_head) ||
    !TOKEN.test(value.token) ||
    source !== canonical
  ) {
    fail("CLOUD_RELEASE_ROLLBACK_REQUEST_INVALID");
  }
  return Object.freeze(value);
}

async function assertDirectory(path, mode, authority = { gid: 0, uid: 0 }) {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== authority.uid ||
    metadata.gid !== authority.gid ||
    (mode === undefined ? (metadata.mode & 0o022) !== 0 : (metadata.mode & 0o7777) !== mode) ||
    (await realpath(path).catch(() => null)) !== path
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_INVALID");
  }
}

async function readPrivate(
  path,
  mode = 0o600,
  maximumBytes = 128 * 1024,
  authority = { gid: 0, uid: 0 },
) {
  let handle;
  let buffer;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== authority.uid ||
      metadata.gid !== authority.gid ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o7777) !== mode ||
      metadata.size < 2 ||
      metadata.size > maximumBytes ||
      (await realpath(path).catch(() => null)) !== path
    ) {
      fail("CLOUD_RELEASE_CONTROLLER_INVALID");
    }
    buffer = await handle.readFile();
    if (buffer.byteLength !== metadata.size) fail("CLOUD_RELEASE_CONTROLLER_INVALID");
    return Object.freeze({
      buffer: Buffer.from(buffer),
      source: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    });
  } catch (error) {
    if (error?.code?.startsWith?.("CLOUD_RELEASE_")) throw error;
    fail("CLOUD_RELEASE_CONTROLLER_INVALID", error);
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

function parseJson(source, keys, code) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(code, error);
  }
  if (!exactKeys(value, keys) || source !== JSON.stringify(value)) fail(code);
  return value;
}

async function inventory(path, relative = "", authority = { gid: 0, uid: 0 }) {
  const names = (await readdir(path)).sort();
  const files = [];
  for (const name of names) {
    const child = join(path, name);
    const childRelative = relative === "" ? name : `${relative}/${name}`;
    const metadata = await lstat(child);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await assertDirectory(child, 0o700, authority);
      files.push(...(await inventory(child, childRelative, authority)));
    } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
      files.push(childRelative);
    } else {
      fail("CLOUD_RELEASE_CONTROLLER_INVALID");
    }
  }
  return files;
}

function assertMetadata(metadata, digest) {
  if (
    !exactKeys(metadata, METADATA_KEYS) ||
    metadata.schema !== "laundry.cloud-release.controller" ||
    metadata.version !== 1 ||
    !SHA.test(metadata.candidate_sha) ||
    !SHA.test(metadata.expected_sha) ||
    !MIGRATION.test(metadata.migration_head) ||
    !DIGEST.test(metadata.token_sha256) ||
    metadata.controller_sha256 !== digest ||
    !DIGEST.test(metadata.archive_sha256)
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_INVALID");
  }
}

export async function validateControllerDirectory(path, options = {}) {
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const authority = { gid, uid };
  await assertDirectory(path, 0o700, authority);
  const manifestFile = await readPrivate(join(path, "files.json"), 0o600, 128 * 1024, authority);
  const manifest = JSON.parse(manifestFile.source);
  if (
    !Array.isArray(manifest) ||
    manifest.length < 1 ||
    manifestFile.source !== JSON.stringify(manifest)
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_MANIFEST_INVALID");
  }
  let previous = "";
  for (const item of manifest) {
    if (
      !exactKeys(item, ITEM_KEYS) ||
      !CONTROLLER_FILE_PATH.test(item.path) ||
      item.path <= previous ||
      !DIGEST.test(item.sha256) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 1 ||
      item.size > 2 * 1024 * 1024
    ) {
      fail("CLOUD_RELEASE_CONTROLLER_MANIFEST_INVALID");
    }
    previous = item.path;
  }
  if (!manifest.some((item) => item.path === ENTRY)) {
    fail("CLOUD_RELEASE_CONTROLLER_MANIFEST_INVALID");
  }
  const digest = createHash("sha256").update(manifestFile.source, "utf8").digest("hex");
  const metadataFile = await readPrivate(
    join(path, "controller.json"),
    0o600,
    128 * 1024,
    authority,
  );
  const metadata = parseJson(
    metadataFile.source,
    METADATA_KEYS,
    "CLOUD_RELEASE_CONTROLLER_INVALID",
  );
  assertMetadata(metadata, digest);
  if (basename(path) !== `${metadata.candidate_sha}-${metadata.token_sha256}.controller`) {
    fail("CLOUD_RELEASE_CONTROLLER_IDENTITY_MISMATCH");
  }
  const actual = (await inventory(path, "", authority)).sort();
  const expected = ["controller.json", "files.json", ...manifest.map((item) => item.path)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail("CLOUD_RELEASE_CONTROLLER_INVENTORY_INVALID");
  for (const item of manifest) {
    const file = await readPrivate(join(path, item.path), 0o600, 2 * 1024 * 1024, authority);
    if (
      file.buffer.byteLength !== item.size ||
      createHash("sha256").update(file.buffer).digest("hex") !== item.sha256
    ) {
      fail("CLOUD_RELEASE_CONTROLLER_DIGEST_MISMATCH");
    }
    file.buffer.fill(0);
  }
  return Object.freeze({ digest, metadata, path });
}

export async function validateController(request, options = {}) {
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const root = options.root ?? ROOT;
  const authority = { gid, uid };
  if (options.root === undefined) {
    await assertDirectory("/var");
    await assertDirectory("/var/lib");
  }
  await assertDirectory(root, 0o700, authority);
  const controller = await validateControllerDirectory(controllerPath(request, root), {
    gid,
    uid,
  });
  if (
    controller.metadata.candidate_sha !== request.candidate_sha ||
    controller.metadata.expected_sha !== request.expected_sha ||
    controller.metadata.migration_head !== request.migration_head ||
    controller.metadata.token_sha256 !== tokenDigest(request.token)
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_IDENTITY_MISMATCH");
  }
  return controller;
}

function assertIdentity(record, request) {
  if (
    record.candidate_sha !== request.candidate_sha ||
    record.expected_sha !== request.expected_sha ||
    record.migration_head !== request.migration_head ||
    record.token !== request.token
  ) {
    fail("CLOUD_RELEASE_TRANSITION_IDENTITY_MISMATCH");
  }
}

async function readState(path, mode = 0o600) {
  const file = await readPrivate(path, mode);
  try {
    return JSON.parse(file.source);
  } catch (error) {
    fail("CLOUD_RELEASE_TRANSITION_INVALID", error);
  }
}

async function selectEntry(request, controller) {
  const transitionPath = `${STATE}/transition.json`;
  const transition = await readState(transitionPath).catch((error) => {
    if (error?.cause?.code === "ENOENT") return null;
    throw error;
  });
  if (transition === null) {
    const history = await readState(
      `${STATE}/history/${request.candidate_sha}-${request.token}-rolled_back.json`,
    );
    assertIdentity(history, request);
    if (history.outcome !== "rolled_back") fail("CLOUD_RELEASE_ROLLBACK_HISTORY_INVALID");
    return selectRollbackEntry(history, request, controller);
  }
  return selectRollbackEntry(transition, request, controller);
}

export function selectRollbackEntry(record, request, controller) {
  assertIdentity(record, request);
  assertControllerRecord(record, controller);
  if (!ROLLBACK_PHASES.has(record.phase)) fail("CLOUD_RELEASE_CONTROLLER_PHASE_INVALID");
  return join(controller.path, ENTRY);
}

function assertControllerRecord(record, controller) {
  if (
    record.controller_path !== controller.path ||
    record.controller_sha256 !== controller.digest ||
    record.archive_sha256 !== controller.metadata.archive_sha256
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_BINDING_INVALID");
  }
}

async function readInput(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 4096) fail("CLOUD_RELEASE_ROLLBACK_REQUEST_INVALID");
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export async function launchRollback(source, dependencies = {}) {
  const request = parseRequest(source);
  const controller = await (dependencies.validateController ?? validateController)(request);
  const entry = await (dependencies.selectEntry ?? selectEntry)(request, controller);
  const module = await (dependencies.importEntry ?? ((path) => import(pathToFileURL(path).href)))(
    entry,
  );
  if (typeof module.runRollbackRequest !== "function")
    fail("CLOUD_RELEASE_CONTROLLER_ENTRY_INVALID");
  await module.runRollbackRequest(request);
}

async function main() {
  if (process.getuid?.() !== 0) fail("CLOUD_RELEASE_ROOT_REQUIRED");
  await launchRollback(await readInput());
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error?.code?.startsWith?.("CLOUD_RELEASE_") ? error.code : "CLOUD_RELEASE_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
