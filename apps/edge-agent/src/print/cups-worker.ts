import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

const QUEUE_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const ARTIFACT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(?:xp58|dl206|gp3120)-[0-9]{4}\.txt$/u;
const HASH = /^[0-9a-f]{64}$/u;
const JOB_ID = /^[A-Za-z0-9_.-]{1,128}-\d+$/u;

const WorkerStateSchema = z
  .strictObject({
    version: z.literal(1),
    records: z
      .array(
        z.strictObject({
          artifact: z.string().regex(ARTIFACT_NAME),
          sha256: z.string().regex(HASH),
          state: z.enum(["submitting", "submitted"]),
          cups_job_id: z.string().regex(JOB_ID).nullable(),
          updated_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .max(2_000),
  })
  .superRefine((state, context) => {
    if (new Set(state.records.map((record) => record.artifact)).size !== state.records.length) {
      context.addIssue({ code: "custom", message: "CUPS worker artifacts must be unique" });
    }
  });

type ParsedWorkerState = z.output<typeof WorkerStateSchema>;
type WorkerState = Readonly<{
  version: 1;
  records: readonly Readonly<ParsedWorkerState["records"][number]>[];
}>;

export type CupsWorkerStatus = Readonly<{
  state: "disabled" | "idle" | "submitted" | "uncertain" | "failed";
  queue: string | null;
  artifact: string | null;
  cups_job_id: string | null;
  message: string;
}>;

export type CupsWorkerDependencies = Readonly<{
  discover: () => Promise<readonly string[]>;
  submit: (queue: string, bytes: Uint8Array) => Promise<string>;
  now?: () => number;
  platform?: NodeJS.Platform;
}>;

export type CupsWorkerOptions = Readonly<{
  queue: string;
  spoolRoot: string;
  stateRoot: string;
  pollIntervalMs?: number;
}>;

const EMPTY_STATE: WorkerState = Object.freeze({
  version: 1,
  records: Object.freeze([]),
});

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("CUPS worker path escaped its private root");
  }
}

async function canonicalDirectory(path: string, create: boolean): Promise<string> {
  if (!isAbsolute(path)) throw new Error("CUPS worker directories must be absolute");
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("CUPS worker directory must be a real directory");
  }
  return realpath(path);
}

async function readState(path: string): Promise<WorkerState> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    throw error;
  }
  if (bytes.byteLength > 512 * 1024) throw new Error("CUPS worker state is too large");
  const parsed = WorkerStateSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  return Object.freeze({
    version: 1,
    records: Object.freeze(parsed.records.map((record) => Object.freeze({ ...record }))),
  });
}

async function writeState(root: string, path: string, state: WorkerState): Promise<void> {
  const temp = join(root, ".cups-worker-state.staging");
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(WorkerStateSchema.parse(state))}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  const directory = await open(root, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceRecord(
  state: WorkerState,
  artifact: string,
  next: WorkerState["records"][number],
): WorkerState {
  return Object.freeze({
    version: 1 as const,
    records: Object.freeze([
      ...state.records.filter((record) => record.artifact !== artifact),
      Object.freeze(next),
    ]),
  });
}

async function reconcileSubmittedRecords(root: string, state: WorkerState): Promise<WorkerState> {
  const present = new Set((await readdir(root)).filter((name) => ARTIFACT_NAME.test(name)));
  return Object.freeze({
    version: 1 as const,
    records: Object.freeze(
      state.records.filter(
        (record) => record.state === "submitting" || present.has(record.artifact),
      ),
    ),
  });
}

async function nextArtifact(
  root: string,
  state: WorkerState,
): Promise<Readonly<{ name: string; bytes: Buffer }> | null> {
  const known = new Set(state.records.map((record) => record.artifact));
  const names = (await readdir(root)).filter((name) => ARTIFACT_NAME.test(name)).sort();
  for (const name of names) {
    if (known.has(name)) continue;
    const path = join(root, name);
    assertContained(root, path);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) continue;
    return Object.freeze({ name, bytes: await readFile(path) });
  }
  return null;
}

function status(
  state: CupsWorkerStatus["state"],
  queue: string | null,
  message: string,
  artifact: string | null = null,
  cupsJobId: string | null = null,
): CupsWorkerStatus {
  return Object.freeze({
    state,
    queue,
    artifact,
    cups_job_id: cupsJobId,
    message,
  });
}

export async function runCupsWorkerOnce(
  options: CupsWorkerOptions,
  dependencies: CupsWorkerDependencies,
): Promise<CupsWorkerStatus> {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return status("disabled", null, "CUPS worker requires macOS");
  }
  if (!QUEUE_NAME.test(options.queue)) return status("failed", null, "Invalid CUPS queue");
  try {
    const [spoolRoot, stateRoot, queues] = await Promise.all([
      canonicalDirectory(options.spoolRoot, false),
      canonicalDirectory(options.stateRoot, true),
      dependencies.discover(),
    ]);
    if (!queues.includes(options.queue)) {
      return status("failed", options.queue, "Configured CUPS queue is not installed");
    }
    const statePath = join(stateRoot, "cups-worker-state.json");
    assertContained(stateRoot, statePath);
    let current = await readState(statePath);
    const reconciled = await reconcileSubmittedRecords(spoolRoot, current);
    if (reconciled.records.length !== current.records.length) {
      await writeState(stateRoot, statePath, reconciled);
      current = reconciled;
    }
    const uncertain = current.records.find((record) => record.state === "submitting");
    if (uncertain !== undefined) {
      return status(
        "uncertain",
        options.queue,
        "Prior CUPS submission has an uncertain outcome; operator action required",
        uncertain.artifact,
      );
    }
    const artifact = await nextArtifact(spoolRoot, current);
    if (artifact === null) return status("idle", options.queue, "No unsubmitted print artifact");
    const digest = sha256(artifact.bytes);
    const now = dependencies.now?.() ?? Date.now();
    current = replaceRecord(current, artifact.name, {
      artifact: artifact.name,
      sha256: digest,
      state: "submitting",
      cups_job_id: null,
      updated_at: now,
    });
    await writeState(stateRoot, statePath, current);
    const jobId = await dependencies.submit(options.queue, artifact.bytes);
    if (!JOB_ID.test(jobId) || !jobId.startsWith(`${options.queue}-`)) {
      return status("uncertain", options.queue, "CUPS returned no trackable job id", artifact.name);
    }
    current = replaceRecord(current, artifact.name, {
      artifact: artifact.name,
      sha256: digest,
      state: "submitted",
      cups_job_id: jobId,
      updated_at: dependencies.now?.() ?? Date.now(),
    });
    await writeState(stateRoot, statePath, current);
    return status(
      "submitted",
      options.queue,
      "Print artifact submitted to CUPS",
      artifact.name,
      jobId,
    );
  } catch {
    return status("failed", options.queue, "CUPS worker failed closed");
  }
}

export type CupsWorkerController = Readonly<{
  start: () => Promise<CupsWorkerStatus>;
  stop: () => Promise<void>;
  getStatus: () => CupsWorkerStatus;
}>;

export function createCupsWorkerController(
  options: CupsWorkerOptions,
  dependencies: CupsWorkerDependencies,
): CupsWorkerController {
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<CupsWorkerStatus> | null = null;
  let latest = status("idle", options.queue, "CUPS worker has not started");

  const run = (): Promise<CupsWorkerStatus> => {
    if (active !== null) return active;
    active = runCupsWorkerOnce(options, dependencies)
      .then((result) => {
        latest = result;
        return result;
      })
      .finally(() => {
        active = null;
      });
    return active;
  };

  return Object.freeze({
    start: async () => {
      const first = await run();
      if (timer === null && first.state !== "failed" && first.state !== "uncertain") {
        timer = setInterval(() => void run(), options.pollIntervalMs ?? 2_000);
        timer.unref();
      }
      return first;
    },
    stop: async () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (active !== null) await active;
    },
    getStatus: () => latest,
  });
}
