import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { emptyDataProtectionState } from "./hk-vps-data-protection-contract.mjs";
import {
  copyDataProtectionSetOffsite,
  parseDataProtectionMount,
  runDataProtectionOffsite,
} from "./hk-vps-data-protection-offsite.mjs";
import { CloudReleaseError } from "./hk-vps-release-core.mjs";

const setId = "manual-20260812T010203Z-0123456789abcdef";
const manifestSha256 = "1".repeat(64);

function selectedSet() {
  return Object.freeze({
    setPath: "/private/sets/" + setId,
    manifestSha256,
    manifest: Object.freeze({
      set_id: setId,
      created_at: "2026-08-12T01:02:03.000Z",
    }),
  });
}

async function copyFixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-offsite-copy-")));
  t.after(async () => await rm(root, { force: true, recursive: true }));
  const setsRoot = join(root, "sets");
  await mkdir(setsRoot, { mode: 0o700 });
  const metadata = await lstat(root);
  const verified = Object.freeze({
    manifestSha256,
    manifest: Object.freeze({
      set_id: setId,
      database: Object.freeze({ bytes: 4, sha256: "2".repeat(64) }),
      photos: Object.freeze({ files: Object.freeze([]) }),
    }),
  });
  const result = await copyDataProtectionSetOffsite(
    "/source/" + setId,
    {
      root,
      setsRoot,
      identity: Object.freeze({ uid: metadata.uid, gid: metadata.gid }),
    },
    "a".repeat(32),
    {
      verifySet: async (path) =>
        path === join(setsRoot, setId) && overrides.finalMismatch
          ? Object.freeze({ ...verified, manifestSha256: "3".repeat(64) })
          : verified,
      copyFile: overrides.copyFile ?? (async () => undefined),
      copySmallFile: async () => undefined,
      capturePhotos: async () => undefined,
      rm: overrides.rm,
    },
  );
  return result;
}

test("offsite mount parser requires an exact hardened network filesystem", () => {
  const valid = JSON.stringify({
    filesystems: [
      {
        target: "/mnt/laundry-desk-offsite",
        source: "backup.internal:/laundry",
        fstype: "nfs4",
        options: "rw,nodev,nosuid,noexec,nosymfollow,relatime",
      },
    ],
  });
  assert.equal(parseDataProtectionMount(valid).fstype, "nfs4");
  for (const change of [
    { fstype: "ext4" },
    { target: "/mnt/other" },
    { options: "rw,nodev,nosuid" },
  ]) {
    const row = { ...JSON.parse(valid).filesystems[0], ...change };
    assert.throws(() => parseDataProtectionMount(JSON.stringify({ filesystems: [row] })), {
      code: "CLOUD_DATA_OFFSITE_MOUNT_INVALID",
    });
  }
});

test("offsite action copies one verified set and records target evidence", async () => {
  const selected = selectedSet();
  let operation = null;
  let state = Object.freeze({
    ...emptyDataProtectionState(),
    last_failure: Object.freeze({
      ...emptyDataProtectionState().last_failure,
      backup: Object.freeze({
        code: "CLOUD_DATA_BACKUP_FAILED",
        failed_at: "2026-08-12T01:30:00.000Z",
      }),
    }),
  });
  const result = await runDataProtectionOffsite(
    {},
    {
      now: () => new Date("2026-08-12T02:02:03.000Z"),
      randomBytes: (bytes) => Buffer.alloc(bytes),
      transitionExists: async () => false,
      readOperation: async () => operation,
      persistOperation: async (next) => {
        operation = next;
      },
      clearOperation: async () => {
        operation = null;
      },
      inspectSets: async () => ({ root: "/private", sets: [selected] }),
      assertOffsite: async () => ({
        deploymentProof: true,
        failureDomain: "nas-taipei-a",
        remoteIdentity: "ed25519:SHA256:0123456789abcdef",
        targetId: "nas-a",
      }),
      copySet: async () => selected,
      readState: async () => state,
      persistState: async (next) => {
        state = next;
      },
    },
  );
  assert.deepEqual(result, {
    set_id: setId,
    manifest_sha256: "1".repeat(64),
    target_id: "nas-a",
  });
  assert.equal(state.last_offsite?.target_id, "nas-a");
  assert.equal(state.last_failure.backup?.code, "CLOUD_DATA_BACKUP_FAILED");
  assert.equal(state.last_failure.offsite, null);
  assert.equal(operation, null);
});

test("offsite publication rejects a replaced staging directory", async (t) => {
  await assert.rejects(
    () =>
      copyFixture(t, {
        copyFile: async (_source, destination) => {
          const staging = dirname(destination);
          await rename(staging, `${staging}.replaced`);
          await mkdir(staging, { mode: 0o700 });
        },
      }),
    { code: "CLOUD_DATA_OFFSITE_COPY_INVALID" },
  );
});

test("offsite publication binds the final manifest digest to its local source", async (t) => {
  await assert.rejects(() => copyFixture(t, { finalMismatch: true }), {
    code: "CLOUD_DATA_OFFSITE_COPY_INVALID",
  });
});

test("offsite cleanup failure overrides copy failure with a stable operator-visible code", async (t) => {
  await assert.rejects(
    () =>
      copyFixture(t, {
        copyFile: async () => {
          throw new Error("copy failed");
        },
        rm: async () => {
          throw new Error("cleanup failed");
        },
      }),
    { code: "CLOUD_DATA_OFFSITE_CLEANUP_FAILED" },
  );
});

test("offsite cleanup failure keeps the operation that identifies remote staging", async () => {
  const selected = selectedSet();
  let operation = null;
  let clearCalled = false;
  let state = emptyDataProtectionState();
  await assert.rejects(
    () =>
      runDataProtectionOffsite(
        {},
        {
          now: () => new Date("2026-08-12T02:02:03.000Z"),
          randomBytes: (bytes) => Buffer.alloc(bytes),
          transitionExists: async () => false,
          readOperation: async () => operation,
          persistOperation: async (next) => {
            operation = next;
          },
          clearOperation: async () => {
            clearCalled = true;
            operation = null;
          },
          inspectSets: async () => ({ root: "/private", sets: [selected] }),
          assertOffsite: async () => ({
            deploymentProof: true,
            failureDomain: "nas-taipei-a",
            remoteIdentity: "ed25519:SHA256:0123456789abcdef",
            targetId: "nas-a",
          }),
          copySet: async () => {
            throw new CloudReleaseError("CLOUD_DATA_OFFSITE_CLEANUP_FAILED");
          },
          readState: async () => state,
          persistState: async (next) => {
            state = next;
          },
        },
      ),
    { code: "CLOUD_DATA_OFFSITE_CLEANUP_FAILED" },
  );
  assert.equal(clearCalled, false);
  assert.notEqual(operation, null);
  assert.equal(state.last_failure.offsite?.code, "CLOUD_DATA_OFFSITE_CLEANUP_FAILED");
});
