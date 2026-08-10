import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

import { fail } from "./hk-vps-release-core.mjs";
import { readPrivateFile } from "./hk-vps-release-private-file.mjs";
import { verifyBackupEvidence } from "./hk-vps-release-remote-db.mjs";
import {
  BACKUP_ROOT,
  HISTORY_ROOT,
  backupManifestPath,
  parseTransition,
} from "./hk-vps-release-remote-support.mjs";

const HISTORY_NAME = /^([0-9a-f]{40})-([0-9a-f]{32})-(committed|rolled_back)\.json$/u;
const MAX_RETAINED_BACKUPS = 8;

function isMissing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

async function historyRecords(dependencies) {
  const historyRoot = dependencies.historyRoot ?? HISTORY_ROOT;
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const names = (await (dependencies.readdir ?? readdir)(historyRoot)).sort();
  const records = [];
  for (const name of names) {
    const match = HISTORY_NAME.exec(name);
    if (match === null) fail("CLOUD_RELEASE_BACKUP_RETENTION_INVALID");
    const source = await (dependencies.readHistory ?? readPrivateFile)(join(historyRoot, name), {
      code: "CLOUD_RELEASE_BACKUP_RETENTION_INVALID",
      gid,
      maximumBytes: 64 * 1024,
      uid,
    });
    let record;
    try {
      record = parseTransition(JSON.parse(source));
    } catch (error) {
      fail("CLOUD_RELEASE_BACKUP_RETENTION_INVALID", error);
    }
    if (
      source !== `${JSON.stringify(record)}\n` ||
      record.candidate_sha !== match[1] ||
      record.token !== match[2] ||
      record.outcome !== match[3]
    ) {
      fail("CLOUD_RELEASE_BACKUP_RETENTION_INVALID");
    }
    records.push(record);
  }
  return Object.freeze(records);
}

async function assertBackupRoot(path, postgresGid, allowMissing, dependencies) {
  const metadata = await (dependencies.lstat ?? lstat)(path).catch((error) => {
    if (allowMissing && isMissing(error)) return null;
    fail("CLOUD_RELEASE_BACKUP_RETENTION_INVALID", error);
  });
  if (metadata === null) return false;
  const canonical = await (dependencies.realpath ?? realpath)(path).catch(() => null);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== postgresGid ||
    (metadata.mode & 0o7777) !== 0o710 ||
    canonical !== path
  ) {
    fail("CLOUD_RELEASE_BACKUP_RETENTION_INVALID");
  }
  return true;
}

function expectedBackupRecords(records, backupRoot) {
  const expected = new Map();
  for (const record of records) {
    if (record.backup_path === null) continue;
    const manifestPath = backupManifestPath(record.backup_path);
    if (!record.backup_path.startsWith(`${backupRoot}/`)) {
      fail("CLOUD_RELEASE_BACKUP_RETENTION_INVALID");
    }
    const name = basename(record.backup_path);
    if (expected.has(name)) fail("CLOUD_RELEASE_BACKUP_RETENTION_INVALID");
    expected.set(name, record);
    expected.set(basename(manifestPath), record);
  }
  if (expected.size / 2 >= MAX_RETAINED_BACKUPS) {
    fail("CLOUD_RELEASE_BACKUP_RETENTION_LIMIT");
  }
  return expected;
}

export async function assertRetainedBackups(dependencies = {}) {
  const backupRoot = dependencies.backupRoot ?? BACKUP_ROOT;
  const postgresGid = dependencies.postgresGid;
  if (!Number.isSafeInteger(postgresGid) || postgresGid < 0) {
    fail("CLOUD_RELEASE_POSTGRES_IDENTITY_INVALID");
  }
  const records = await (dependencies.records ?? historyRecords)(dependencies);
  const expected = expectedBackupRecords(records, backupRoot);
  const exists = await assertBackupRoot(backupRoot, postgresGid, expected.size === 0, dependencies);
  if (!exists) return;
  const names = (await (dependencies.readdir ?? readdir)(backupRoot)).sort();
  const expectedNames = [...expected.keys()].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    fail("CLOUD_RELEASE_BACKUP_RETENTION_INVALID");
  }
  const verify = dependencies.verifyBackupEvidence ?? verifyBackupEvidence;
  for (const [name, record] of expected) {
    if (name.endsWith(".json")) continue;
    await verify(record);
  }
}
