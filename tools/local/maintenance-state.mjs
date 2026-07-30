import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { BACKUP_NAME, LocalDataError } from "./data-tools.mjs";
import { verifyDisasterRecoveryBackup } from "./disaster-recovery.mjs";

const STATE_NAME = "maintenance-state.json";
const LOCK_NAME = ".maintenance.lock";
const FILE_MODE = 0o600;
const DEFAULT_MAX_AGE_SECONDS = 26 * 60 * 60;
const BACKUP_TIMESTAMP =
  /^laundry-v2-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}\.dump$/u;

const fail = (code, cause) => {
  throw new LocalDataError(code, cause === undefined ? undefined : { cause });
};

function contained(rootPath, candidatePath) {
  const path = relative(rootPath, candidatePath);
  return path !== "" && !path.startsWith("..") && !path.startsWith("/");
}

function timestampFromName(name) {
  const match = BACKUP_TIMESTAMP.exec(name);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function sha256File(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", rejectHash);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function readStateFile(backupDirectory) {
  const path = join(backupDirectory, STATE_NAME);
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null) return null;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > 32_768 ||
    (metadata.mode & 0o7777) !== FILE_MODE
  ) {
    fail("LOCAL_MAINTENANCE_STATE_INVALID");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("LOCAL_MAINTENANCE_STATE_INVALID", error);
  }
  if (parsed?.version !== 1 || typeof parsed.updated_at !== "string") {
    fail("LOCAL_MAINTENANCE_STATE_INVALID");
  }
  return parsed;
}

export async function updateMaintenanceState(
  backupDirectory,
  patch,
  dependencies = Object.freeze({ now: () => new Date(), randomUUID, open, rename, unlink }),
) {
  const current = (await readStateFile(backupDirectory)) ?? {
    version: 1,
    last_backup: null,
    last_drill: null,
    last_failure: null,
  };
  const next = Object.freeze({
    ...current,
    ...patch,
    version: 1,
    updated_at: dependencies.now().toISOString(),
  });
  const temporary = join(
    backupDirectory,
    `.${STATE_NAME}.${dependencies.randomUUID().replaceAll("-", "")}.tmp`,
  );
  const handle = await dependencies.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await dependencies.rename(temporary, join(backupDirectory, STATE_NAME));
  } catch (error) {
    await dependencies.unlink(temporary).catch(() => undefined);
    fail("LOCAL_MAINTENANCE_STATE_WRITE_FAILED", error);
  }
  return next;
}

export async function withMaintenanceLock(
  backupDirectory,
  operation,
  callback,
  dependencies = Object.freeze({ now: () => new Date(), open, unlink }),
) {
  const lockPath = join(backupDirectory, LOCK_NAME);
  let handle;
  try {
    handle = await dependencies.open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      FILE_MODE,
    );
    await handle.writeFile(
      `${JSON.stringify({ version: 1, operation, started_at: dependencies.now().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle !== undefined) {
      await dependencies.unlink(lockPath).catch(() => undefined);
    }
    fail("LOCAL_MAINTENANCE_BUSY", error);
  }
  try {
    return await callback();
  } finally {
    await handle.close();
    await dependencies.unlink(lockPath).catch(() => undefined);
  }
}

export async function listRecoverySets(context) {
  const names = await readdir(context.backupDirectory);
  const dumps = names.filter(
    (name) => BACKUP_NAME.test(name) && name.startsWith("laundry-v2-backup-"),
  );
  const sets = [];
  for (const name of dumps) {
    const createdAt = timestampFromName(name);
    if (createdAt === null) continue;
    const path = join(context.backupDirectory, name);
    const bundlePath = `${path}.bundle.json`;
    try {
      const sha256 = await sha256File(bundlePath);
      const verified = await verifyDisasterRecoveryBackup(context, path, sha256);
      sets.push(Object.freeze({ name, path, created_at_ms: createdAt, sha256, verified }));
    } catch {
      sets.push(
        Object.freeze({
          name,
          path,
          created_at_ms: createdAt,
          sha256: null,
          verified: null,
        }),
      );
    }
  }
  return Object.freeze(sets.sort((left, right) => right.created_at_ms - left.created_at_ms));
}

function removalPaths(context, set) {
  const snapshot = `${set.path}.photos`;
  const paths = Object.freeze([set.path, `${set.path}.json`, `${set.path}.bundle.json`, snapshot]);
  if (
    paths.some(
      (path) =>
        !contained(context.backupDirectory, resolve(path)) ||
        dirname(resolve(path)) !== context.backupDirectory,
    ) ||
    basename(snapshot) !== `${set.name}.photos`
  ) {
    fail("LOCAL_RETENTION_PATH_INVALID");
  }
  return paths;
}

export async function rotateRecoverySets(
  context,
  sets,
  options,
  dependencies = Object.freeze({ lstat, rm }),
) {
  const nowMs = options.now.getTime();
  const maxAgeMs = options.retentionDays * 24 * 60 * 60 * 1000;
  const verifiedSets = sets.filter((set) => set.verified !== null);
  const candidates = verifiedSets.filter(
    (set, index) =>
      index > 0 && (index >= options.maxBackups || nowMs - set.created_at_ms > maxAgeMs),
  );
  if (options.apply) {
    for (const set of candidates) {
      for (const path of removalPaths(context, set)) {
        const metadata = await dependencies.lstat(path).catch(() => null);
        if (metadata === null) continue;
        if (metadata.isSymbolicLink()) fail("LOCAL_RETENTION_PATH_INVALID");
        await dependencies.rm(path, { recursive: metadata.isDirectory(), force: false });
      }
    }
  }
  return Object.freeze({
    mode: options.apply ? "applied" : "dry-run",
    retained: sets.length - candidates.length,
    candidates: Object.freeze(candidates.map((set) => set.name)),
    corrupt: Object.freeze(sets.filter((set) => set.verified === null).map((set) => set.name)),
  });
}

export async function inspectMaintenanceHealth(
  backupDirectory,
  options = Object.freeze({ now: new Date(), maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS }),
) {
  let state;
  try {
    state = await readStateFile(backupDirectory);
  } catch {
    return Object.freeze({ ok: false, status: "state_invalid" });
  }
  if (state === null || typeof state.last_backup?.completed_at !== "string") {
    return Object.freeze({ ok: false, status: "missing" });
  }
  const completedAt = Date.parse(state.last_backup.completed_at);
  if (!Number.isFinite(completedAt)) {
    return Object.freeze({ ok: false, status: "state_invalid" });
  }
  const ageSeconds = Math.max(0, Math.floor((options.now.getTime() - completedAt) / 1000));
  const stale = ageSeconds > options.maxAgeSeconds;
  const failed = state.last_failure !== null;
  return Object.freeze({
    ok: !stale && !failed,
    status: failed ? "failed" : stale ? "stale" : "healthy",
    age_seconds: ageSeconds,
    last_backup_at: state.last_backup.completed_at,
    last_drill_at:
      typeof state.last_drill?.completed_at === "string" ? state.last_drill.completed_at : null,
  });
}
