import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { fail, requireSha } from "./hk-vps-release-core.mjs";
import { STATE_ROOT } from "./hk-vps-release-remote-support.mjs";

const BUNDLE = /^\.migration-([0-9a-f]{40})-([A-Za-z0-9]{6})$/u;
const TOMBSTONE = /^\.migration-tombstone-([0-9a-f]{40})-([A-Za-z0-9]{6})$/u;
const MIGRATION_FILE = /^packages\/db\/src\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u;
const ALLOWED_DIRECTORIES = new Set([
  "packages",
  "packages/db",
  "packages/db/src",
  "packages/db/src/migrations",
  "tools",
  "tools/compose",
]);
const MAXIMUM_ENTRIES = 300;
const MAXIMUM_FILE_BYTES = 2 * 1024 * 1024;

function parseName(name) {
  const active = BUNDLE.exec(name);
  if (active !== null) {
    return Object.freeze({ candidate: active[1], kind: "bundle", suffix: active[2] });
  }
  const tombstone = TOMBSTONE.exec(name);
  if (tombstone !== null) {
    return Object.freeze({ candidate: tombstone[1], kind: "tombstone", suffix: tombstone[2] });
  }
  return null;
}

function cleanupDependencies(input = {}) {
  return Object.freeze({
    gid: input.gid ?? 0,
    lstat: input.lstat ?? lstat,
    open: input.open ?? open,
    readdir: input.readdir ?? readdir,
    realpath: input.realpath ?? realpath,
    rename: input.rename ?? rename,
    rm: input.rm ?? rm,
    stateRoot: input.stateRoot ?? STATE_ROOT,
    uid: input.uid ?? 0,
  });
}

async function syncDirectory(path, dependencies) {
  const handle = await dependencies.open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertStateRoot(dependencies) {
  const metadata = await dependencies.lstat(dependencies.stateRoot).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== dependencies.uid ||
    metadata.gid !== dependencies.gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    (await dependencies.realpath(dependencies.stateRoot).catch(() => null)) !==
      dependencies.stateRoot
  ) {
    fail("CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID");
  }
  return metadata;
}

function isAllowedFile(relative) {
  return relative === "tools/compose/migrate-v2.sh" || MIGRATION_FILE.test(relative);
}

async function assertEntry(path, relative, rootDevice, dependencies) {
  const metadata = await dependencies.lstat(path).catch(() => null);
  const canonical = metadata === null ? null : await dependencies.realpath(path).catch(() => null);
  const common =
    metadata !== null &&
    !metadata.isSymbolicLink() &&
    metadata.uid === dependencies.uid &&
    metadata.gid === dependencies.gid &&
    metadata.dev === rootDevice &&
    (metadata.mode & 0o022) === 0 &&
    canonical === path;
  if (metadata?.isDirectory()) {
    if (!common || !ALLOWED_DIRECTORIES.has(relative)) {
      fail("CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID");
    }
    return "directory";
  }
  if (
    !common ||
    !metadata?.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size < 0 ||
    metadata.size > MAXIMUM_FILE_BYTES ||
    !isAllowedFile(relative)
  ) {
    fail("CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID");
  }
  return "file";
}

async function assertTree(root, stateDevice, dependencies) {
  const metadata = await dependencies.lstat(root).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== dependencies.uid ||
    metadata.gid !== dependencies.gid ||
    metadata.dev !== stateDevice ||
    (metadata.mode & 0o7777) !== 0o700 ||
    (await dependencies.realpath(root).catch(() => null)) !== root
  ) {
    fail("CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID");
  }
  const pending = [Object.freeze({ path: root, relative: "" })];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const names = await dependencies.readdir(current.path);
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      fail("CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID");
    }
    for (const name of names.sort()) {
      count += 1;
      if (count > MAXIMUM_ENTRIES || name.includes("/") || name === "." || name === "..") {
        fail("CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID");
      }
      const relative = current.relative === "" ? name : `${current.relative}/${name}`;
      const path = join(current.path, name);
      if ((await assertEntry(path, relative, stateDevice, dependencies)) === "directory") {
        pending.push(Object.freeze({ path, relative }));
      }
    }
  }
}

async function removeValidatedBundle(name, identity, stateDevice, dependencies) {
  const source = join(dependencies.stateRoot, name);
  await assertTree(source, stateDevice, dependencies);
  if (identity.kind === "tombstone") {
    await dependencies.rm(source, { force: false, recursive: true });
    await syncDirectory(dependencies.stateRoot, dependencies);
    return;
  }
  const tombstoneName = `.migration-tombstone-${identity.candidate}-${identity.suffix}`;
  const tombstone = join(dependencies.stateRoot, tombstoneName);
  const collision = await dependencies.lstat(tombstone).catch((error) => {
    if (error instanceof Error && error.code === "ENOENT") return null;
    throw error;
  });
  if (collision !== null) fail("CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID");
  await dependencies.rename(source, tombstone);
  await syncDirectory(dependencies.stateRoot, dependencies);
  await dependencies.rm(tombstone, { force: false, recursive: true });
  await syncDirectory(dependencies.stateRoot, dependencies);
}

export async function cleanupStaleMigrationBundles(candidateSha, inputDependencies = {}) {
  const dependencies = cleanupDependencies(inputDependencies);
  const candidate = candidateSha === undefined ? undefined : requireSha(candidateSha);
  const state = await assertStateRoot(dependencies);
  const names = (await dependencies.readdir(dependencies.stateRoot)).sort();
  const selected = [];
  for (const name of names) {
    const relevant =
      candidate === undefined
        ? name.startsWith(".migration-")
        : name.startsWith(`.migration-${candidate}-`) ||
          name.startsWith(`.migration-tombstone-${candidate}-`);
    if (!relevant) continue;
    const identity = parseName(name);
    if (identity === null || (candidate !== undefined && identity.candidate !== candidate)) {
      fail("CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID");
    }
    selected.push(Object.freeze({ identity, name }));
  }
  selected.sort((left, right) => {
    const leftOrder = left.identity.kind === "tombstone" ? 0 : 1;
    const rightOrder = right.identity.kind === "tombstone" ? 0 : 1;
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
  for (const item of selected) {
    await removeValidatedBundle(item.name, item.identity, state.dev, dependencies);
  }
  return selected.length;
}
