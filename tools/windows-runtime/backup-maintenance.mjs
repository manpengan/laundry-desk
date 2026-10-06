import { join } from "node:path";
import { recordBackupHealth } from "./backup-health-record.mjs";
import { digest, fail, supportsBackup } from "./companion-contract.mjs";
import { MAX_BACKUPS, requireBackupOptions, requireMaintenance } from "./backup-contract.mjs";
import { databaseTools } from "./backup-database.mjs";
import { pgControl } from "./lifecycle-process.mjs";
import { runtimeEnvironment } from "./lifecycle-environment.mjs";
import { restorePhotos } from "./backup-photo-files.mjs";
import { resetRollbackAuthority } from "./restore-authority.mjs";
import {
  backupDirectories,
  backupSpace,
  backupSummary,
  createBackup,
  listBackups,
  readBackup,
  readMaintenance,
} from "./backup-files.mjs";

export async function backupMaintenance(action, options, lifecycle, dependencies = {}) {
  requireBackupOptions(action, options);
  const { root, io, platform, verify, getState, stop, start } = lifecycle;
  const state = getState();
  if (!["running", "stopped", "initialized"].includes(state.phase) || state.pending)
    fail("BACKUP_LIFECYCLE_STATE_INVALID");
  const entry = state.current;
  const { payload, manifest } = await verify(entry);
  const controller = await verify(state.controller);
  // A retained legacy login controller cannot enforce the new recovery gate.
  if (!supportsBackup(manifest) || !supportsBackup(controller.manifest))
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
  const getBackup = dependencies.readBackup ?? readBackup;
  const path = join(root, "maintenance.json");
  let journal = await readMaintenance(io, root);
  const save = async (value) => {
    if (value !== null) requireMaintenance(value);
    await io.write(path, JSON.stringify(value ?? { version: 1, phase: "idle" }));
    journal = value;
  };
  if (action === "backup-list")
    return {
      status: "backups",
      backups: await listBackups(context),
      assurance: "development_only",
    };
  if (action === "backup-verify")
    return {
      ...backupSummary(await getBackup(context, options.backupId)),
      assurance: "development_only",
    };
  if (journal && action !== "maintenance-recover") fail("MAINTENANCE_RECOVERY_REQUIRED");
  if (action === "maintenance-recover" && !journal)
    return { status: state.phase, maintenance: "idle", assurance: "development_only" };
  if (journal && JSON.stringify(journal.release) !== JSON.stringify(entry))
    fail("MAINTENANCE_RELEASE_MISMATCH");
  let target;
  if (action !== "maintenance-recover") {
    if (action === "restore" || action === "backup-drill")
      target = await getBackup(context, options.backupId, options.confirmation);
    await backupSpace(root);
    if ((await backupDirectories(root, io, platform)).length >= MAX_BACKUPS)
      fail("BACKUP_RETENTION_FULL");
    try {
      await save({
        version: 1,
        operation: action,
        phase: "quiescing",
        was_running: state.phase === "running",
        release: entry,
        target: target ? { id: target.id, digest: target.digest } : null,
        safety: null,
        candidate: null,
        ...(action === "restore" ? { authority_reset: false } : {}),
      });
    } catch (error) {
      // The durable record could already exist despite a lost write acknowledgement.
      await stop(entry);
      throw error;
    }
  }
  const wasRunning = journal.was_running;
  let result;
  try {
    await stop(entry);
    if (
      action === "maintenance-recover" &&
      journal.phase === "verified" &&
      journal.operation === "restore" &&
      journal.authority_reset !== true
    )
      fail("RESTORE_AUTHORITY_RECOVERY_REQUIRED");
    await control("start", root, payload, env);
    if (action === "maintenance-recover") {
      if (journal.phase === "verified")
        await getBackup(context, journal.safety.id, journal.safety.digest);
      const recovered =
        journal.phase === "verified"
          ? (await database.finish(journal.candidate), { committed: true, retained_shadow: false })
          : await database.recover(journal.candidate);
      await database.verify();
      result = { recovered: true, ...recovered, safety_backup: journal.safety };
    } else {
      await database.verify();
      await database.space();
      const point = await makeBackup(context, (file) => database.dump(file));
      await save({ ...journal, phase: "prepared", safety: { id: point.id, digest: point.digest } });
      if (action === "backup") result = backupSummary(point);
      else {
        await save({ ...journal, phase: "restoring", candidate: await database.candidate() });
        await save({ ...journal, candidate: await database.create(journal.candidate) });
        await database.restore(journal.candidate, target);
        if (action === "backup-drill") {
          await database.recover(journal.candidate);
          await database.verify();
          await control("stop", root, payload, env);
          await save(null);
          if (wasRunning) await start(entry);
          await recordBackupHealth(context, "backup-drill");
          return {
            status: getState().phase,
            drilled_backup: target.id,
            assurance: "development_only",
          };
        }
        await (dependencies.resetAuthority ?? resetRollbackAuthority)(
          context,
          journal.candidate.name,
        );
        await database.verify(journal.candidate.name, target.photos);
        await save({ ...journal, authority_reset: true });
        await restorePhotos(context, target);
        await save({ ...journal, phase: "switching" });
        await database.swap(journal.candidate);
        await database.verify();
        await getBackup(context, journal.safety.id, journal.safety.digest);
        await save({ ...journal, phase: "verified" });
        await database.finish(journal.candidate);
        result = {
          restored_backup: { id: target.id, digest: target.digest },
          safety_backup: journal.safety,
        };
      }
    }
    await control("stop", root, payload, env);
    // A verified record commits the data before cleanup. Startup never bypasses
    // a non-idle record, even if cleanup or acknowledgement was interrupted.
    await save(null);
  } catch (error) {
    // Keep the journal, source dump and safety point. A subsequent explicit recovery
    // resolves database identities; install/repair/login startup may not clear it.
    await stop(entry);
    throw error;
  }
  if (wasRunning) await start(entry);
  if (action === "backup") await recordBackupHealth(context, "backup");
  return { ...result, status: getState().phase, assurance: "development_only" };
}
