import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { TextDecoder } from "node:util";

import { fail } from "./hk-vps-release-core.mjs";
import { readPersistedFinalizeEvidence } from "./hk-vps-release-remote-evidence.mjs";
import { HISTORY_ROOT, STATE_ROOT, parseTransition } from "./hk-vps-release-remote-support.mjs";

const HISTORY_NAME = /^([0-9a-f]{40})-([0-9a-f]{32})-(committed|rolled_back)\.json$/u;
const MAX_HISTORY_BYTES = 64 * 1024;

async function assertRoot(path, uid, gid, dependencies) {
  const metadata = await (dependencies.lstat ?? lstat)(path).catch(() => null);
  const canonical =
    metadata === null ? null : await (dependencies.realpath ?? realpath)(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    canonical !== path
  ) {
    fail("CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID");
  }
}

async function readHistory(path, identity, uid, gid, dependencies) {
  let handle;
  let buffer;
  try {
    handle = await (dependencies.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== uid ||
      metadata.gid !== gid ||
      (metadata.mode & 0o7777) !== 0o600 ||
      metadata.size < 2 ||
      metadata.size > MAX_HISTORY_BYTES ||
      (await (dependencies.realpath ?? realpath)(path).catch(() => null)) !== path
    ) {
      fail("CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID");
    }
    buffer = await handle.readFile();
    if (buffer.byteLength !== metadata.size) fail("CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const record = parseTransition(JSON.parse(source));
    if (
      source !== `${JSON.stringify(record)}\n` ||
      record.candidate_sha !== identity.candidateSha ||
      record.token !== identity.token ||
      record.outcome !== identity.outcome
    ) {
      fail("CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID");
    }
    return record;
  } catch (error) {
    if (error?.code?.startsWith?.("CLOUD_RELEASE_")) throw error;
    fail("CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID", error);
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

export async function assertRetainedFinalizeEvidence(dependencies = {}) {
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const stateRoot = dependencies.stateRoot ?? STATE_ROOT;
  const historyRoot = dependencies.historyRoot ?? HISTORY_ROOT;
  await assertRoot(stateRoot, uid, gid, dependencies);
  await assertRoot(historyRoot, uid, gid, dependencies);
  const names = await (dependencies.readdir ?? readdir)(historyRoot);
  const evidenceNames = new Set();
  for (const name of names) {
    const match = HISTORY_NAME.exec(name);
    if (match === null) fail("CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID");
    const record = await readHistory(
      join(historyRoot, name),
      { candidateSha: match[1], outcome: match[3], token: match[2] },
      uid,
      gid,
      dependencies,
    );
    if (record.verification_evidence_path === null) continue;
    const evidenceName = basename(record.verification_evidence_path);
    if (evidenceNames.has(evidenceName)) fail("CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID");
    evidenceNames.add(evidenceName);
    await (dependencies.readEvidence ?? readPersistedFinalizeEvidence)(record, {
      allowStale: true,
      gid,
      root: stateRoot,
      uid,
    });
  }
  const stateNames = (await (dependencies.readdir ?? readdir)(stateRoot)).sort();
  const expected = [basename(historyRoot), ...evidenceNames].sort();
  if (
    stateNames.length !== expected.length ||
    stateNames.some((name, index) => name !== expected[index])
  ) {
    fail("CLOUD_RELEASE_EVIDENCE_RETENTION_INVALID");
  }
}
