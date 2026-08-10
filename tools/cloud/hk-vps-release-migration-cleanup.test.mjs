import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupStaleMigrationBundles } from "./hk-vps-release-migration-cleanup.mjs";
import { prepareDeployState } from "./hk-vps-release-remote.mjs";

const CANDIDATE = "a".repeat(40);
const SECOND_CANDIDATE = "b".repeat(40);

async function stateFixture() {
  return await realpath(await mkdtemp(join(tmpdir(), "laundry-migration-cleanup-")));
}

async function partialBundle(stateRoot, name) {
  const root = join(stateRoot, name);
  const migrations = join(root, "packages/db/src/migrations");
  await mkdir(migrations, { mode: 0o700, recursive: true });
  await writeFile(join(migrations, "0046_print_job_request_idempotency.sql"), "SELECT 1;\n", {
    mode: 0o600,
  });
  return root;
}

function identity(stateRoot) {
  return Object.freeze({ gid: process.getgid(), stateRoot, uid: process.getuid() });
}

test("stale bundles are atomically tombstoned and removed before release preflight", async () => {
  const stateRoot = await stateFixture();
  const first = await partialBundle(stateRoot, `.migration-${CANDIDATE}-ABC123`);
  const second = await partialBundle(stateRoot, `.migration-${SECOND_CANDIDATE}-DEF456`);
  try {
    assert.equal(await cleanupStaleMigrationBundles(undefined, identity(stateRoot)), 2);
    await assert.rejects(() => access(first), { code: "ENOENT" });
    await assert.rejects(() => access(second), { code: "ENOENT" });
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("a hard crash after tombstone rename is recovered on the next cleanup", async () => {
  const stateRoot = await stateFixture();
  const tombstone = await partialBundle(stateRoot, `.migration-tombstone-${CANDIDATE}-ABC123`);
  try {
    assert.equal(await cleanupStaleMigrationBundles(undefined, identity(stateRoot)), 1);
    await assert.rejects(() => access(tombstone), { code: "ENOENT" });
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("hard-linked or malformed stale content fails closed without deleting the bundle", async () => {
  const stateRoot = await stateFixture();
  const bundle = await partialBundle(stateRoot, `.migration-${CANDIDATE}-ABC123`);
  const migrations = join(bundle, "packages/db/src/migrations");
  await link(
    join(migrations, "0046_print_job_request_idempotency.sql"),
    join(migrations, "0045_store_commissioning_staff_credentials.sql"),
  );
  try {
    await assert.rejects(() => cleanupStaleMigrationBundles(undefined, identity(stateRoot)), {
      code: "CLOUD_RELEASE_MIGRATION_CLEANUP_INVALID",
    });
    await access(bundle);
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("deploy cleans stale bundles only after proving there is no active transition", async () => {
  const events = [];
  await prepareDeployState(undefined, {
    assertReleasePreflight: async () => events.push("preflight"),
    cleanupStaleMigrationBundles: async () => events.push("cleanup-migrations"),
    cleanupUnboundReleaseControllers: async () => events.push("cleanup-controllers"),
    ensureReleaseDirectories: async () => events.push("ensure-state"),
    transitionExists: async () => {
      events.push("transition-absent");
      return false;
    },
  });
  assert.deepEqual(events, [
    "ensure-state",
    "transition-absent",
    "cleanup-migrations",
    "cleanup-controllers",
    "preflight",
  ]);

  events.length = 0;
  await assert.rejects(
    () =>
      prepareDeployState(undefined, {
        cleanupStaleMigrationBundles: async () => events.push("cleanup-migrations"),
        ensureReleaseDirectories: async () => events.push("ensure-state"),
        transitionExists: async () => true,
      }),
    { code: "CLOUD_RELEASE_TRANSITION_ACTIVE" },
  );
  assert.deepEqual(events, ["ensure-state"]);
});
