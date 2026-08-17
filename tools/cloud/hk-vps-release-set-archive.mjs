import { constants } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";

import { assertDataProtectionLockHeld } from "./hk-vps-data-protection-lock.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import {
  assertActiveReleaseSetIntegrity,
  assertNoReleaseTransition,
  listReleaseSetCandidates,
  selectReleaseSet,
} from "./hk-vps-release-set-inventory.mjs";
import { verifyReleaseSetItem } from "./hk-vps-release-set-item.mjs";
import {
  createReleaseSetManifest,
  readReleaseSetManifest,
  releaseSetManifestExists,
  releaseSetParent,
} from "./hk-vps-release-set-manifest.mjs";

const CODE = "CLOUD_RELEASE_SET_ARCHIVE_INVALID";

function use(dependencies, name, fallback) {
  return dependencies[name] ?? fallback;
}

function isMissing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

async function assertAuthority(dependencies) {
  if ((dependencies.processUid ?? process.getuid?.()) !== 0) {
    fail("CLOUD_RELEASE_SET_ROOT_REQUIRED");
  }
  await use(dependencies, "assertLockHeld", assertDataProtectionLockHeld)();
  await assertNoReleaseTransition(dependencies);
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

async function itemPosition(item, record, dependencies) {
  const source = await use(
    dependencies,
    "lstat",
    lstat,
  )(item.source).catch((error) => {
    if (isMissing(error)) return null;
    return fail(CODE, error);
  });
  const target = await use(
    dependencies,
    "lstat",
    lstat,
  )(item.target).catch((error) => {
    if (isMissing(error)) return null;
    return fail(CODE, error);
  });
  if ((source === null) === (target === null)) fail(CODE);
  const position = source === null ? "archive" : "active";
  await verifyReleaseSetItem(
    item,
    record,
    position === "active" ? item.source : item.target,
    dependencies,
  );
  return position;
}

async function positions(bundle, dependencies) {
  const result = [];
  for (const item of bundle.manifest.items) {
    result.push(await itemPosition(item, bundle.manifest.record, dependencies));
  }
  return result;
}

async function assertActiveRecord(identity, record, dependencies) {
  const selected = await selectReleaseSet(identity, dependencies);
  if (JSON.stringify(selected.record) !== JSON.stringify(record)) fail(CODE);
}

async function loadArchiveBundle(identity, dependencies) {
  if (!(await releaseSetManifestExists(identity, dependencies))) {
    const entry = await selectReleaseSet(identity, dependencies);
    await createReleaseSetManifest(identity, entry, dependencies);
  }
  return await readReleaseSetManifest(identity, dependencies);
}

async function moveItem(item, direction, index, dependencies) {
  const source = direction === "archive" ? item.source : item.target;
  const target = direction === "archive" ? item.target : item.source;
  await use(dependencies, "rename", rename)(source, target).catch((error) => fail(CODE, error));
  const sync = use(dependencies, "syncDirectory", syncDirectory);
  await sync(releaseSetParent(source), dependencies);
  await sync(releaseSetParent(target), dependencies);
  await use(
    dependencies,
    "afterMove",
    async () => undefined,
  )(Object.freeze({ direction, index, item }));
}

async function moveReleaseSet(identity, direction, dependencies) {
  await assertAuthority(dependencies);
  const bundle =
    direction === "archive"
      ? await loadArchiveBundle(identity, dependencies)
      : await readReleaseSetManifest(identity, dependencies);
  const initial = await positions(bundle, dependencies);
  if (direction === "archive" && initial.every((position) => position === "active")) {
    await assertActiveRecord(identity, bundle.manifest.record, dependencies);
  }
  for (const [index, item] of bundle.manifest.items.entries()) {
    const desired = direction === "archive" ? "archive" : "active";
    if ((await itemPosition(item, bundle.manifest.record, dependencies)) !== desired) {
      await moveItem(item, direction, index, dependencies);
    }
  }
  const final = await positions(bundle, dependencies);
  const desired = direction === "archive" ? "archive" : "active";
  if (final.some((position) => position !== desired)) fail(CODE);
  await assertActiveReleaseSetIntegrity(dependencies);
  return Object.freeze({
    candidateSha: identity.candidateSha,
    itemCount: bundle.manifest.items.length,
    outcome: identity.outcome,
    state: direction === "archive" ? "archived" : "restored",
    tokenSha256: identity.tokenSha256,
  });
}

export async function archiveReleaseSet(identity, dependencies = {}) {
  return await moveReleaseSet(identity, "archive", dependencies);
}

export async function restoreReleaseSet(identity, dependencies = {}) {
  return await moveReleaseSet(identity, "restore", dependencies);
}

export async function listArchivableReleaseSets(dependencies = {}) {
  await assertAuthority(dependencies);
  return await listReleaseSetCandidates(dependencies);
}
