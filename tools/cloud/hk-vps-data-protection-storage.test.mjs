import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  cleanupDataProtectionStaging,
  inspectRetainedDataProtectionSets,
  prepareDataProtectionStaging,
} from "./hk-vps-data-protection-storage.mjs";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-cloud-data-storage-")));
  roots.push(root);
  const setRoot = join(root, "sets");
  await mkdir(setRoot, { mode: 0o700 });
  const metadata = await lstat(root);
  return {
    root,
    setRoot,
    identity: Object.freeze({ uid: metadata.uid, gid: metadata.gid }),
    ensureRoots: async () => ({ root, setRoot }),
  };
}

test("staging is unique, private and removable only through its operation identity", async () => {
  const input = await fixture();
  const operationId = "a".repeat(32);
  const staging = await prepareDataProtectionStaging(operationId, input);
  assert.equal(staging.stagingPath, join(input.root, `.set-${operationId}.tmp`));
  assert.equal((await lstat(staging.stagingPath)).mode & 0o7777, 0o700);
  await assert.rejects(
    () => cleanupDataProtectionStaging(staging.stagingPath, "b".repeat(32), input),
    { code: "CLOUD_DATA_STAGING_INVALID" },
  );
  assert.equal(await cleanupDataProtectionStaging(staging.stagingPath, operationId, input), true);
});

test("staging removal errors are stable and leave the exact directory for recovery", async () => {
  const input = await fixture();
  const operationId = "c".repeat(32);
  const staging = await prepareDataProtectionStaging(operationId, input);
  await assert.rejects(
    () =>
      cleanupDataProtectionStaging(staging.stagingPath, operationId, {
        ...input,
        rm: async () => {
          throw new Error("filesystem unavailable");
        },
      }),
    { code: "CLOUD_DATA_STAGING_CLEANUP_FAILED" },
  );
  assert.equal((await lstat(staging.stagingPath)).isDirectory(), true);
  assert.equal(await cleanupDataProtectionStaging(staging.stagingPath, operationId, input), true);
});

test("retention validates every existing set and reserves one bounded slot", async () => {
  const input = await fixture();
  const names = [
    "manual-20260812T010203Z-0123456789abcdef",
    "scheduled-20260812T020203Z-0123456789abcdef",
  ];
  const verified = [];
  const result = await inspectRetainedDataProtectionSets({
    ...input,
    readdir: async () => names,
    maximumSets: 3,
    verifySet: async (path) => {
      verified.push(path);
      return { setPath: path };
    },
  });
  assert.equal(result.sets.length, 2);
  assert.equal(verified.length, 2);
  await assert.rejects(
    () =>
      inspectRetainedDataProtectionSets({
        ...input,
        readdir: async () => names,
        maximumSets: 2,
        verifySet: async () => ({}),
      }),
    { code: "CLOUD_DATA_RETENTION_LIMIT" },
  );
});
