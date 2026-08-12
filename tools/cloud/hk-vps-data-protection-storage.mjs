import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  DATA_PROTECTION_MAX_SETS,
  DATA_PROTECTION_ROOT,
  DATA_PROTECTION_SET_ROOT,
  requireDataProtectionSetId,
} from "./hk-vps-data-protection-contract.mjs";
import {
  ensureDataProtectionRoots,
  verifyDataProtectionSet,
} from "./hk-vps-data-protection-files.mjs";
import { fail } from "./hk-vps-release-core.mjs";

const STAGING = /^\.set-([0-9a-f]{32})\.tmp$/u;

function missing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

async function assertStaging(path, root, identity, operationId) {
  const expected = join(root, `.set-${operationId}.tmp`);
  const metadata = await lstat(path).catch(() => null);
  if (
    path !== expected ||
    !STAGING.test(path.split("/").at(-1) ?? "") ||
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    (await realpath(path).catch(() => null)) !== path
  ) {
    fail("CLOUD_DATA_STAGING_INVALID");
  }
}

export async function inspectRetainedDataProtectionSets(options = {}) {
  const roots = await (options.ensureRoots ?? ensureDataProtectionRoots)(options);
  const identity = options.identity ?? Object.freeze({ uid: 0, gid: 0 });
  const names = (await (options.readdir ?? readdir)(roots.setRoot)).sort();
  const maximum = options.maximumSets ?? DATA_PROTECTION_MAX_SETS;
  if (names.length > maximum || (options.reserveSlot !== false && names.length === maximum)) {
    fail("CLOUD_DATA_RETENTION_LIMIT");
  }
  const sets = [];
  for (const name of names) {
    requireDataProtectionSetId(name);
    sets.push(
      await (options.verifySet ?? verifyDataProtectionSet)(join(roots.setRoot, name), { identity }),
    );
  }
  return Object.freeze({ ...roots, sets: Object.freeze(sets) });
}

export async function prepareDataProtectionStaging(operationId, options = {}) {
  if (typeof operationId !== "string" || !/^[0-9a-f]{32}$/u.test(operationId)) {
    fail("CLOUD_DATA_OPERATION_INVALID");
  }
  const retained = await inspectRetainedDataProtectionSets(options);
  const stagingPath = join(retained.root, `.set-${operationId}.tmp`);
  try {
    await (options.mkdir ?? mkdir)(stagingPath, { mode: 0o700 });
  } catch (error) {
    fail("CLOUD_DATA_STAGING_CREATE_FAILED", error);
  }
  await assertStaging(
    stagingPath,
    retained.root,
    options.identity ?? Object.freeze({ uid: 0, gid: 0 }),
    operationId,
  );
  return Object.freeze({ ...retained, stagingPath });
}

export async function cleanupDataProtectionStaging(path, operationId, options = {}) {
  const root = options.root ?? DATA_PROTECTION_ROOT;
  const identity = options.identity ?? Object.freeze({ uid: 0, gid: 0 });
  let metadata;
  try {
    metadata = await (options.lstat ?? lstat)(path);
  } catch (error) {
    if (missing(error)) return false;
    fail("CLOUD_DATA_STAGING_INVALID", error);
  }
  if (metadata !== null) await assertStaging(path, root, identity, operationId);
  try {
    await (options.rm ?? rm)(path, { force: true, recursive: true });
  } catch (error) {
    fail("CLOUD_DATA_STAGING_CLEANUP_FAILED", error);
  }
  return true;
}

export function defaultDataProtectionStorageOptions() {
  return Object.freeze({ root: DATA_PROTECTION_ROOT, setRoot: DATA_PROTECTION_SET_ROOT });
}
