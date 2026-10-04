import { join } from "node:path";
import { requireBackup } from "./backup-contract.mjs";
import { backupDirectories, readBackup, readMaintenance } from "./backup-files.mjs";
import { exists } from "./lifecycle-storage.mjs";
import { deleteVerifiedBackup, resumePruning } from "./schedule-prune.mjs";

export async function protectedBackupIds(context) {
  const journal = await readMaintenance(context.io, context.root);
  const ids = new Set(
    [journal?.target?.id, journal?.safety?.id, journal?.after?.id].filter(Boolean),
  );
  // Schema upgrade records bind program rollback to exact database snapshots.
  const path = join(context.root, "upgrade-history.json");
  if (await exists(path)) {
    const { requireUpgradeHistory } = await import("./upgrade-contract.mjs");
    for (const point of requireUpgradeHistory(JSON.parse(await context.io.read(path)))) {
      ids.add(point.before.id);
      ids.add(point.after.id);
    }
  }
  return ids;
}

export async function pruneBackups(context, config, keep = [], now = Date.now()) {
  const protectedIds = await protectedBackupIds(context);
  for (const id of keep) protectedIds.add(id);
  await resumePruning(context, protectedIds);
  const entries = [];
  for (const id of await backupDirectories(context.root, context.io, context.platform)) {
    const directory = join(context.root, "backups", id);
    if (!(await exists(join(directory, "backup.json")))) continue;
    const manifest = requireBackup(
      JSON.parse(await context.io.read(join(directory, "backup.json"))),
    );
    const item = await readBackup(
      { ...context, entry: manifest.release, postgresVersion: manifest.postgres_version },
      id,
    );
    entries.push(item);
  }
  entries.sort((a, b) => Date.parse(b.manifest.created_at) - Date.parse(a.manifest.created_at));
  const selected = entries.filter(
    (item, index) =>
      index >= 2 &&
      !protectedIds.has(item.id) &&
      (index >= config.retain_count ||
        now - Date.parse(item.manifest.created_at) > config.retain_days * 86400000),
  );
  for (const item of selected) await deleteVerifiedBackup(context, item, protectedIds);
  return { removed: selected.length, protected: protectedIds.size };
}
