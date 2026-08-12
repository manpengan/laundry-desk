import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDataProtectionDump,
  dataProtectionShadowDatabaseName,
  dataProtectionVerificationFromDrill,
  drillDataProtectionSet,
  parseDataProtectionPhotoInventory,
  readDataProtectionSourceEvidence,
} from "./hk-vps-data-protection-db.mjs";
import { photoInventoryDigest } from "./hk-vps-data-protection-files.mjs";
import { migrationLedgerDigest } from "./hk-vps-release-remote-db-evidence.mjs";

const photo = Object.freeze({
  storage_key: "11111111-1111-4111-8111-111111111111.jpg",
  bytes: 4,
  sha256: "a".repeat(64),
});
const ledger = Object.freeze([
  Object.freeze({ filename: "0051_customer_extended_profiles.sql", checksum: "b".repeat(64) }),
]);

test("database dump remains root-owned while pg_dump receives only an inherited handle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cloud-dump-"));
  t.after(async () => await rm(root, { force: true, recursive: true }));
  const staging = join(root, "private");
  await mkdir(staging, { mode: 0o700 });
  const identity = await lstat(staging);
  const path = join(staging, "database.dump");
  let receivedDescriptor = false;
  const result = await createDataProtectionDump(path, undefined, {
    identity: Object.freeze({ uid: identity.uid, gid: identity.gid }),
    runDump: async (handle) => {
      receivedDescriptor = Number.isSafeInteger(handle.fd);
      await handle.writeFile("synthetic custom dump");
    },
  });
  assert.equal(receivedDescriptor, true);
  assert.equal(result.bytes, 21);
  assert.equal((await lstat(path)).mode & 0o7777, 0o600);
});

test("photo inventory parser accepts only sorted bounded authority rows", () => {
  assert.deepEqual(
    parseDataProtectionPhotoInventory(`${photo.storage_key}\t4\t${photo.sha256}\n`),
    [photo],
  );
  assert.deepEqual(parseDataProtectionPhotoInventory(""), []);
  for (const source of [
    `${photo.storage_key}\t0\t${photo.sha256}\n`,
    `${photo.storage_key}\t4\tbad\n`,
    `${photo.storage_key}\t4\t${photo.sha256}\n${photo.storage_key}\t4\t${photo.sha256}\n`,
  ]) {
    assert.throws(() => parseDataProtectionPhotoInventory(source), {
      code: "CLOUD_DATA_PHOTO_INVENTORY_INVALID",
    });
  }
});

test("source evidence binds live code, exact migration ledger, catalog and photos", async () => {
  const value = await readDataProtectionSourceEvidence(undefined, {
    readReleaseMarker: async () => ({ git_sha: "1".repeat(40) }),
    readMigrationLedger: async () => ledger,
    readCatalogEvidence: async () => ({ sha256: "c".repeat(64) }),
    readPhotoInventory: async () => [photo],
  });
  assert.equal(value.codeSha, "1".repeat(40));
  assert.equal(value.migration.head, ledger[0].filename);
  assert.equal(value.migration.ledger_sha256, migrationLedgerDigest(ledger));
  assert.deepEqual(value.photos, [photo]);
});

function verified() {
  return Object.freeze({
    dumpPath: "/private/set/database.dump",
    manifestSha256: "d".repeat(64),
    manifest: Object.freeze({
      set_id: "manual-20260812T010203Z-0123456789abcdef",
      migration: Object.freeze({
        ledger_sha256: migrationLedgerDigest(ledger),
        catalog_sha256: "c".repeat(64),
      }),
      photos: Object.freeze({
        inventory_sha256: photoInventoryDigest([photo]),
        files: Object.freeze([photo]),
      }),
    }),
  });
}

function drillDependencies(events, overrides = {}) {
  return Object.freeze({
    token: () => "0".repeat(24),
    postgresCommand: async (file, arguments_, label) => {
      events.push(label);
      if (label === "CLOUD_DATA_SHADOW_COLLISION") return { stdout: "" };
      assert.ok(file.startsWith("/usr/bin/"));
      assert.ok(Array.isArray(arguments_));
      return { stdout: "" };
    },
    restoreBackup: async () => events.push("restore"),
    readMigrationLedger: async () => ledger,
    readCatalogEvidence: async () => ({ sha256: "c".repeat(64) }),
    readPhotoInventory: async () => [photo],
    ...overrides,
  });
}

test("shadow drill restores and compares every authority before dropping its database", async () => {
  const events = [];
  const result = await drillDataProtectionSet(verified(), undefined, drillDependencies(events));
  assert.deepEqual(events, [
    "CLOUD_DATA_SHADOW_COLLISION",
    "CLOUD_DATA_SHADOW_CREATE",
    "restore",
    "CLOUD_DATA_SHADOW_DROP",
  ]);
  const proof = dataProtectionVerificationFromDrill(verified(), result, "2026-08-12T01:03:03.000Z");
  assert.equal(proof.catalog_sha256, "c".repeat(64));
});

test("shadow mismatch still drops the database and fails closed", async () => {
  const events = [];
  await assert.rejects(
    () =>
      drillDataProtectionSet(
        verified(),
        undefined,
        drillDependencies(events, {
          readPhotoInventory: async () => [],
        }),
      ),
    { code: "CLOUD_DATA_SHADOW_MISMATCH" },
  );
  assert.equal(events.at(-1), "CLOUD_DATA_SHADOW_DROP");
});

test("shadow cleanup failure is primary and the database name is derivable from the set", async () => {
  const events = [];
  const database = dataProtectionShadowDatabaseName(verified().manifest.set_id);
  assert.match(database, /^laundry_data_drill_[0-9a-f]{24}$/u);
  assert.equal(database, dataProtectionShadowDatabaseName(verified().manifest.set_id));
  await assert.rejects(
    () =>
      drillDataProtectionSet(
        verified(),
        undefined,
        drillDependencies(events, {
          postgresCommand: async (_file, _arguments, label) => {
            events.push(label);
            if (label === "CLOUD_DATA_SHADOW_COLLISION") return { stdout: "" };
            if (label === "CLOUD_DATA_SHADOW_DROP") throw new Error("drop failed");
            return { stdout: "" };
          },
          readPhotoInventory: async () => [],
        }),
      ),
    { code: "CLOUD_DATA_SHADOW_DROP_FAILED" },
  );
  assert.equal(events.at(-1), "CLOUD_DATA_SHADOW_DROP");
});
