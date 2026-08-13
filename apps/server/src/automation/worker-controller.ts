import { runAutomationTick, type AutomationWorkerDeps } from "./worker.js";

const DEFAULT_INTERVAL_MS = 60_000;

export type AutomationWorkerStatus = Readonly<{
  state: "running" | "stopped";
  processed_policies: number;
  consecutive_failures: number;
  last_cycle_at: string | null;
  last_error_code: string | null;
}>;

export type AutomationWorkerController = Readonly<{
  start: () => void;
  stop: () => Promise<void>;
  runNow: () => Promise<void>;
  status: () => AutomationWorkerStatus;
}>;

export type AutomationWorkerControllerOptions = AutomationWorkerDeps &
  Readonly<{
    pollIntervalMs?: number;
    reportFailure?: (error: unknown) => void;
  }>;

export function createAutomationWorkerController(
  options: AutomationWorkerControllerOptions,
): AutomationWorkerController {
  const interval = options.pollIntervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1_000) {
    throw new TypeError("Automation poll interval must be at least one second");
  }
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let snapshot: AutomationWorkerStatus = Object.freeze({
    state: "stopped",
    processed_policies: 0,
    consecutive_failures: 0,
    last_cycle_at: null,
    last_error_code: null,
  });

  const update = (changes: Partial<Omit<AutomationWorkerStatus, "state">>): void => {
    snapshot = Object.freeze({ ...snapshot, ...changes, state: running ? "running" : "stopped" });
  };
  const schedule = (): void => {
    if (!running || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, interval);
    timer.unref();
  };
  const cycle = async (): Promise<void> => {
    try {
      const outcomes = await runAutomationTick(options);
      const lastFailure = [...outcomes].reverse().find((item) => item.error_code !== null);
      update({
        processed_policies: snapshot.processed_policies + outcomes.length,
        consecutive_failures: 0,
        last_cycle_at: options.now().toISOString(),
        last_error_code: lastFailure?.error_code ?? null,
      });
    } catch (error) {
      update({
        consecutive_failures: snapshot.consecutive_failures + 1,
        last_cycle_at: new Date().toISOString(),
        last_error_code: "AUTOMATION_WORKER_LOOP_FAILED",
      });
      options.reportFailure?.(error);
    }
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
