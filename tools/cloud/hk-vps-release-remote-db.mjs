import { constants } from "node:fs";
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";

import { fail, sha256File } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import {
  CATALOG_SQL,
  assertBackupManifest,
  createBackupManifest,
  parseCatalogEvidence,
} from "./hk-vps-release-remote-db-evidence.mjs";
import { activateDatabaseWriteGate } from "./hk-vps-release-write-gate.mjs";
import {
  BACKUP_ROOT,
  assertBackupDirectory,
  assertMigrationLedger,
  assertPrivateBackupFile,
  backupManifestPath,
  createBackupPath,
  parseMigrationLedger,
  shadowDatabaseName,
} from "./hk-vps-release-remote-support.mjs";

const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});
const BACKUP_ANCESTORS = Object.freeze(["/var", "/var/lib"]);
const LEDGER_SQL =
  "SELECT filename || E'\\t' || checksum FROM public.laundry_schema_migrations ORDER BY filename";
export { applyMigrations, migrationExecutionRequest } from "./hk-vps-release-migration-client.mjs";
export { captureMigrationAuthority } from "./hk-vps-release-migration-authority.mjs";
export { MIGRATION_SCRIPT } from "./hk-vps-release-migration-script.mjs";

function commandOptions(label, signal, timeoutMs = 2 * 60_000) {
  return Object.freeze({ cwd: "/", environment: COMMAND_ENVIRONMENT, label, signal, timeoutMs });
}

async function postgresCommand(file, arguments_, label, signal, timeoutMs) {
  return await runCloudCommand(
    "/usr/bin/sudo",
    ["-u", "postgres", "--", file, ...arguments_],
    commandOptions(label, signal, timeoutMs),
  );
}

function psqlArguments(database, sql) {
  return ["--no-psqlrc", "--tuples-only", "--no-align", "--dbname", database, "--command", sql];
}

export async function readMigrationLedger(database, signal) {
  const result = await postgresCommand(
    "/usr/bin/psql",
    psqlArguments(database, LEDGER_SQL),
    "CLOUD_RELEASE_LEDGER_QUERY",
    signal,
  );
  return parseMigrationLedger(result.stdout);
}

export async function readCatalogEvidence(
  database,
  signal,
  clusterState = "write_frozen",
  dependencies = {},
) {
  const execute = dependencies.postgresCommand ?? postgresCommand;
  const parse = dependencies.parseCatalogEvidence ?? parseCatalogEvidence;
  const result = await execute(
    "/usr/bin/psql",
    psqlArguments(database, CATALOG_SQL),
    "CLOUD_RELEASE_CATALOG_QUERY",
    signal,
  );
  return parse(result.stdout, undefined, clusterState);
}

export async function freezeDatabaseWrites(signal, dependencies = {}) {
  const activateWriteGate = dependencies.activateWriteGate ?? activateDatabaseWriteGate;
  const readLedger = dependencies.readMigrationLedger ?? readMigrationLedger;
  const readCatalog = dependencies.readCatalogEvidence ?? readCatalogEvidence;
  const now = dependencies.now ?? (() => new Date());
  const freeze = await activateWriteGate(signal);
  const ledger = await readLedger("laundry_v2", signal);
  const catalog = await readCatalog("laundry_v2", signal, "write_frozen");
  return Object.freeze({ ...freeze, catalog, ledger, verifiedAt: now().toISOString() });
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function ensureBackupRoot(
  dependencies = Object.freeze({ chmod, chown, lstat, mkdir, realpath, postgresGid }),
  create = true,
) {
  const expectedGid = await dependencies.postgresGid();
  for (const path of BACKUP_ANCESTORS) {
    assertBackupDirectory(
      path,
      await dependencies.lstat(path).catch(() => null),
      await dependencies.realpath(path).catch(() => null),
      expectedGid,
    );
  }
  let metadata;
  try {
    metadata = await dependencies.lstat(BACKUP_ROOT);
  } catch (error) {
    if (!isMissing(error) || !create) fail("CLOUD_RELEASE_BACKUP_ROOT_INVALID", error);
    await dependencies.mkdir(BACKUP_ROOT, { mode: 0o700 });
    await dependencies.chown(BACKUP_ROOT, 0, expectedGid);
    await dependencies.chmod(BACKUP_ROOT, 0o710);
    metadata = await dependencies.lstat(BACKUP_ROOT).catch(() => null);
  }
  assertBackupDirectory(
    BACKUP_ROOT,
    metadata,
    await dependencies.realpath(BACKUP_ROOT).catch(() => null),
    expectedGid,
    true,
  );
}

async function postgresGid() {
  const result = await runCloudCommand(
    "/usr/bin/id",
    ["-g", "postgres"],
    commandOptions("CLOUD_RELEASE_POSTGRES_GID", undefined),
  );
  if (!/^\d+\n?$/u.test(result.stdout)) fail("CLOUD_RELEASE_POSTGRES_IDENTITY_INVALID");
  return Number(result.stdout.trim());
}

async function syncPath(path, directory = false) {
  const flag = directory ? constants.O_DIRECTORY : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | flag);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createDump(temporaryPath, signal, dependencies = {}) {
  const openFile = dependencies.open ?? open;
  const run = dependencies.runCloudCommand ?? runCloudCommand;
  const inspect = dependencies.lstat ?? lstat;
  const sync = dependencies.syncPath ?? syncPath;
  const handle = await openFile(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  await handle.close();
  let failure;
  try {
    await run(
      "/usr/bin/chown",
      ["postgres:postgres", temporaryPath],
      commandOptions("CLOUD_RELEASE_DUMP_HANDOFF", signal),
    );
    await run(
      "/usr/bin/sudo",
      [
        "-u",
        "postgres",
        "--",
        "/usr/bin/pg_dump",
        "--dbname=laundry_v2",
        "--format=custom",
        "--lock-wait-timeout=10s",
        `--file=${temporaryPath}`,
      ],
      commandOptions("CLOUD_RELEASE_DATABASE_DUMP", signal, 10 * 60_000),
    );
  } catch (error) {
    failure = error;
  }
  try {
    await run(
      "/usr/bin/chown",
      ["root:root", temporaryPath],
      commandOptions("CLOUD_RELEASE_DUMP_RECLAIM", undefined),
    );
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  const metadata = await inspect(temporaryPath).catch(() => null);
  assertPrivateBackupFile(metadata);
  await sync(temporaryPath);
  return metadata;
}

async function publishBackup(temporaryPath, finalPath) {
  await link(temporaryPath, finalPath);
  await unlink(temporaryPath);
  await syncPath(BACKUP_ROOT, true);
  const metadata = await lstat(finalPath).catch(() => null);
  assertPrivateBackupFile(metadata);
  return metadata;
}

async function publishManifest(path, manifest, token, replace = false) {
  const temporaryPath = `${path}.tmp-${token}`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (replace) await rename(temporaryPath, path);
    else {
      await link(temporaryPath, path);
      await unlink(temporaryPath);
    }
    await syncPath(BACKUP_ROOT, true);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    fail("CLOUD_RELEASE_BACKUP_MANIFEST_FAILED", error);
  }
}

async function drillBackup(backupPath, shadow, evidence, signal) {
  let createAttempted = false;
  let failure;
  let shadowCatalog;
  try {
    const collision = await postgresCommand(
      "/usr/bin/psql",
      psqlArguments("postgres", `SELECT 1 FROM pg_database WHERE datname = '${shadow}'`),
      "CLOUD_RELEASE_SHADOW_COLLISION",
      signal,
    );
    if (collision.stdout.trim() !== "") fail("CLOUD_RELEASE_SHADOW_COLLISION");
    createAttempted = true;
    await postgresCommand(
      "/usr/bin/createdb",
      ["--template=template0", "--encoding=UTF8", "--owner=laundry_owner", shadow],
      "CLOUD_RELEASE_SHADOW_CREATE",
      signal,
    );
    await postgresCommand(
      "/usr/bin/pg_restore",
      ["--dbname", shadow, "--exit-on-error", "--single-transaction", backupPath],
      "CLOUD_RELEASE_SHADOW_RESTORE",
      signal,
      10 * 60_000,
    );
    assertMigrationLedger(evidence.ledger, await readMigrationLedger(shadow, signal), "exact");
    shadowCatalog = await readCatalogEvidence(shadow, signal);
    if (shadowCatalog.sha256 !== evidence.catalog.sha256) {
      fail("CLOUD_RELEASE_SHADOW_CATALOG_MISMATCH");
    }
  } catch (error) {
    failure = error;
  } finally {
    if (createAttempted) {
      try {
        await postgresCommand(
          "/usr/bin/dropdb",
          ["--if-exists", "--force", shadow],
          "CLOUD_RELEASE_SHADOW_DROP",
          undefined,
        );
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure !== undefined) throw failure;
  return shadowCatalog;
}

export async function createVerifiedBackup(
  context,
  evidence,
  persistLocator,
  signal,
  dependencies = {},
) {
  const ensureRoot = dependencies.ensureBackupRoot ?? ensureBackupRoot;
  const createPath = dependencies.createBackupPath ?? createBackupPath;
  const dump = dependencies.createDump ?? createDump;
  const publish = dependencies.publishBackup ?? publishBackup;
  const digest = dependencies.sha256File ?? sha256File;
  const writeManifest = dependencies.publishManifest ?? publishManifest;
  const drill = dependencies.drillBackup ?? drillBackup;
  const remove = dependencies.unlink ?? unlink;
  const now = dependencies.now ?? (() => new Date());
  await ensureRoot();
  const backupPath = createPath(context.candidateSha);
  const temporaryPath = `${backupPath}.tmp-${context.token}`;
  const manifestPath = backupManifestPath(backupPath);
  let locatorPersistenceAttempted = false;
  let published = false;
  try {
    await dump(temporaryPath, signal);
    const metadata = await publish(temporaryPath, backupPath);
    published = true;
    const artifact = Object.freeze({
      bytes: metadata.size,
      path: backupPath,
      sha256: await digest(backupPath),
      shadow: shadowDatabaseName(backupPath),
    });
    const createdAt = now().toISOString();
    await writeManifest(
      manifestPath,
      createBackupManifest(context, evidence, artifact, null, createdAt),
      context.token,
    );
    locatorPersistenceAttempted = true;
    await persistLocator(artifact);
    const shadowCatalog = await drill(backupPath, artifact.shadow, evidence, signal);
    await writeManifest(
      manifestPath,
      createBackupManifest(context, evidence, artifact, shadowCatalog, createdAt),
      context.token,
      true,
    );
    return Object.freeze({ path: backupPath, sha256: artifact.sha256, shadow: artifact.shadow });
  } catch (error) {
    await remove(temporaryPath).catch(() => undefined);
    if (!locatorPersistenceAttempted && published) {
      await remove(manifestPath).catch(() => undefined);
      await remove(backupPath).catch(() => undefined);
    }
    if (locatorPersistenceAttempted) fail("CLOUD_RELEASE_BACKUP_RECOVERY_REQUIRED", error);
    throw error;
  }
}

export async function verifyBackupEvidence(record) {
  if (record.backup_path === null || record.backup_sha256 === null) {
    fail("CLOUD_RELEASE_BACKUP_EVIDENCE_INVALID");
  }
  await ensureBackupRoot(undefined, false);
  const backup = await lstat(record.backup_path).catch(() => null);
  const manifestPath = backupManifestPath(record.backup_path);
  const manifestMetadata = await lstat(manifestPath).catch(() => null);
  try {
    assertPrivateBackupFile(backup);
    assertPrivateBackupFile(manifestMetadata);
  } catch (error) {
    fail("CLOUD_RELEASE_BACKUP_EVIDENCE_INVALID", error);
  }
  if (
    manifestMetadata.size > 64 * 1024 ||
    (await realpath(record.backup_path).catch(() => null)) !== record.backup_path ||
    (await sha256File(record.backup_path)) !== record.backup_sha256
  ) {
    fail("CLOUD_RELEASE_BACKUP_EVIDENCE_INVALID");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail("CLOUD_RELEASE_BACKUP_EVIDENCE_INVALID", error);
  }
  assertBackupManifest(manifest, record, backup.size);
}
