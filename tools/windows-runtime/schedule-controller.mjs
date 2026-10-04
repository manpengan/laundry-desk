import { join } from "node:path";
import { exactKeys, fail } from "./companion-contract.mjs";
import { exists } from "./lifecycle-storage.mjs";

// Keep the maintenance controller retained even when the business program rolls back.
// Its fixed task always reads state.current before selecting database/program files.
export async function scheduleController(lifecycle, verb) {
  const path = join(lifecycle.root, "backup-task-controller.json");
  const record = (await exists(path)) ? JSON.parse(await lifecycle.io.read(path)) : null;
  if (
    record &&
    (!exactKeys(record, ["version", "digest"]) ||
      record.version !== 1 ||
      !(
        record.digest === null ||
        (typeof record.digest === "string" && /^[a-f0-9]{64}$/u.test(record.digest))
      ))
  )
    fail("BACKUP_TASK_CONTROLLER_INVALID");
  const state = lifecycle.getState();
  let entry = record?.digest ? state.releases.find((item) => item.digest === record.digest) : null;
  if (record?.digest && !entry) fail("BACKUP_TASK_CONTROLLER_INVALID");
  if (!entry && verb !== "register") return null;
  entry ??= state.current;
  const bound = await lifecycle.verify(entry);
  if (!bound.manifest.files.some((file) => file.path === "scripts/schedule-task.ps1"))
    fail("BACKUP_TASK_CONTROLLER_REQUIRED");
  if (!record?.digest)
    await lifecycle.io.write(path, JSON.stringify({ version: 1, digest: entry.digest }));
  return { ...lifecycle, entry, payload: bound.payload };
}

export async function managedScheduleTask(lifecycle, verb, config, nativeTask) {
  const controller = await scheduleController(lifecycle, verb);
  return controller ? nativeTask(controller, verb, config) : { exists: false };
}

export async function clearScheduleController(lifecycle) {
  await lifecycle.io.write(
    join(lifecycle.root, "backup-task-controller.json"),
    JSON.stringify({ version: 1, digest: null }),
  );
}
