import { join } from "node:path";
import { fail } from "./companion-contract.mjs";
import { exists } from "./lifecycle-storage.mjs";
import { databaseTools } from "./backup-database.mjs";
import { backupSpace, createBackup, readBackup, readMaintenance } from "./backup-files.mjs";
import { restorePhotos } from "./backup-photo-files.mjs";
import { pgControl } from "./lifecycle-process.mjs";
import { migratePortableShadow } from "./data-worker.mjs";
import { upgradeContext, probeShadow } from "./upgrade-context.mjs";
import {
  requireMigrationExtension,
  requireUpgradeHistory,
  requireUpgradeJournal,
} from "./upgrade-contract.mjs";
import { scheduleConfiguration, scheduleTask } from "./schedule-maintenance.mjs";
import { managedScheduleTask } from "./schedule-controller.mjs";
import { resetRollbackAuthority } from "./restore-authority.mjs";

export async function upgradeHistory(context) {
  const path = join(context.root, "upgrade-history.json");
  return (await exists(path)) ? requireUpgradeHistory(JSON.parse(await context.io.read(path))) : [];
}
const bound = (backup) => ({ id: backup.id, digest: backup.digest });
async function stopTransition(lifecycle, old, incoming) {
  const stop = lifecycle.stopRaw ?? lifecycle.stop;
  const entries = [lifecycle.getState().current, old.entry, incoming.entry];
  let failure;
  for (const entry of entries.filter(
    (entry, index) => entries.findIndex((other) => other.digest === entry.digest) === index,
  )) {
    try {
      await stop(entry);
      return;
    } catch (error) {
      if (
        ![
          "WINDOWS_COMPANION_POSTGRES_PROCESS_CONFLICT",
          "WINDOWS_COMPANION_PROCESS_CONFLICT",
          "WINDOWS_COMPANION_SERVER_PROCESS_CONFLICT",
        ].includes(error.message)
      )
        throw error;
      failure = error;
    }
  }
  throw failure;
}
async function recordHistory(context, journal) {
  const previous = await upgradeHistory(context);
  const entries = previous.filter(
    (entry) =>
      entry.from.digest !== journal.release.digest || entry.to.digest !== journal.next.digest,
  );
  const next = requireUpgradeHistory([
    ...entries,
    { from: journal.release, to: journal.next, before: journal.safety, after: journal.after },
  ]);
  await context.io.write(join(context.root, "upgrade-history.json"), JSON.stringify(next));
}

export async function schemaMaintenance(action, next, lifecycle, dependencies = {}) {
  const state = lifecycle.getState();
  let journal = await readMaintenance(lifecycle.io, lifecycle.root);
  if (action === "maintenance-recover") {
    if (journal?.version !== 2) fail("UPGRADE_STATE_INVALID");
    requireUpgradeJournal(journal);
    next = journal.next;
  } else if (
    journal ||
    state.pending ||
    !["running", "stopped", "initialized"].includes(state.phase)
  )
    fail("MAINTENANCE_RECOVERY_REQUIRED");
  const context = dependencies.context ?? upgradeContext;
  const old = await context(lifecycle, journal?.release ?? state.current, dependencies);
  const incoming = await context(lifecycle, next, dependencies);
  const probeTools = [incoming, old].find((item) =>
    item.manifest.files.some((file) => file.path === "scripts/upgrade-probe.mjs"),
  );
  if (!probeTools && !dependencies.probe) fail("UPGRADE_CONTROLLER_REQUIRED");
  if (old.postgresVersion !== incoming.postgresVersion) fail("UPGRADE_POSTGRES_VERSION_INVALID");
  const database = (dependencies.database ?? databaseTools)(old);
  const targetDatabase = (dependencies.database ?? databaseTools)(incoming);
  const control = dependencies.pgControl ?? pgControl;
  const get = dependencies.readBackup ?? readBackup;
  const make = dependencies.createBackup ?? createBackup;
  const task = (verb, config) =>
    managedScheduleTask(lifecycle, verb, config, dependencies.scheduleTask ?? scheduleTask);
  const config = await scheduleConfiguration(lifecycle);
  let mutationAttempted = journal !== null;
  const save = async (value) => {
    mutationAttempted = true;
    await lifecycle.io.write(
      join(lifecycle.root, "maintenance.json"),
      JSON.stringify(value ? requireUpgradeJournal(value) : { version: 1, phase: "idle" }),
    );
    journal = value;
  };
  const stop = () => stopTransition(lifecycle, old, incoming);
  try {
    if (action === "maintenance-recover") {
      await stop();
      const committed = journal.phase === "verified";
      const active = committed ? incoming : old;
      await control("start", lifecycle.root, active.payload, active.env);
      if (committed) {
        await get(old, journal.safety.id, journal.safety.digest);
        await get(incoming, journal.after.id, journal.after.digest);
        await targetDatabase.finish(journal.candidate);
        await recordHistory(lifecycle, journal);
      } else {
        await database.recover(journal.candidate);
        await database.verify();
        await lifecycle.saveState({ ...journal.old_state, phase: "stopped" });
      }
      await control("stop", lifecycle.root, active.payload, active.env);
      if (config.enabled) await task("register", config);
      const resume = journal.was_running;
      await save(null);
      if (resume) await lifecycle.start(active.entry);
      return {
        status: lifecycle.getState().phase,
        recovered: true,
        committed,
        assurance: "development_only",
      };
    }
    let target;
    if (action === "upgrade") requireMigrationExtension(old.manifest, incoming.manifest);
    else {
      const history = await upgradeHistory(lifecycle);
      const point = history.findLast(
        (entry) =>
          entry.to.digest === old.entry.digest && entry.from.digest === incoming.entry.digest,
      );
      if (!point) fail("SCHEMA_ROLLBACK_UNAVAILABLE");
      target = await get(incoming, point.before.id, point.before.digest);
    }
    if ((await upgradeHistory(lifecycle)).length >= 15) fail("UPGRADE_HISTORY_FULL");
    await (dependencies.backupSpace ?? backupSpace)(lifecycle.root);
    await save({
      version: 2,
      operation: action === "upgrade" ? "schema-upgrade" : "schema-rollback",
      phase: "quiescing",
      was_running: state.phase === "running",
      release: old.entry,
      next,
      safety: null,
      target: target ? bound(target) : null,
      candidate: null,
      old_state: state,
      after: null,
    });
    if (config.enabled) await task("remove", config);
    await stop();
    await control("start", lifecycle.root, old.payload, old.env);
    await database.verify();
    await database.space();
    const before = await make(old, (file) => database.dump(file));
    await save({ ...journal, phase: "prepared", safety: bound(before) });
    const source = target ?? before;
    await save({ ...journal, phase: "restoring", candidate: await database.candidate() });
    await save({ ...journal, candidate: await database.create(journal.candidate) });
    await (action === "upgrade" ? database : targetDatabase).restore(journal.candidate, source);
    if (action === "upgrade") {
      await save({ ...journal, phase: "migrating" });
      await (dependencies.migrate ?? migratePortableShadow)(incoming, journal.candidate.name);
    } else
      await (dependencies.resetAuthority ?? resetRollbackAuthority)(
        incoming,
        journal.candidate.name,
      );
    await targetDatabase.verify(journal.candidate.name, source.photos);
    await (dependencies.probe ?? probeShadow)(
      { ...incoming, toolsPayload: probeTools?.payload },
      journal.candidate.name,
      source,
    );
    await (dependencies.restorePhotos ?? restorePhotos)(incoming, source);
    await save({ ...journal, phase: "switching" });
    await database.swap(journal.candidate);
    await targetDatabase.verify();
    const after = await make(incoming, (file) => targetDatabase.dump(file));
    await save({ ...journal, phase: "program", after: bound(after) });
    await get(old, before.id, before.digest);
    await get(incoming, after.id, after.digest);
    await control("stop", lifecycle.root, old.payload, old.env);
    await lifecycle.saveState({
      ...lifecycle.getState(),
      current: next,
      previous: old.entry,
      pending: null,
      phase: "stopped",
    });
    await save({ ...journal, phase: "verified" });
    await recordHistory(lifecycle, journal);
    await control("start", lifecycle.root, incoming.payload, incoming.env);
    await targetDatabase.finish(journal.candidate);
    await control("stop", lifecycle.root, incoming.payload, incoming.env);
    if (config.enabled) await task("register", config);
    const resume = journal.was_running,
      safety = journal.safety;
    await save(null);
    if (resume) await lifecycle.start(next);
    return {
      status: lifecycle.getState().phase,
      schema_transition: action,
      safety_backup: safety,
      source_git_sha: next.source,
      migration_head: next.migrationHead,
      assurance: "development_only",
    };
  } catch (error) {
    if (mutationAttempted) await stop();
    throw error;
  }
}
