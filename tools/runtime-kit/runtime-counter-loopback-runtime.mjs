import { constants as fileConstants } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { RuntimeCounterAcceptanceError, fail } from "./runtime-counter-loopback-core.mjs";

const LEASE_MODE = 0o600n;

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertLeaseMetadata(ownerMetadata, pathMetadata) {
  if (
    !ownerMetadata.isFile() ||
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    ownerMetadata.nlink !== 1n ||
    pathMetadata.nlink !== 1n ||
    (ownerMetadata.mode & 0o777n) !== LEASE_MODE ||
    (pathMetadata.mode & 0o777n) !== LEASE_MODE ||
    !sameFile(ownerMetadata, pathMetadata)
  ) {
    fail("RUNTIME_COUNTER_LEASE_OWNERSHIP_LOST");
  }
}

async function assertLeaseOwnership(ownerHandle, lockPath, ownerRecord) {
  let pathHandle;
  try {
    pathHandle = await open(lockPath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  } catch {
    fail("RUNTIME_COUNTER_LEASE_OWNERSHIP_LOST");
  }
  try {
    const [ownerMetadata, openedPathMetadata, linkedPathMetadata, linkedRecord] = await Promise.all(
      [
        ownerHandle.stat({ bigint: true }),
        pathHandle.stat({ bigint: true }),
        lstat(lockPath, { bigint: true }),
        pathHandle.readFile("utf8"),
      ],
    );
    assertLeaseMetadata(ownerMetadata, openedPathMetadata);
    assertLeaseMetadata(ownerMetadata, linkedPathMetadata);
    if (linkedRecord !== ownerRecord) fail("RUNTIME_COUNTER_LEASE_OWNERSHIP_LOST");
    return ownerMetadata;
  } finally {
    await pathHandle.close();
  }
}

async function createLeaseQuarantine(lockPath) {
  const quarantineRoot = `${lockPath}.release-${randomBytes(32).toString("base64url")}`;
  await mkdir(quarantineRoot, { mode: 0o700 });
  const metadata = await lstat(quarantineRoot, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777n) !== 0o700n) {
    fail("RUNTIME_COUNTER_LEASE_OWNERSHIP_LOST");
  }
  return quarantineRoot;
}

async function quarantineAndRemoveOwnedLease(ownerHandle, lockPath, ownerRecord) {
  const quarantineRoot = await createLeaseQuarantine(lockPath);
  const quarantinePath = join(quarantineRoot, "owner.lock");
  let ownerRemoved = false;
  try {
    await rename(lockPath, quarantinePath);
    await assertLeaseOwnership(ownerHandle, quarantinePath, ownerRecord);
    await unlink(quarantinePath);
    ownerRemoved = true;
  } finally {
    try {
      await rmdir(quarantineRoot);
    } catch (error) {
      const preservesUnownedPath =
        !ownerRemoved && error instanceof Error && "code" in error && error.code === "ENOTEMPTY";
      if (!preservesUnownedPath) throw error;
    }
  }
}

async function removeFailedLeaseAcquisition(ownerHandle, lockPath, ownerRecord) {
  try {
    await quarantineAndRemoveOwnedLease(ownerHandle, lockPath, ownerRecord);
  } catch {
    // A failed acquisition never deletes an isolated path it cannot prove it owns.
  } finally {
    await ownerHandle.close().catch(() => undefined);
  }
}

export async function acquireRuntimeCounterLease(lockPath, dependencies = {}) {
  if (
    typeof lockPath !== "string" ||
    !isAbsolute(lockPath) ||
    resolve(lockPath) !== lockPath ||
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies) ||
    Reflect.ownKeys(dependencies).some((key) => key !== "beforeReleaseQuarantine") ||
    (dependencies.beforeReleaseQuarantine !== undefined &&
      typeof dependencies.beforeReleaseQuarantine !== "function")
  ) {
    fail("RUNTIME_COUNTER_LEASE_PATH_INVALID");
  }
  const beforeReleaseQuarantine = dependencies.beforeReleaseQuarantine ?? (() => undefined);
  const ownerToken = randomBytes(32).toString("base64url");
  const ownerRecord = `${JSON.stringify({ pid: process.pid, token: ownerToken, version: 1 })}\n`;
  let ownerHandle;
  try {
    ownerHandle = await open(lockPath, "wx+", Number(LEASE_MODE));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      fail("RUNTIME_COUNTER_ACCEPTANCE_BUSY");
    }
    fail("RUNTIME_COUNTER_LEASE_ACQUIRE_FAILED");
  }
  try {
    await ownerHandle.writeFile(ownerRecord, "utf8");
    await ownerHandle.sync();
    await assertLeaseOwnership(ownerHandle, lockPath, ownerRecord);
  } catch {
    await removeFailedLeaseAcquisition(ownerHandle, lockPath, ownerRecord);
    fail("RUNTIME_COUNTER_LEASE_ACQUIRE_FAILED");
  }

  let released = false;
  return Object.freeze({
    release: async () => {
      if (released) fail("RUNTIME_COUNTER_LEASE_RELEASE_INVALID");
      released = true;
      try {
        await assertLeaseOwnership(ownerHandle, lockPath, ownerRecord);
        await beforeReleaseQuarantine();
        await quarantineAndRemoveOwnedLease(ownerHandle, lockPath, ownerRecord);
      } catch (error) {
        if (error instanceof RuntimeCounterAcceptanceError) throw error;
        fail("RUNTIME_COUNTER_LEASE_OWNERSHIP_LOST");
      } finally {
        await ownerHandle.close();
      }
    },
  });
}

export function generateRuntimeSetup(runtimeId) {
  const adminPin = String(randomInt(100_000, 1_000_000));
  let approverPin = String(randomInt(100_000, 1_000_000));
  while (approverPin === adminPin) {
    approverPin = String(randomInt(100_000, 1_000_000));
  }
  return Object.freeze({
    adminUsername: `owner-${runtimeId}`,
    adminDisplayName: `组合店长 ${runtimeId}`,
    adminPassword: `admin-${randomBytes(24).toString("base64url")}`,
    adminPin,
    approverUsername: `approver-${runtimeId}`,
    approverDisplayName: `组合复核 ${runtimeId}`,
    approverPassword: `approver-${randomBytes(24).toString("base64url")}`,
    approverPin,
  });
}

export function assertExactRuntimeResult(result, status, release) {
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    fail("RUNTIME_COUNTER_RUNTIME_OUTPUT_INVALID");
  }
  if (
    result.code !== 0 ||
    result.stderr !== "" ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    value.status !== status ||
    value.release !== release
  ) {
    fail("RUNTIME_COUNTER_RUNTIME_OUTPUT_INVALID");
  }
}

async function readRuntimeInstanceId(configRoot, identity, release, statuses) {
  const statePath = join(configRoot, "state.json");
  const metadata = await lstat(statePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    fail("RUNTIME_COUNTER_STATE_INVALID");
  }
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    fail("RUNTIME_COUNTER_STATE_INVALID");
  }
  if (
    !statuses.includes(state?.status) ||
    state.release !== release ||
    !/^[A-Za-z0-9_-]{22,128}$/u.test(state.instance_id) ||
    JSON.stringify(state.volumes) !== JSON.stringify(identity.volumes)
  ) {
    fail("RUNTIME_COUNTER_STATE_INVALID");
  }
  return state.instance_id;
}

export async function loadRuntimeInstanceId(configRoot, identity, release) {
  return await readRuntimeInstanceId(configRoot, identity, release, ["installed"]);
}

export async function optionalRuntimeInstanceId(configRoot, identity, release) {
  try {
    return await readRuntimeInstanceId(configRoot, identity, release, [
      "prepared",
      "finalizing",
      "installed",
    ]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
