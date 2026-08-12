import { join } from "node:path";

import { photoInventoryDigest } from "./hk-vps-data-protection-files.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import { readCatalogEvidence, readMigrationLedger } from "./hk-vps-release-remote-db.mjs";
import { migrationLedgerDigest } from "./hk-vps-release-remote-db-evidence.mjs";
import { readDataProtectionPhotoInventory } from "./hk-vps-data-protection-db.mjs";

const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

export async function restoreDataProtectionDatabase(verified, signal, dependencies = {}) {
  if (verified.dumpPath !== join(verified.setPath, verified.manifest.database.file)) {
    fail("CLOUD_DATA_DATABASE_RESTORE_INVALID");
  }
  return await (dependencies.runCloudCommand ?? runCloudCommand)(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      'exec /usr/bin/sudo -u postgres -- /usr/bin/pg_restore --clean --if-exists --exit-on-error --single-transaction --dbname "$1" < "$2"',
      "laundry-data-protection-restore",
      "laundry_v2",
      verified.dumpPath,
    ],
    {
      cwd: "/",
      environment: COMMAND_ENVIRONMENT,
      label: "CLOUD_DATA_DATABASE_RESTORE",
      signal,
      timeoutMs: 10 * 60_000,
    },
  );
}

export async function verifyRestoredDataProtectionDatabase(manifest, signal, dependencies = {}) {
  const ledger = await (dependencies.readMigrationLedger ?? readMigrationLedger)(
    "laundry_v2",
    signal,
  );
  const catalog = await (dependencies.readCatalogEvidence ?? readCatalogEvidence)(
    "laundry_v2",
    signal,
    "write_frozen",
  );
  const photos = await (dependencies.readPhotoInventory ?? readDataProtectionPhotoInventory)(
    "laundry_v2",
    signal,
  );
  const evidence = Object.freeze({
    migrationHead: ledger.at(-1)?.filename,
    migrationCount: ledger.length,
    migrationLedgerSha256: migrationLedgerDigest(ledger),
    catalogSha256: catalog.sha256,
    photoInventorySha256: photoInventoryDigest(photos),
    photos,
  });
  if (
    evidence.migrationHead !== manifest.migration.head ||
    evidence.migrationCount !== manifest.migration.count ||
    evidence.migrationLedgerSha256 !== manifest.migration.ledger_sha256 ||
    evidence.catalogSha256 !== manifest.migration.catalog_sha256 ||
    evidence.photoInventorySha256 !== manifest.photos.inventory_sha256 ||
    JSON.stringify(evidence.photos) !== JSON.stringify(manifest.photos.files)
  ) {
    fail("CLOUD_DATA_DATABASE_RESTORE_MISMATCH");
  }
  return evidence;
}
