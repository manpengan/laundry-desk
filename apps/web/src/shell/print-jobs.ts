/**
 * Print job list helpers for TopBar indicator + queue panel.
 * Mirrors server print.jobs.list status views (no packages/* hard dep).
 */

import type { PrintJobSummary } from "@laundry/ui";
import type { QueryPort } from "../commands/types.js";
import { unwrapCommandResult } from "../pages/order-form.js";

export type PrintJobStatus = "queued" | "printing" | "done" | "failed" | "uncertain";

export type PrintJobView = Readonly<{
  job_id: string;
  kind: string;
  status: PrintJobStatus;
  order_id: string;
  ticket_no: string;
  created_at: number;
  updated_at: number;
  error?: string;
}>;

export type PrintJobsListResult = Readonly<{
  jobs: readonly PrintJobView[];
}>;

export type PrintWorkerView = Readonly<{
  state: "running" | "stopped";
  worker_id: string;
  processed_jobs: number;
  failed_jobs: number;
  last_cycle_at: number | null;
  last_error_code: string | null;
  spool_artifacts: number;
  spool_bytes: number;
}>;

export type PrintQueueView = Readonly<{
  jobs: readonly PrintJobView[];
  worker?: PrintWorkerView;
}>;

const STATUS_SET: ReadonlySet<string> = new Set([
  "queued",
  "printing",
  "done",
  "failed",
  "uncertain",
]);

const STATUS_LABELS: Readonly<Record<PrintJobStatus, string>> = Object.freeze({
  queued: "排队中",
  printing: "打印中",
  done: "已完成",
  failed: "失败",
  uncertain: "结果不确定",
});

export const PRINT_JOBS_POLL_MS = 5000;
export const PRINT_JOBS_LIST_LIMIT = 20;

export function printJobStatusLabel(status: string): string {
  if (STATUS_SET.has(status)) {
    return STATUS_LABELS[status as PrintJobStatus];
  }
  return status;
}

/** Badge counts: queued|printing → queued; failed|uncertain → attention; done ignored. */
export function summarizePrintJobs(jobs: readonly Readonly<{ status: string }>[]): PrintJobSummary {
  let queued = 0;
  let failed = 0;
  for (const job of jobs) {
    if (job.status === "queued" || job.status === "printing") {
      queued += 1;
    } else if (job.status === "failed" || job.status === "uncertain") {
      failed += 1;
    }
  }
  return Object.freeze({ queued, failed });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseWorker(raw: unknown): PrintWorkerView | null {
  const keys = [
    "state",
    "worker_id",
    "processed_jobs",
    "failed_jobs",
    "last_cycle_at",
    "last_error_code",
    "spool_artifacts",
    "spool_bytes",
  ] as const;
  if (!isRecord(raw) || !hasExactKeys(raw, keys)) return null;
  if (
    (raw.state !== "running" && raw.state !== "stopped") ||
    typeof raw.worker_id !== "string" ||
    raw.worker_id.length < 1 ||
    !isNonNegativeInteger(raw.processed_jobs) ||
    !isNonNegativeInteger(raw.failed_jobs) ||
    (raw.last_cycle_at !== null && !isNonNegativeInteger(raw.last_cycle_at)) ||
    (raw.last_error_code !== null && typeof raw.last_error_code !== "string") ||
    !isNonNegativeInteger(raw.spool_artifacts) ||
    !isNonNegativeInteger(raw.spool_bytes)
  ) {
    return null;
  }
  return Object.freeze({
    state: raw.state,
    worker_id: raw.worker_id,
    processed_jobs: raw.processed_jobs,
    failed_jobs: raw.failed_jobs,
    last_cycle_at: raw.last_cycle_at,
    last_error_code: raw.last_error_code,
    spool_artifacts: raw.spool_artifacts,
    spool_bytes: raw.spool_bytes,
  });
}

function parseJob(raw: unknown): PrintJobView | null {
  if (!isRecord(raw)) return null;
  const status = raw.status;
  if (typeof status !== "string" || !STATUS_SET.has(status)) return null;
  if (typeof raw.job_id !== "string" || raw.job_id.length === 0) return null;
  if (typeof raw.ticket_no !== "string") return null;
  if (typeof raw.order_id !== "string") return null;
  if (typeof raw.kind !== "string") return null;
  if (typeof raw.created_at !== "number" || typeof raw.updated_at !== "number") return null;
  const error = typeof raw.error === "string" ? raw.error : undefined;
  return Object.freeze({
    job_id: raw.job_id,
    kind: raw.kind,
    status: status as PrintJobStatus,
    order_id: raw.order_id,
    ticket_no: raw.ticket_no,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    ...(error !== undefined ? { error } : {}),
  });
}

/** Parse bus envelope / bare `{ jobs }` into status views; drops malformed rows. */
export function parsePrintJobsList(data: unknown): readonly PrintJobView[] {
  return parsePrintQueue(data)?.jobs ?? Object.freeze([]);
}

export function parsePrintQueue(data: unknown): PrintQueueView | null {
  const payload = unwrapCommandResult<unknown>(data);
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    return null;
  }
  const jobs: PrintJobView[] = [];
  for (const row of payload.jobs) {
    const job = parseJob(row);
    if (job !== null) jobs.push(job);
  }
  if (payload.worker === undefined) return Object.freeze({ jobs: Object.freeze(jobs) });
  const worker = parseWorker(payload.worker);
  return worker === null ? null : Object.freeze({ jobs: Object.freeze(jobs), worker });
}

/**
 * Load recent print jobs. Returns null on transport/query failure
 * so callers can keep the last summary (do not crash).
 */
export async function loadPrintJobs(
  queryClient: QueryPort,
  limit: number = PRINT_JOBS_LIST_LIMIT,
): Promise<readonly PrintJobView[] | null> {
  const queue = await loadPrintQueue(queryClient, limit);
  return queue?.jobs ?? null;
}

export async function loadPrintQueue(
  queryClient: QueryPort,
  limit: number = PRINT_JOBS_LIST_LIMIT,
): Promise<PrintQueueView | null> {
  try {
    const res = await queryClient.execute("print.jobs.list", { limit });
    if (!res.ok) return null;
    return parsePrintQueue(res.data);
  } catch {
    return null;
  }
}

export async function loadPrintJobSummary(
  queryClient: QueryPort,
  limit: number = PRINT_JOBS_LIST_LIMIT,
): Promise<PrintJobSummary | null> {
  const jobs = await loadPrintJobs(queryClient, limit);
  if (jobs === null) return null;
  return summarizePrintJobs(jobs);
}
