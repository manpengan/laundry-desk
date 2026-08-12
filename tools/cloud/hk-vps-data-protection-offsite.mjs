import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  DATA_PROTECTION_MAX_OFFSITE_SETS,
  DATA_PROTECTION_OFFSITE_MARKER,
  DATA_PROTECTION_OFFSITE_ROOT,
  requireDataProtectionSetId,
} from "./hk-vps-data-protection-contract.mjs";
import {
  captureDataProtectionPhotos,
  verifyDataProtectionSet,
} from "./hk-vps-data-protection-files.mjs";
import {
  copyDataProtectionFileOffsite,
  copySmallDataProtectionFileOffsite,
} from "./hk-vps-data-protection-offsite-copy.mjs";
import { assertDataProtectionOffsiteAuthority } from "./hk-vps-data-protection-offsite-authority.mjs";
import { dataProtectionFailureRequiresOperation } from "./hk-vps-data-protection-cleanup.mjs";
import {
  clearDataProtectionOperation,
  createDataProtectionOperation,
  persistDataProtectionOperation,
  persistDataProtectionState,
  readDataProtectionOperation,
  readDataProtectionState,
} from "./hk-vps-data-protection-state.mjs";
import { inspectRetainedDataProtectionSets } from "./hk-vps-data-protection-storage.mjs";
import { CloudReleaseError, fail } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import { transitionExists } from "./hk-vps-release-remote-support.mjs";

const NETWORK_FILESYSTEMS = new Set(["nfs4", "cifs", "fuse.sshfs"]);
const REQUIRED_MOUNT_OPTIONS = Object.freeze(["rw", "nodev", "nosuid", "noexec", "nosymfollow"]);
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});
const OFFSITE_MARKER = /^laundry-desk-offsite:v1:([a-z0-9][a-z0-9-]{0,63})\n$/u;

function errorCode(error) {
  return error instanceof CloudReleaseError && error.code.startsWith("CLOUD_DATA_")
    ? error.code
    : "CLOUD_DATA_OFFSITE_FAILED";
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function parseDataProtectionMount(source, expectedTarget = DATA_PROTECTION_OFFSITE_ROOT) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail("CLOUD_DATA_OFFSITE_MOUNT_INVALID", error);
  }
  const rows = value?.filesystems;
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (
    row === null ||
    Object.keys(row).sort().join(",") !== "fstype,options,source,target" ||
    row.target !== expectedTarget ||
    typeof row.source !== "string" ||
    row.source.length < 1 ||
    row.source.length > 512 ||
    row.source.includes("\0") ||
    !NETWORK_FILESYSTEMS.has(row.fstype) ||
    typeof row.options !== "string"
  ) {
    fail("CLOUD_DATA_OFFSITE_MOUNT_INVALID");
  }
  const options = new Set(row.options.split(","));
  if (REQUIRED_MOUNT_OPTIONS.some((option) => !options.has(option))) {
    fail("CLOUD_DATA_OFFSITE_MOUNT_INVALID");
  }
  return Object.freeze({
    target: row.target,
    source: row.source,
    fstype: row.fstype,
    options: Object.freeze([...options].sort()),
  });
}

async function assertPrivateDirectory(path, identity, code) {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    (await realpath(path).catch(() => null)) !== path
  ) {
    fail(code);
  }
  return metadata;
}

async function readOffsiteMarker(root, identity) {
  const path = join(root, DATA_PROTECTION_OFFSITE_MARKER);
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o7777) !== 0o600 ||
    metadata.size < 1 ||
    metadata.size > 128
  ) {
    fail("CLOUD_DATA_OFFSITE_ROOT_INVALID");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      fail("CLOUD_DATA_OFFSITE_ROOT_INVALID");
    }
    const match = OFFSITE_MARKER.exec(await handle.readFile("utf8"));
    if (match === null) fail("CLOUD_DATA_OFFSITE_ROOT_INVALID");
    return match[1];
  } finally {
    await handle.close();
  }
}

export async function assertDataProtectionOffsite(options = {}) {
  const root = options.root ?? DATA_PROTECTION_OFFSITE_ROOT;
  const identity = options.identity ?? Object.freeze({ uid: 0, gid: 0 });
  const run = options.runCloudCommand ?? runCloudCommand;
  const mountResult = await run(
    "/usr/bin/findmnt",
    ["--json", "--target", root, "--output", "TARGET,SOURCE,FSTYPE,OPTIONS"],
    {
      cwd: "/",
      environment: COMMAND_ENVIRONMENT,
      label: "CLOUD_DATA_OFFSITE_MOUNT",
      signal: options.signal,
      timeoutMs: 2 * 60_000,
    },
  );
  const mount = parseDataProtectionMount(mountResult.stdout, root);
  const target = await assertPrivateDirectory(root, identity, "CLOUD_DATA_OFFSITE_ROOT_INVALID");
  const setsRoot = join(root, "sets");
  await assertPrivateDirectory(setsRoot, identity, "CLOUD_DATA_OFFSITE_ROOT_INVALID");
  const sourceMetadata = await (options.sourceMetadata ?? lstat)(options.sourceRoot);
  if (target.dev === sourceMetadata.dev) fail("CLOUD_DATA_OFFSITE_DEVICE_INVALID");
  const targetId = await readOffsiteMarker(root, identity);
  const authority = await (options.assertAuthority ?? assertDataProtectionOffsiteAuthority)(
    mount,
    targetId,
    { identity, now: options.now },
  );
  return Object.freeze({
    deploymentProof: true,
    failureDomain: authority.failure_domain,
    identity,
    mount,
    remoteIdentity: authority.remote_identity,
    root,
    setsRoot,
    targetId,
  });
}

export async function copyDataProtectionSetOffsite(sourceSet, offsite, operationId, options = {}) {
  const sourceIdentity = options.sourceIdentity ?? Object.freeze({ uid: 0, gid: 0 });
  const verified = await (options.verifySet ?? verifyDataProtectionSet)(sourceSet, {
    identity: sourceIdentity,
  });
  const names = (await (options.readdir ?? readdir)(offsite.setsRoot)).sort();
  if (names.length > DATA_PROTECTION_MAX_OFFSITE_SETS) {
    fail("CLOUD_DATA_OFFSITE_RETENTION_LIMIT");
  }
  for (const name of names) {
    requireDataProtectionSetId(name);
    const existing = await (options.verifySet ?? verifyDataProtectionSet)(
      join(offsite.setsRoot, name),
      { identity: offsite.identity },
    );
    if (name === verified.manifest.set_id) {
      if (existing.manifestSha256 !== verified.manifestSha256) {
        fail("CLOUD_DATA_OFFSITE_COLLISION");
      }
      return existing;
    }
  }
  if (names.length === DATA_PROTECTION_MAX_OFFSITE_SETS) {
    fail("CLOUD_DATA_OFFSITE_RETENTION_LIMIT");
  }
  if (typeof operationId !== "string" || !/^[0-9a-f]{32}$/u.test(operationId)) {
    fail("CLOUD_DATA_OPERATION_INVALID");
  }
  const staging = join(offsite.root, `.set-${operationId}.tmp`);
  try {
    await (options.mkdir ?? mkdir)(staging, { mode: 0o700 });
  } catch (error) {
    fail("CLOUD_DATA_OFFSITE_STAGING_CREATE_FAILED", error);
  }
  try {
    const staged = await assertPrivateDirectory(
      staging,
      offsite.identity,
      "CLOUD_DATA_OFFSITE_COPY_INVALID",
    );
    const assertStagingUnchanged = async () => {
      const current = await assertPrivateDirectory(
        staging,
        offsite.identity,
        "CLOUD_DATA_OFFSITE_COPY_INVALID",
      );
      if (current.dev !== staged.dev || current.ino !== staged.ino) {
        fail("CLOUD_DATA_OFFSITE_COPY_INVALID");
      }
    };
    await (options.copyFile ?? copyDataProtectionFileOffsite)(
      verified.dumpPath,
      join(staging, "database.dump"),
      verified.manifest.database.bytes,
      verified.manifest.database.sha256,
    );
    await (options.capturePhotos ?? captureDataProtectionPhotos)(
      staging,
      verified.manifest.photos.files,
      {
        photoRoot: join(sourceSet, "photos"),
        sourceIdentity,
      },
    );
    await (options.copySmallFile ?? copySmallDataProtectionFileOffsite)(
      join(sourceSet, "manifest.json"),
      join(staging, "manifest.json"),
    );
    await (options.copySmallFile ?? copySmallDataProtectionFileOffsite)(
      join(sourceSet, "verification.json"),
      join(staging, "verification.json"),
    );
    await assertStagingUnchanged();
    await syncDirectory(staging);
    const stagedSet = await (options.verifySet ?? verifyDataProtectionSet)(staging, {
      identity: offsite.identity,
      expectedSetId: verified.manifest.set_id,
    });
    if (stagedSet.manifestSha256 !== verified.manifestSha256) {
      fail("CLOUD_DATA_OFFSITE_COPY_INVALID");
    }
    await assertStagingUnchanged();
    const target = join(offsite.setsRoot, verified.manifest.set_id);
    await (options.rename ?? rename)(staging, target);
    await syncDirectory(offsite.setsRoot);
    const copied = await (options.verifySet ?? verifyDataProtectionSet)(target, {
      identity: offsite.identity,
    });
    if (copied.manifestSha256 !== verified.manifestSha256) {
      fail("CLOUD_DATA_OFFSITE_COPY_INVALID");
    }
    return copied;
  } catch (error) {
    try {
      await (options.rm ?? rm)(staging, { force: true, recursive: true });
    } catch (cleanupError) {
      fail("CLOUD_DATA_OFFSITE_CLEANUP_FAILED", cleanupError);
    }
    throw error;
  }
}

async function assertOperationAvailable(dependencies) {
  if (await (dependencies.transitionExists ?? transitionExists)()) {
    fail("CLOUD_DATA_RELEASE_TRANSITION_ACTIVE");
  }
  if ((await (dependencies.readOperation ?? readDataProtectionOperation)()) !== null) {
    fail("CLOUD_DATA_OPERATION_ACTIVE");
  }
}

export async function runDataProtectionOffsite(options = {}, dependencies = {}) {
  await assertOperationAvailable(dependencies);
  const retained = await (dependencies.inspectSets ?? inspectRetainedDataProtectionSets)({
    reserveSlot: false,
  });
  const selected = options.setId
    ? retained.sets.find((entry) => entry.manifest.set_id === options.setId)
    : [...retained.sets].sort((left, right) =>
        right.manifest.created_at.localeCompare(left.manifest.created_at),
      )[0];
  if (selected === undefined) fail("CLOUD_DATA_SET_NOT_FOUND");
  const now = dependencies.now ?? (() => new Date());
  const bytes = dependencies.randomBytes ?? randomBytes;
  const operation = createDataProtectionOperation("offsite", selected.manifest.set_id, now(), {
    randomBytes: bytes,
  });
  await (dependencies.persistOperation ?? persistDataProtectionOperation)(operation);
  try {
    const offsite = await (dependencies.assertOffsite ?? assertDataProtectionOffsite)({
      signal: options.signal,
      sourceRoot: retained.root,
    });
    const copied = await (dependencies.copySet ?? copyDataProtectionSetOffsite)(
      selected.setPath,
      offsite,
      operation.operation_id,
    );
    const state = await (dependencies.readState ?? readDataProtectionState)();
    await (dependencies.persistState ?? persistDataProtectionState)({
      ...state,
      last_offsite: {
        set_id: copied.manifest.set_id,
        completed_at: now().toISOString(),
        manifest_sha256: copied.manifestSha256,
        target_id: offsite.targetId,
        failure_domain: offsite.failureDomain,
        remote_identity: offsite.remoteIdentity,
      },
      last_failure: { ...state.last_failure, offsite: null },
    });
    await (dependencies.clearOperation ?? clearDataProtectionOperation)();
    return Object.freeze({
      set_id: copied.manifest.set_id,
      manifest_sha256: copied.manifestSha256,
      target_id: offsite.targetId,
    });
  } catch (error) {
    const retainOperation = dataProtectionFailureRequiresOperation(error);
    try {
      const state = await (dependencies.readState ?? readDataProtectionState)();
      await (dependencies.persistState ?? persistDataProtectionState)({
        ...state,
        last_failure: {
          ...state.last_failure,
          offsite: {
            code: errorCode(error),
            failed_at: now().toISOString(),
          },
        },
      });
    } catch (stateError) {
      throw stateError;
    }
    if (!retainOperation) {
      await (dependencies.clearOperation ?? clearDataProtectionOperation)();
    }
    throw error;
  }
}
