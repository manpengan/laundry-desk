import { opendir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { release as osRelease } from "node:os";
import { BACKUP_ID, MAX_BACKUPS, requireBackup } from "./backup-contract.mjs";
import { readMaintenance } from "./backup-files.mjs";
import { exists, requireState } from "./lifecycle-storage.mjs";

// Export a closed projection. Never copy logs, environment, database rows or exception text.
async function section(collect) {
  try {
    return { status: "available", data: await collect() };
  } catch {
    return { status: "unavailable" };
  }
}

async function backupSummary({ root, io, platform }) {
  const base = join(root, "backups");
  if (!(await exists(base))) return { count: 0, metadata_valid: 0, incomplete: 0 };
  await platform.inspectPrivateDirectory(base);
  const directory = await opendir(base);
  let count = 0;
  let valid = 0;
  for await (const entry of directory) {
    if (++count > MAX_BACKUPS || !BACKUP_ID.test(entry.name)) throw new Error("BACKUP_SET_INVALID");
    const item = join(base, entry.name);
    await platform.inspectPrivateDirectory(item);
    try {
      const manifest = requireBackup(JSON.parse(await io.read(join(item, "backup.json"))));
      if (manifest.id === entry.name) valid++;
    } catch {
      // An incomplete or invalid manifest is counted, never copied to the bundle.
    }
  }
  return { count, metadata_valid: valid, incomplete: count - valid };
}

async function maintenanceSummary(context) {
  const value = await readMaintenance(context.io, context.root);
  return value
    ? {
        operation: value.operation,
        phase: value.phase,
        safety_backup_present: value.safety !== null,
      }
    : { phase: "idle" };
}

async function serviceSummary(probe) {
  const value = await probe();
  if (!value || [value.api, value.postgres, value.task].some((item) => typeof item !== "boolean"))
    throw new Error("DIAGNOSTIC_PROBE_INVALID");
  return { api_port_open: value.api, postgres_port_open: value.postgres, task_present: value.task };
}

function version(value) {
  return typeof value === "string" && /^\d+(?:\.\d+){1,3}$/u.test(value) && value.length <= 32
    ? value
    : "unknown";
}

export async function collectDiagnosticBundle(context) {
  const state = requireState(context.state);
  const [maintenance, backups, services, disk] = await Promise.all([
    section(() => maintenanceSummary(context)),
    section(() => backupSummary(context)),
    section(() => serviceSummary(context.probe)),
    section(async () => {
      const space = await statfs(context.root, { bigint: true });
      const free = space.bavail * space.bsize;
      return { free_mib: Number(free / 1048576n), low_space: free < 2n * 1024n ** 3n };
    }),
  ]);
  return {
    schema: "laundry.windows.diagnostics",
    version: 1,
    assurance: "development_only",
    generated_at: new Date().toISOString(),
    system: {
      platform: "win32",
      arch: "x64",
      kernel: version(osRelease()),
      node: version(process.versions.node),
    },
    runtime: {
      phase: state.phase,
      current: { ...state.current },
      previous: state.previous ? { ...state.previous } : null,
      pending_update: state.pending !== null,
      release_count: state.releases.length,
    },
    services,
    maintenance,
    backups,
    disk,
    privacy: {
      policy: "allowlisted_metadata_only",
      customer_data: "excluded",
      credentials: "excluded",
      machine_identity: "excluded",
      raw_logs: "excluded",
      printer_diagnostics: "deferred",
    },
  };
}
