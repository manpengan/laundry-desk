import { open } from "node:fs/promises";
import { join } from "node:path";
import { digest, fail } from "./companion-contract.mjs";
import { MAX_BACKUPS, requireMaintenance } from "./backup-contract.mjs";
import {
  backupDirectories,
  backupSpace,
  createBackup,
  readBackup,
  readMaintenance,
} from "./backup-files.mjs";
import { databaseTools } from "./backup-database.mjs";
import { inspectLivePhotos, snapshotPhotos, restorePhotoDirectory } from "./backup-photo-files.mjs";
import { pgControl } from "./lifecycle-process.mjs";
import { runtimeEnvironment } from "./lifecycle-environment.mjs";
import { requireDataOptions } from "./data-options.mjs";
import {
  privateOutput,
  withPortableStage,
  exportPortableContainer,
  importPortableContainer,
} from "./portable-container.mjs";
import { exportPortableDatabase, importPortableDatabase } from "./portable-database.mjs";
import { withDataClient, migratePortableShadow, runApprovedImport } from "./data-worker.mjs";
import { exportStore } from "./store-export.mjs";

export async function dataMaintenance(action, options, lifecycle, dependencies = {}) {
  requireDataOptions(action, options);
  const { root, io, platform, verify, getState, stop, start } = lifecycle;
  const state = getState(),
    entry = state.current;
  if (
    !["running", "stopped", "initialized"].includes(state.phase) ||
    state.pending ||
    (await readMaintenance(io, root))
  )
    fail("MAINTENANCE_RECOVERY_REQUIRED");
  const { payload, manifest } = await verify(entry);
  const controller = await verify(state.controller);
  if (
    ![manifest, controller.manifest].every((m) =>
      m.files.some((f) => f.path === "scripts/data-maintenance.mjs"),
    )
  )
    fail("BACKUP_CONTROLLER_UPGRADE_REQUIRED");
  const env = await (dependencies.runtimeEnvironment ?? runtimeEnvironment)(
    root,
    payload,
    manifest,
    io,
  );
  const context = {
    root,
    io,
    platform,
    payload,
    env,
    entry,
    instance: digest(await io.read(join(root, "secrets/access-token-secret"))),
    postgresVersion: manifest.sources.postgres.version,
  };
  const database = dependencies.database ?? databaseTools(context);
  const control = dependencies.pgControl ?? pgControl;
  const makeBackup = dependencies.createBackup ?? createBackup;
  const client = dependencies.withDataClient ?? withDataClient;
  const stage = dependencies.withPortableStage ?? withPortableStage;
  return stage(context, async (directory) => {
    const incoming =
      action === "portable-inspect" || action === "portable-import"
        ? await (dependencies.importPortableContainer ?? importPortableContainer)(
            context,
            directory,
            options.path,
            options.password,
            options.confirmation,
          )
        : null;
    if (
      incoming &&
      (incoming.manifest.release.migrations !== entry.migrations ||
        incoming.manifest.release.migrationHead !== entry.migrationHead ||
        incoming.manifest.postgres_version !== context.postgresVersion)
    )
      fail("PORTABLE_VERSION_MISMATCH");
    if (action === "portable-inspect")
      return {
        status: "portable_verified",
        sha256: incoming.sha256,
        bytes: incoming.size,
        created_at: incoming.manifest.created_at,
        photo_count: incoming.manifest.photos.length,
        migration_head: entry.migrationHead,
        assurance: "development_only",
      };
    await backupSpace(root);
    if ((await backupDirectories(root, io, platform)).length >= MAX_BACKUPS)
      fail("BACKUP_RETENTION_FULL");
    let journal = {
      version: 1,
      operation: action,
      phase: "quiescing",
      was_running: state.phase === "running",
      release: entry,
      target: null,
      safety: null,
      candidate: null,
    };
    const save = async (value) => {
      await io.write(
        join(root, "maintenance.json"),
        JSON.stringify(requireMaintenance(value) ?? { version: 1, phase: "idle" }),
      );
      journal = value;
    };
    let result;
    try {
      await save(journal);
      await stop(entry);
      await control("start", root, payload, env);
      await database.verify();
      await database.space();
      const point = await makeBackup(context, (file) => database.dump(file));
      await save({ ...journal, phase: "prepared", safety: { id: point.id, digest: point.digest } });
      if (action === "portable-export") {
        const inventory = await privateOutput(
          context,
          join(directory, "database.ndjson"),
          (output) =>
            client(context, "laundry_v2", (connection) =>
              exportPortableDatabase(connection, output, entry.migrations),
            ),
        );
        await snapshotPhotos(context, directory);
        const portable = {
          version: 1,
          created_at: new Date().toISOString(),
          release: entry,
          postgres_version: context.postgresVersion,
          database: inventory,
          photos: await inspectLivePhotos(context),
        };
        result = {
          status: "portable_exported",
          path: options.path,
          ...(await exportPortableContainer(
            context,
            directory,
            portable,
            options.path,
            options.password,
          )),
        };
      } else if (action === "export-store") {
        result = await (dependencies.exportStore ?? exportStore)(context, options);
        await database.verify();
      } else if (action === "v1-import") {
        result = await (dependencies.runApprovedImport ?? runApprovedImport)(
          context,
          options.requestId,
          async (scope, sourceSHA) => ({
            id: point.id,
            sourceSha256: sourceSHA,
            orgId: scope.orgId,
            storeId: scope.storeId,
            verified: true,
          }),
        );
        await database.verify();
      } else {
        await save({ ...journal, phase: "restoring", candidate: await database.candidate() });
        await save({ ...journal, candidate: await database.create(journal.candidate) });
        await (dependencies.migratePortableShadow ?? migratePortableShadow)(
          context,
          journal.candidate.name,
        );
        const input = await open(join(directory, "database.ndjson"), "r");
        try {
          await client(context, journal.candidate.name, (connection) =>
            (dependencies.importPortableDatabase ?? importPortableDatabase)(
              connection,
              input,
              { inventory: incoming.manifest.database, migrations: entry.migrations },
              journal.candidate.name,
            ),
          );
        } finally {
          await input.close();
        }
        await (dependencies.restorePhotoDirectory ?? restorePhotoDirectory)(
          context,
          directory,
          incoming.photoManifest,
        );
        await database.verify(journal.candidate.name, incoming.manifest.photos);
        await save({ ...journal, phase: "switching" });
        await database.swap(journal.candidate);
        await database.verify();
        await readBackup(context, point.id, point.digest);
        await save({ ...journal, phase: "verified" });
        await database.finish(journal.candidate);
        result = { status: "portable_restored", sha256: incoming.sha256 };
      }
      const safety = journal.safety;
      await control("stop", root, payload, env);
      await save({ version: 1, phase: "idle" });
      if (state.phase === "running") await start(entry);
      return { ...result, safety_backup: safety, assurance: "development_only" };
    } catch (error) {
      await stop(entry);
      throw error;
    }
  });
}
