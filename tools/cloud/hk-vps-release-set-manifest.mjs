import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fail } from "./hk-vps-release-core.mjs";
import { releaseTokenDigest } from "./hk-vps-release-finalize-evidence.mjs";
import { readPrivateFile, writeOrVerifyPrivateFile } from "./hk-vps-release-private-file.mjs";
import { parseTransition } from "./hk-vps-release-remote-support.mjs";
import { releaseSetRoots } from "./hk-vps-release-set-inventory.mjs";
import {
  captureReleaseSetItem,
  releaseHistoryDigest,
  releaseSetItemSpecifications,
} from "./hk-vps-release-set-item.mjs";

export const RELEASE_SET_MANIFEST = "manifest.json";

const CODE = "CLOUD_RELEASE_SET_ARCHIVE_INVALID";
const MISMATCH = "CLOUD_RELEASE_SET_MANIFEST_MISMATCH";
const SCHEMA = "laundry.cloud-release.archive-set";
const VERSION = 1;
const DIGEST = /^[0-9a-f]{64}$/u;
const INTEGER = /^(?:0|[1-9]\d*)$/u;
const FOLDERS = Object.freeze(["controller", "backups", "evidence", "history"]);
const MANIFEST_KEYS = Object.freeze([
  "schema",
  "version",
  "created_at",
  "identity",
  "record_sha256",
  "record",
  "items",
]);
const IDENTITY_KEYS = Object.freeze(["candidate_sha", "token_sha256", "outcome"]);
const ITEM_KEYS = Object.freeze([
  "kind",
  "type",
  "source",
  "target",
  "sha256",
  "dev",
  "ino",
  "uid",
  "gid",
  "mode",
  "size",
]);

function use(dependencies, name, fallback) {
  return dependencies[name] ?? fallback;
}

function exactKeys(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isMissing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

async function syncDirectory(path, dependencies) {
  const handle = await use(
    dependencies,
    "open",
    open,
  )(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertDirectory(path, dependencies) {
  const uid = dependencies.uid ?? 0;
  const gid = dependencies.gid ?? 0;
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(path).catch((error) => fail(CODE, error));
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    (await use(dependencies, "realpath", realpath)(path).catch(() => null)) !== path
  ) {
    fail(CODE);
  }
  return metadata;
}

async function ensureDirectory(path, parent, dependencies) {
  let created = false;
  try {
    await use(dependencies, "mkdir", mkdir)(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") fail(CODE, error);
  }
  await assertDirectory(path, dependencies);
  if (created) await use(dependencies, "syncDirectory", syncDirectory)(parent, dependencies);
}

function requireIdentity(identity) {
  if (
    typeof identity !== "object" ||
    identity === null ||
    !/^[0-9a-f]{40}$/u.test(identity.candidateSha) ||
    !DIGEST.test(identity.tokenSha256) ||
    !["committed", "rolled_back"].includes(identity.outcome)
  ) {
    fail(CODE);
  }
  return identity;
}

export function releaseSetLocation(identity, dependencies = {}) {
  const valid = requireIdentity(identity);
  const roots = releaseSetRoots(dependencies);
  const name = `${valid.candidateSha}-${valid.tokenSha256}-${valid.outcome}`;
  const directory = join(roots.setRoot, name);
  return Object.freeze({
    ...roots,
    directory,
    manifestPath: join(directory, RELEASE_SET_MANIFEST),
    name,
  });
}

async function assertLayout(location, dependencies) {
  await assertDirectory(location.archiveRoot, dependencies);
  await assertDirectory(location.setRoot, dependencies);
  await assertDirectory(location.directory, dependencies);
  for (const folder of FOLDERS)
    await assertDirectory(join(location.directory, folder), dependencies);
}

async function prepareLayout(location, dependencies) {
  await assertDirectory(location.archiveRoot, dependencies);
  await ensureDirectory(location.setRoot, location.archiveRoot, dependencies);
  await ensureDirectory(location.directory, location.setRoot, dependencies);
  for (const folder of FOLDERS) {
    await ensureDirectory(join(location.directory, folder), location.directory, dependencies);
  }
}

export async function releaseSetManifestExists(identity, dependencies = {}) {
  const { manifestPath } = releaseSetLocation(identity, dependencies);
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(manifestPath).catch((error) => {
    if (isMissing(error)) return null;
    return fail(CODE, error);
  });
  return metadata !== null;
}

async function assertAbsent(path, dependencies) {
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(path).catch((error) => {
    if (isMissing(error)) return null;
    return fail(CODE, error);
  });
  if (metadata !== null) fail(CODE);
}

export async function createReleaseSetManifest(identity, entry, dependencies = {}) {
  const location = releaseSetLocation(identity, dependencies);
  await prepareLayout(location, dependencies);
  await assertAbsent(location.manifestPath, dependencies);
  const archive = await assertDirectory(location.archiveRoot, dependencies);
  const items = [];
  for (const specification of releaseSetItemSpecifications(entry, location)) {
    items.push(await captureReleaseSetItem(specification, archive.dev, entry.record, dependencies));
  }
  const manifest = Object.freeze({
    schema: SCHEMA,
    version: VERSION,
    created_at: (dependencies.now ?? new Date()).toISOString(),
    identity: Object.freeze({
      candidate_sha: identity.candidateSha,
      token_sha256: identity.tokenSha256,
      outcome: identity.outcome,
    }),
    record_sha256: releaseHistoryDigest(entry.record),
    record: entry.record,
    items: Object.freeze(items),
  });
  const source = `${JSON.stringify(manifest)}\n`;
  await use(dependencies, "writeManifest", writeOrVerifyPrivateFile)(
    location.manifestPath,
    source,
    {
      code: CODE,
      gid: dependencies.gid ?? 0,
      maximumBytes: 256 * 1024,
      mismatchCode: MISMATCH,
      uid: dependencies.uid ?? 0,
    },
  );
  return Object.freeze({ location, manifest });
}

function parseItem(value, specification, authority) {
  if (
    !exactKeys(value, ITEM_KEYS) ||
    value.kind !== specification.kind ||
    value.type !== specification.type ||
    value.source !== specification.source ||
    value.target !== specification.target ||
    !DIGEST.test(value.sha256) ||
    (specification.digest !== null && value.sha256 !== specification.digest) ||
    !INTEGER.test(value.dev) ||
    !INTEGER.test(value.ino) ||
    value.uid !== authority.uid ||
    value.gid !== authority.gid ||
    value.mode !== (value.type === "directory" ? 0o700 : 0o600) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  ) {
    fail(CODE);
  }
  return Object.freeze({ ...value });
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function parseReleaseSetManifest(source, identity, dependencies = {}) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(CODE, error);
  }
  const location = releaseSetLocation(identity, dependencies);
  if (
    !exactKeys(value, MANIFEST_KEYS) ||
    value.schema !== SCHEMA ||
    value.version !== VERSION ||
    !exactKeys(value.identity, IDENTITY_KEYS) ||
    value.identity.candidate_sha !== identity.candidateSha ||
    value.identity.token_sha256 !== identity.tokenSha256 ||
    value.identity.outcome !== identity.outcome ||
    !isCanonicalTimestamp(value.created_at) ||
    !DIGEST.test(value.record_sha256) ||
    !Array.isArray(value.items)
  ) {
    fail(CODE);
  }
  let record;
  try {
    record = parseTransition(value.record);
  } catch (error) {
    fail(CODE, error);
  }
  if (
    record.candidate_sha !== identity.candidateSha ||
    record.outcome !== identity.outcome ||
    releaseTokenDigest(record.token) !== identity.tokenSha256 ||
    releaseHistoryDigest(record) !== value.record_sha256
  ) {
    fail(CODE);
  }
  const entry = Object.freeze({
    name: `${record.candidate_sha}-${record.token}-${record.outcome}.json`,
    record,
  });
  const specifications = releaseSetItemSpecifications(entry, location);
  if (value.items.length !== specifications.length) fail(CODE);
  const authority = { gid: dependencies.gid ?? 0, uid: dependencies.uid ?? 0 };
  const items = Object.freeze(
    value.items.map((item, index) => parseItem(item, specifications[index], authority)),
  );
  const manifest = Object.freeze({
    schema: SCHEMA,
    version: VERSION,
    created_at: value.created_at,
    identity: Object.freeze({ ...value.identity }),
    record_sha256: value.record_sha256,
    record,
    items,
  });
  if (source !== `${JSON.stringify(manifest)}\n`) fail(CODE);
  return Object.freeze({ location, manifest });
}

export async function readReleaseSetManifest(identity, dependencies = {}) {
  const location = releaseSetLocation(identity, dependencies);
  await assertLayout(location, dependencies);
  const source = await use(
    dependencies,
    "readManifest",
    readPrivateFile,
  )(location.manifestPath, {
    code: CODE,
    gid: dependencies.gid ?? 0,
    maximumBytes: 256 * 1024,
    uid: dependencies.uid ?? 0,
  });
  return parseReleaseSetManifest(source, identity, dependencies);
}

export function releaseSetParent(path) {
  return dirname(path);
}
