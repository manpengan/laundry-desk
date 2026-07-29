import type { FileSpool } from "./file-spool.js";
import type { PrintJobStore } from "./types.js";
import { drainPrintQueue } from "./worker.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_LIMIT = 10;

export type PrintWorkerStatus = Readonly<{
  state: "running" | "stopped";
  worker_id: string;
  processed_jobs: number;
  failed_jobs: number;
  last_cycle_at: number | null;
  last_error_code: string | null;
  spool_artifacts: number;
  spool_bytes: number;
}>;

export type PrintWorkerController = Readonly<{
  start: () => void;
  stop: () => Promise<void>;
  runNow: () => Promise<void>;
  status: () => PrintWorkerStatus;
}>;

export type PrintWorkerControllerOptions = Readonly<{
  store: PrintJobStore;
  spool: FileSpool;
  workerId: string;
  pollIntervalMs?: number;
  batchLimit?: number;
  now?: () => number;
}>;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/** Own the background loop so HTTP shutdown can stop it before closing PostgreSQL. */
export function createPrintWorkerController(
  options: PrintWorkerControllerOptions,
): PrintWorkerController {
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "print worker poll interval",
  );
  const batchLimit = positiveInteger(
    options.batchLimit ?? DEFAULT_BATCH_LIMIT,
    "print worker batch limit",
  );
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1_000));
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let snapshot: PrintWorkerStatus = Object.freeze({
    state: "stopped",
    worker_id: options.workerId,
    processed_jobs: 0,
    failed_jobs: 0,
    last_cycle_at: null,
    last_error_code: null,
    spool_artifacts: 0,
    spool_bytes: 0,
  });

  const update = (changes: Partial<Omit<PrintWorkerStatus, "state">>): void => {
    snapshot = Object.freeze({
      ...snapshot,
      ...changes,
      state: running ? "running" : "stopped",
    });
  };

  const runCycle = async (): Promise<void> => {
    try {
      await options.spool.sweep();
      const outcomes = await drainPrintQueue(
        {
          store: options.store,
          spool: options.spool,
          workerId: options.workerId,
          now,
        },
        batchLimit,
      );
      const printed = outcomes.filter((outcome) => outcome.kind === "printed").length;
      const failed = outcomes.filter((outcome) => outcome.kind === "failed");
      const after = await options.spool.sweep();
      update({
        processed_jobs: snapshot.processed_jobs + printed,
        failed_jobs: snapshot.failed_jobs + failed.length,
        last_cycle_at: now(),
        last_error_code:
          failed.length === 0 ? null : (failed.at(-1)?.error_code ?? "PRINT_WORKER_FAILED"),
        spool_artifacts: after.retained,
        spool_bytes: after.retained_bytes,
      });
    } catch {
      update({
        last_cycle_at: now(),
        last_error_code: "PRINT_WORKER_LOOP_FAILED",
      });
    }
  };

  const schedule = (): void => {
    if (!running || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, pollIntervalMs);
    timer.unref();
  };

  const execute = async (): Promise<void> => {
    if (inFlight !== null) return await inFlight;
    inFlight = runCycle().finally(() => {
      inFlight = null;
      schedule();
    });
    return await inFlight;
  };

  return Object.freeze({
    start(): void {
      if (running) return;
      running = true;
      update({});
      void execute();
    },
    async stop(): Promise<void> {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      update({});
      if (inFlight !== null) await inFlight;
    },
    runNow: execute,
    status: (): PrintWorkerStatus => snapshot,
  });
}
