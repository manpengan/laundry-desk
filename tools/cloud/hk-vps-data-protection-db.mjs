import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import {
  createDataProtectionVerification,
  requireDataProtectionSetId,
  requirePhotoStorageKey,
} from "./hk-vps-data-protection-contract.mjs";
import { photoInventoryDigest } from "./hk-vps-data-protection-files.mjs";
import { sha256DataProtectionFile } from "./hk-vps-data-protection-hash.mjs";
import { runDataProtectionDumpProcess } from "./hk-vps-data-protection-dump-process.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import {
  readCatalogEvidence,
  readMigrationLedger,
  restorePrivateBackup,
} from "./hk-vps-release-remote-db.mjs";
import { migrationLedgerDigest } from "./hk-vps-release-remote-db-evidence.mjs";
import { LIVE_ROOT, readReleaseMarker } from "./hk-vps-release-remote-support.mjs";

const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});
const DIGEST = /^[0-9a-f]{64}$/u;
const SHADOW = /^laundry_data_drill_[0-9a-f]{24}$/u;
const PHOTO_SQL = `SELECT storage_key || E'\t' || byte_size::text || E'\t' || content_sha256
  FROM public.garment_photos
 WHERE content_sha256 IS NOT NULL
 ORDER BY storage_key`;

function commandOptions(label, signal, timeoutMs = 2 * 60_000) {
  return Object.freeze({ cwd: "/", environment: COMMAND_ENVIRONMENT, label, signal, timeoutMs });
}

async function postgresCommand(file, arguments_, label, signal, timeoutMs, dependencies) {
  return await (dependencies.runCloudCommand ?? runCloudCommand)(
    "/usr/bin/sudo",
    ["-u", "postgres", "--", file, ...arguments_],
    commandOptions(label, signal, timeoutMs),
  );
}

function psqlArguments(database, sql) {
  return [
    "--no-psqlrc",
    "--quiet",
    "--set=ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--dbname",
    database,
    "--command",
    sql,
  ];
}

export function parseDataProtectionPhotoInventory(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 2 * 1024 * 1024) {
    fail("CLOUD_DATA_PHOTO_INVENTORY_INVALID");
  }
  const rows = source
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const fields = line.split("\t");
      const bytes = Number(fields[1]);
      if (
        fields.length !== 3 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > 8 * 1024 * 1024 ||
        typeof fields[2] !== "string" ||
        !DIGEST.test(fields[2])
      ) {
        fail("CLOUD_DATA_PHOTO_INVENTORY_INVALID");
      }
      return Object.freeze({
        storage_key: requirePhotoStorageKey(fields[0]),
        bytes,
        sha256: fields[2],
      });
    });
  if (
    rows.length > 10_000 ||
    rows.some((entry, index) => index > 0 && entry.storage_key <= rows[index - 1].storage_key)
  ) {
    fail("CLOUD_DATA_PHOTO_INVENTORY_INVALID");
  }
  return Object.freeze(rows);
}

export async function readDataProtectionPhotoInventory(database, signal, dependencies = {}) {
  if (typeof database !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(database)) {
    fail("CLOUD_DATA_DATABASE_NAME_INVALID");
  }
  const result = await postgresCommand(
    "/usr/bin/psql",
    psqlArguments(database, PHOTO_SQL),
    "CLOUD_DATA_PHOTO_INVENTORY",
    signal,
    undefined,
    dependencies,
  );
  return parseDataProtectionPhotoInventory(result.stdout);
}

export async function readDataProtectionSourceEvidence(signal, dependencies = {}) {
  const readMarker = dependencies.readReleaseMarker ?? readReleaseMarker;
  const readLedger = dependencies.readMigrationLedger ?? readMigrationLedger;
  const readCatalog = dependencies.readCatalogEvidence ?? readCatalogEvidence;
  const readPhotos = dependencies.readPhotoInventory ?? readDataProtectionPhotoInventory;
  const marker = await readMarker(LIVE_ROOT);
  const ledger = await readLedger(PROFILE.services.postgresDatabase, signal);
  const catalog = await readCatalog(PROFILE.services.postgresDatabase, signal, "write_frozen");
  const photos = await readPhotos(PROFILE.services.postgresDatabase, signal);
  const head = ledger.at(-1)?.filename;
  if (typeof head !== "string") fail("CLOUD_DATA_MIGRATION_LEDGER_INVALID");
  return Object.freeze({
    codeSha: marker.git_sha,
    migration: Object.freeze({
      head,
      count: ledger.length,
      ledger_sha256: migrationLedgerDigest(ledger),
      catalog_sha256: catalog.sha256,
    }),
    photos,
  });
}

export async function readDataProtectionLiveEvidence(signal, dependencies = {}) {
  const readMarker = dependencies.readReleaseMarker ?? readReleaseMarker;
  const readLedger = dependencies.readMigrationLedger ?? readMigrationLedger;
  const readCatalog = dependencies.readCatalogEvidence ?? readCatalogEvidence;
  const marker = await readMarker(LIVE_ROOT);
  const ledger = await readLedger(PROFILE.services.postgresDatabase, signal);
  const catalog = await readCatalog(PROFILE.services.postgresDatabase, signal, "stable");
  const head = ledger.at(-1)?.filename;
  if (typeof head !== "string") fail("CLOUD_DATA_MIGRATION_LEDGER_INVALID");
  return Object.freeze({
    codeSha: marker.git_sha,
    migration: Object.freeze({
      head,
      count: ledger.length,
      ledger_sha256: migrationLedgerDigest(ledger),
      catalog_sha256: catalog.sha256,
    }),
  });
}

export async function createDataProtectionDump(path, signal, dependencies = {}) {
  const openFile = dependencies.open ?? open;
  const inspect = dependencies.lstat ?? lstat;
  const identity = dependencies.identity ?? Object.freeze({ uid: 0, gid: 0 });
  let handle;
  try {
    handle = await openFile(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await (dependencies.runDump ?? runDataProtectionDumpProcess)(handle, signal);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
  const metadata = await inspect(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o7777) !== 0o600 ||
    metadata.size < 1
  ) {
    fail("CLOUD_DATA_DATABASE_INVALID");
  }
  return Object.freeze({
    file: "database.dump",
    bytes: metadata.size,
    sha256: await (dependencies.sha256File ?? sha256DataProtectionFile)(path),
  });
}

function shadowName(token) {
  const name = `laundry_data_drill_${token}`;
  if (!SHADOW.test(name)) fail("CLOUD_DATA_SHADOW_ID_INVALID");
  return name;
}

export function dataProtectionShadowDatabaseName(setId) {
  const token = createHash("sha256")
    .update(requireDataProtectionSetId(setId), "utf8")
    .digest("hex")
    .slice(0, 24);
  return shadowName(token);
}

async function defaultRestore(path, database, signal) {
  return await restorePrivateBackup(path, database, signal);
}

export async function drillDataProtectionSet(verified, signal, dependencies = {}) {
  const database =
    dependencies.token === undefined
      ? dataProtectionShadowDatabaseName(verified.manifest.set_id)
      : shadowName(dependencies.token());
  const command = dependencies.postgresCommand ?? postgresCommand;
  const restore = dependencies.restoreBackup ?? defaultRestore;
  const readLedger = dependencies.readMigrationLedger ?? readMigrationLedger;
  const readCatalog = dependencies.readCatalogEvidence ?? readCatalogEvidence;
  const readPhotos = dependencies.readPhotoInventory ?? readDataProtectionPhotoInventory;
  let createAttempted = false;
  let failure;
  let result;
  try {
    const collision = await command(
      "/usr/bin/psql",
      psqlArguments("postgres", `SELECT 1 FROM pg_database WHERE datname = '${database}'`),
      "CLOUD_DATA_SHADOW_COLLISION",
      signal,
      undefined,
      dependencies,
    );
    if (collision.stdout.trim() !== "") fail("CLOUD_DATA_SHADOW_COLLISION");
    createAttempted = true;
    await command(
      "/usr/bin/createdb",
      ["--template=template0", "--encoding=UTF8", "--owner=laundry_owner", database],
      "CLOUD_DATA_SHADOW_CREATE",
      signal,
      undefined,
      dependencies,
    );
    await restore(verified.dumpPath, database, signal);
    const ledger = await readLedger(database, signal);
    const catalog = await readCatalog(database, signal, "write_frozen");
    const photos = await readPhotos(database, signal);
    const ledgerSha256 = migrationLedgerDigest(ledger);
    const inventorySha256 = photoInventoryDigest(photos);
    if (
      ledgerSha256 !== verified.manifest.migration.ledger_sha256 ||
      catalog.sha256 !== verified.manifest.migration.catalog_sha256 ||
      inventorySha256 !== verified.manifest.photos.inventory_sha256 ||
      JSON.stringify(photos) !== JSON.stringify(verified.manifest.photos.files)
    ) {
      fail("CLOUD_DATA_SHADOW_MISMATCH");
    }
    result = Object.freeze({
      migrationLedgerSha256: ledgerSha256,
      catalogSha256: catalog.sha256,
      photoInventorySha256: inventorySha256,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (createAttempted) {
      try {
        await command(
          "/usr/bin/dropdb",
          ["--if-exists", "--force", database],
          "CLOUD_DATA_SHADOW_DROP",
          undefined,
          undefined,
          dependencies,
        );
      } catch (error) {
        fail("CLOUD_DATA_SHADOW_DROP_FAILED", error);
      }
    }
  }
  if (failure !== undefined) throw failure;
  return result;
}

export function dataProtectionVerificationFromDrill(verified, drill, completedAt) {
  return createDataProtectionVerification({
    set_id: verified.manifest.set_id,
    manifest_sha256: verified.manifestSha256,
    migration_ledger_sha256: drill.migrationLedgerSha256,
    catalog_sha256: drill.catalogSha256,
    photo_inventory_sha256: drill.photoInventorySha256,
    completed_at: completedAt,
  });
}
