import { drainNotificationQueue, type NotificationWorkerOptions } from "./delivery-worker.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_LIMIT = 10;

export type NotificationWorkerStatus = Readonly<{
  state: "running" | "stopped";
  worker_id: string;
  assurance: "software_only" | "external";
  processed_deliveries: number;
  attention_required: number;
  consecutive_failures: number;
  last_cycle_at: string | null;
  last_error_code: string | null;
}>;

export type NotificationWorkerController = Readonly<{
  start: () => void;
  stop: () => Promise<void>;
  runNow: () => Promise<void>;
  status: () => NotificationWorkerStatus;
}>;

export type NotificationWorkerFailureReport = Readonly<{
  code: "NOTIFICATION_WORKER_LOOP_FAILED";
  worker_id: string;
  org_id: string;
  store_id: string;
  error_type: string;
  consecutive_failures: number;
}>;

export type NotificationWorkerControllerOptions = NotificationWorkerOptions &
  Readonly<{
    pollIntervalMs?: number;
    batchLimit?: number;
    reportFailure?: (report: NotificationWorkerFailureReport) => void;
  }>;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  return value;
}

export function createNotificationWorkerController(
  options: NotificationWorkerControllerOptions,
): NotificationWorkerController {
  const pollInterval = positiveInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "notification poll interval",
  );
  const batchLimit = positiveInteger(
    options.batchLimit ?? DEFAULT_BATCH_LIMIT,
    "notification batch limit",
  );
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let snapshot: NotificationWorkerStatus = Object.freeze({
    state: "stopped",
    worker_id: options.workerId,
    assurance: options.provider.assurance,
    processed_deliveries: 0,
    attention_required: 0,
    consecutive_failures: 0,
    last_cycle_at: null,
    last_error_code: null,
  });

  const cycleTimestamp = (): string => {
    try {
      const now = options.now?.() ?? new Date();
      return Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  };
  const reportFailure = (error: unknown, consecutiveFailures: number): void => {
    const report: NotificationWorkerFailureReport = Object.freeze({
      code: "NOTIFICATION_WORKER_LOOP_FAILED",
      worker_id: options.workerId,
      org_id: options.tenant.orgId,
      store_id: options.tenant.storeId,
      error_type: error instanceof Error ? error.name : typeof error,
      consecutive_failures: consecutiveFailures,
    });
    try {
      if (options.reportFailure !== undefined) options.reportFailure(report);
      else process.stderr.write(`${JSON.stringify(report)}\n`);
    } catch {
      // The worker status remains observable even if the reporting sink is unavailable.
    }
  };

  const update = (changes: Partial<Omit<NotificationWorkerStatus, "state">>): void => {
    snapshot = Object.freeze({
      ...snapshot,
      ...changes,
      state: running ? "running" : "stopped",
    });
  };
  const cycle = async (): Promise<void> => {
    try {
      const outcomes = await drainNotificationQueue(options, batchLimit);
      const attention = outcomes.filter((outcome) => outcome.kind === "manual_required");
      update({
        processed_deliveries: snapshot.processed_deliveries + outcomes.length,
        attention_required: snapshot.attention_required + attention.length,
        consecutive_failures: 0,
        last_cycle_at: cycleTimestamp(),
        last_error_code: attention.at(-1)?.error_code ?? null,
      });
    } catch (error) {
      const consecutiveFailures = snapshot.consecutive_failures + 1;
      update({
        consecutive_failures: consecutiveFailures,
        last_cycle_at: cycleTimestamp(),
        last_error_code: "NOTIFICATION_WORKER_LOOP_FAILED",
      });
      reportFailure(error, consecutiveFailures);
    }
  };
  const schedule = (): void => {
    if (!running || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, pollInterval);
    timer.unref();
  };
  const execute = async (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    inFlight = cycle().finally(() => {
      inFlight = null;
      schedule();
    });
    return inFlight;
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
      if (timer !== null) clearTimeout(timer);
      timer = null;
      update({});
      if (inFlight !== null) await inFlight;
    },
    runNow: execute,
    status: () => snapshot,
  });
}
