import assert from "node:assert/strict";
import test from "node:test";

import {
  restoreDataProtectionDatabase,
  verifyRestoredDataProtectionDatabase,
} from "./hk-vps-data-protection-recovery-db.mjs";
import { migrationLedgerDigest } from "./hk-vps-release-remote-db-evidence.mjs";
import { photoInventoryDigest } from "./hk-vps-data-protection-files.mjs";

const ledger = Object.freeze([
  Object.freeze({ filename: "0051_customer_extended_profiles.sql", checksum: "a".repeat(64) }),
]);
const photos = Object.freeze([
  Object.freeze({
    storage_key: "11111111-1111-4111-8111-111111111111.jpg",
    bytes: 4,
    sha256: "b".repeat(64),
  }),
]);
const manifest = Object.freeze({
  database: Object.freeze({ file: "database.dump" }),
  migration: Object.freeze({
    head: ledger[0].filename,
    count: ledger.length,
    ledger_sha256: migrationLedgerDigest(ledger),
    catalog_sha256: "c".repeat(64),
  }),
  photos: Object.freeze({ files: photos, inventory_sha256: photoInventoryDigest(photos) }),
});

test("live restore uses one fixed single-transaction pg_restore target", async () => {
  let invocation;
  await restoreDataProtectionDatabase(
    {
      setPath: "/sets/manual-20260812T010203Z-0123456789abcdef",
      dumpPath: "/sets/manual-20260812T010203Z-0123456789abcdef/database.dump",
      manifest,
    },
    undefined,
    {
      runCloudCommand: async (file, arguments_, options) => {
        invocation = { file, arguments_, options };
      },
    },
  );
  assert.equal(invocation.file, "/bin/bash");
  assert.ok(invocation.arguments_.includes("laundry_v2"));
  assert.match(
    invocation.arguments_[3],
    /--clean --if-exists --exit-on-error --single-transaction/u,
  );
  assert.deepEqual(invocation.options.environment, {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  });
});

test("restored database must reproduce ledger, catalog and photo authority", async () => {
  const evidence = await verifyRestoredDataProtectionDatabase(manifest, undefined, {
    readMigrationLedger: async () => ledger,
    readCatalogEvidence: async () => ({ sha256: "c".repeat(64) }),
    readPhotoInventory: async () => photos,
  });
  assert.equal(evidence.migrationHead, ledger[0].filename);
  await assert.rejects(
    () =>
      verifyRestoredDataProtectionDatabase(manifest, undefined, {
        readMigrationLedger: async () => ledger,
        readCatalogEvidence: async () => ({ sha256: "d".repeat(64) }),
        readPhotoInventory: async () => photos,
      }),
    { code: "CLOUD_DATA_DATABASE_RESTORE_MISMATCH" },
  );
});
