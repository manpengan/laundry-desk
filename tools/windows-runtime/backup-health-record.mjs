import { join } from "node:path";
import { exactKeys, fail } from "./companion-contract.mjs";
import { exists } from "./lifecycle-storage.mjs";
export async function readBackupHealthRecord(context) {
  const path = join(context.root, "backup-manual-health.json");
  if (!(await exists(path))) return { last_backup_at: null, last_drill_at: null };
  const value = JSON.parse(await context.io.read(path));
  if (
    !exactKeys(value, ["last_backup_at", "last_drill_at"]) ||
    Object.values(value).some(
      (at) =>
        at !== null &&
        (typeof at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(at) ||
          !Number.isFinite(Date.parse(at))),
    )
  )
    fail("BACKUP_HISTORY_INVALID");
  return value;
}
export async function recordBackupHealth(context, kind, now = Date.now()) {
  if (!["backup", "backup-drill"].includes(kind)) fail("BACKUP_HISTORY_INVALID");
  const previous = await readBackupHealthRecord(context);
  const at = new Date(now).toISOString();
  await context.io.write(
    join(context.root, "backup-manual-health.json"),
    JSON.stringify({
      ...previous,
      last_backup_at: at,
      ...(kind === "backup-drill" ? { last_drill_at: at } : {}),
    }),
  );
}
