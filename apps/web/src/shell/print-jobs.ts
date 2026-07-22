/**
 * Print job list helpers for TopBar indicator + queue panel.
 * Mirrors server print.jobs.list status views (no packages/* hard dep).
 */

import type { PrintJobSummary } from "@laundry/ui";
import type { QueryPort } from "../commands/types.js";
import { unwrapCommandResult } from "../pages/order-form.js";

export type PrintJobStatus = "queued" | "printing" | "done" | "failed";

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

const STATUS_SET: ReadonlySet<string> = new Set(["queued", "printing", "done", "failed"]);

const STATUS_LABELS: Readonly<Record<PrintJobStatus, string>> = Object.freeze({
  queued: "排队中",
  printing: "打印中",
  done: "已完成",
  failed: "失败",
});

export const PRINT_JOBS_POLL_MS = 5000;
export const PRINT_JOBS_LIST_LIMIT = 20;

export function printJobStatusLabel(status: string): string {
  if (STATUS_SET.has(status)) {
    return STATUS_LABELS[status as PrintJobStatus];
  }
  return status;
}

/** Badge counts: queued|printing → queued; failed → failed; done ignored. */
export function summarizePrintJobs(jobs: readonly Readonly<{ status: string }>[]): PrintJobSummary {
  let queued = 0;
  let failed = 0;
  for (const job of jobs) {
    if (job.status === "queued" || job.status === "printing") {
      queued += 1;
    } else if (job.status === "failed") {
      failed += 1;
    }
  }
  return Object.freeze({ queued, failed });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const payload = unwrapCommandResult<unknown>(data);
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    return Object.freeze([]);
  }
  const jobs: PrintJobView[] = [];
  for (const row of payload.jobs) {
    const job = parseJob(row);
    if (job !== null) jobs.push(job);
  }
  return Object.freeze(jobs);
}

/**
 * Load recent print jobs. Returns null on transport/query failure
 * so callers can keep the last summary (do not crash).
 */
export async function loadPrintJobs(
  queryClient: QueryPort,
  limit: number = PRINT_JOBS_LIST_LIMIT,
): Promise<readonly PrintJobView[] | null> {
  try {
    const res = await queryClient.execute("print.jobs.list", { limit });
    if (!res.ok) return null;
    return parsePrintJobsList(res.data);
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
