import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";

import {
  assertAdr36ApiAcceptancePassed,
  parseAdr36ApiAcceptanceEvidence,
} from "./adr36-web-acceptance-evidence.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import { loadRemoteAcceptanceEnvironment } from "./hk-vps-release-acceptance-secrets.mjs";
import {
  FINALIZE_EVIDENCE_MAX_BYTES,
  canonicalFinalizeEvidence,
  parseCanonicalFinalizeEvidence,
  parseRetainedFinalizeEvidence,
  parseSingleJsonLine,
  releaseTokenDigest,
  verificationEvidencePath,
} from "./hk-vps-release-finalize-evidence.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";

const NODE = "/opt/nodejs/bin/node";
const LIVE_ROOT = "/opt/laundry-desk";
const API_ENTRY = `${LIVE_ROOT}/tools/cloud/adr36-web-acceptance.mjs`;
const API_MAXIMUM_OUTPUT_BYTES = 64 * 1024;

function binding(record) {
  return Object.freeze({
    candidateSha: record.candidate_sha,
    expectedSha: record.expected_sha,
    migrationHead: record.migration_head,
    token: record.token,
  });
}

export async function runRemoteApiAcceptance(signal, dependencies = {}) {
  const environment = await (dependencies.loadEnvironment ?? loadRemoteAcceptanceEnvironment)();
  const result = await (dependencies.runCommand ?? runCloudCommand)(
    NODE,
    [API_ENTRY, "--machine-json"],
    Object.freeze({
      accepting: Object.freeze([0, 1, 2]),
      cwd: LIVE_ROOT,
      environment,
      label: "CLOUD_RELEASE_API_EVIDENCE",
      maximumOutputBytes: API_MAXIMUM_OUTPUT_BYTES,
      signal,
      timeoutMs: 20 * 60_000,
    }),
  );
  if (result.stderr !== "") fail("CLOUD_RELEASE_API_EVIDENCE_OUTPUT_INVALID");
  let evidence;
  try {
    const line = parseSingleJsonLine(
      result.stdout,
      API_MAXIMUM_OUTPUT_BYTES,
      "CLOUD_RELEASE_API_EVIDENCE_OUTPUT_INVALID",
    );
    evidence = assertAdr36ApiAcceptancePassed(parseAdr36ApiAcceptanceEvidence(line));
  } catch (error) {
    fail("CLOUD_RELEASE_API_EVIDENCE_NOT_PASSED", error);
  }
  if (result.code !== 0) fail("CLOUD_RELEASE_API_EVIDENCE_NOT_PASSED");
  return evidence;
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requirePrivateMetadata(metadata, uid, gid, size, code) {
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== 0o600 ||
    metadata.size < 1 ||
    metadata.size > FINALIZE_EVIDENCE_MAX_BYTES ||
    metadata.size !== size
  ) {
    fail(code);
  }
}

async function assertPrivateRoot(path, uid, gid) {
  const metadata = await lstat(path).catch(() => null);
  const canonical = metadata === null ? null : await realpath(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    canonical !== path
  ) {
    fail("CLOUD_RELEASE_EVIDENCE_ROOT_INVALID");
  }
}

async function assertReplaceable(path, uid, gid) {
  const metadata = await lstat(path).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return;
  const canonical = await realpath(path).catch(() => null);
  requirePrivateMetadata(metadata, uid, gid, metadata.size, "CLOUD_RELEASE_EVIDENCE_FILE_INVALID");
  if (canonical !== path) fail("CLOUD_RELEASE_EVIDENCE_FILE_INVALID");
}

async function readDiscoveredEvidence(path, uid, gid) {
  let handle;
  let buffer;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    requirePrivateMetadata(
      metadata,
      uid,
      gid,
      metadata.size,
      "CLOUD_RELEASE_EVIDENCE_FILE_INVALID",
    );
    const current = await lstat(path);
    if (
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      current.nlink !== 1 ||
      (await realpath(path).catch(() => null)) !== path
    ) {
      fail("CLOUD_RELEASE_EVIDENCE_FILE_INVALID");
    }
    buffer = await handle.readFile();
    if (buffer.byteLength !== metadata.size) fail("CLOUD_RELEASE_EVIDENCE_FILE_INVALID");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    if (error?.code?.startsWith?.("CLOUD_RELEASE_")) throw error;
    fail("CLOUD_RELEASE_EVIDENCE_FILE_INVALID", error);
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

export async function discoverUnboundFinalizeEvidence(record, options = {}) {
  if (
    record.verification_evidence_path !== null ||
    record.verification_evidence_sha256 !== null ||
    ![null, false].includes(record.verification_evidence_authoritative)
  ) {
    fail("CLOUD_RELEASE_EVIDENCE_BINDING_INVALID");
  }
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const expectedPath = verificationEvidencePath(
    record.candidate_sha,
    releaseTokenDigest(record.token),
  );
  const root = options.root ?? dirname(expectedPath);
  const path = options.root === undefined ? expectedPath : join(root, basename(expectedPath));
  await assertPrivateRoot(root, uid, gid);
  const metadata = await lstat(path).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return null;
  const source = await readDiscoveredEvidence(path, uid, gid);
  const evidence = parseRetainedFinalizeEvidence(source, binding(record));
  return Object.freeze({
    digest: createHash("sha256").update(source, "utf8").digest("hex"),
    evidence,
    path: expectedPath,
  });
}

export async function persistFinalizeEvidence(record, evidence, options = {}) {
  const now = options.now ?? new Date();
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const root =
    options.root ?? dirname(verificationEvidencePath(record.candidate_sha, "0".repeat(64)));
  const canonical = canonicalFinalizeEvidence(evidence, binding(record), now);
  if (Buffer.byteLength(canonical, "utf8") > FINALIZE_EVIDENCE_MAX_BYTES) {
    fail("CLOUD_RELEASE_EVIDENCE_JSON_INVALID");
  }
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  const defaultPath = verificationEvidencePath(record.candidate_sha, evidence.token_sha256);
  const path = options.root === undefined ? defaultPath : join(root, basename(defaultPath));
  const temporary = join(root, `.verification-${randomBytes(16).toString("hex")}.tmp`);
  await assertPrivateRoot(root, uid, gid);
  await assertReplaceable(path, uid, gid);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(canonical, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(root);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    fail("CLOUD_RELEASE_EVIDENCE_WRITE_FAILED", error);
  }
  const metadata = await lstat(path).catch(() => null);
  requirePrivateMetadata(
    metadata,
    uid,
    gid,
    Buffer.byteLength(canonical, "utf8"),
    "CLOUD_RELEASE_EVIDENCE_FILE_INVALID",
  );
  return Object.freeze({ digest, path: defaultPath });
}

export async function readPersistedFinalizeEvidence(record, options = {}) {
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  if (
    typeof record.verification_evidence_path !== "string" ||
    typeof record.verification_evidence_sha256 !== "string"
  ) {
    fail("CLOUD_RELEASE_EVIDENCE_REQUIRED");
  }
  const expectedPath = verificationEvidencePath(
    record.candidate_sha,
    releaseTokenDigest(record.token),
  );
  const path =
    options.root === undefined ? expectedPath : join(options.root, basename(expectedPath));
  if (record.verification_evidence_path !== expectedPath) {
    fail("CLOUD_RELEASE_EVIDENCE_PATH_INVALID");
  }
  await assertPrivateRoot(dirname(path), uid, gid);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (metadata.size < 1 || metadata.size > FINALIZE_EVIDENCE_MAX_BYTES) {
      fail("CLOUD_RELEASE_EVIDENCE_FILE_INVALID");
    }
    requirePrivateMetadata(
      metadata,
      uid,
      gid,
      metadata.size,
      "CLOUD_RELEASE_EVIDENCE_FILE_INVALID",
    );
    const source = await handle.readFile("utf8");
    const digest = createHash("sha256").update(source, "utf8").digest("hex");
    if (digest !== record.verification_evidence_sha256) {
      fail("CLOUD_RELEASE_EVIDENCE_DIGEST_MISMATCH");
    }
    return options.allowStale === true
      ? parseRetainedFinalizeEvidence(source, binding(record))
      : parseCanonicalFinalizeEvidence(source, binding(record), options.now ?? new Date());
  } catch (error) {
    if (error?.code?.startsWith?.("CLOUD_RELEASE_")) throw error;
    fail("CLOUD_RELEASE_EVIDENCE_FILE_INVALID", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBoundedEvidenceInput(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > FINALIZE_EVIDENCE_MAX_BYTES) fail("CLOUD_RELEASE_EVIDENCE_JSON_INVALID");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
