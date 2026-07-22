/**
 * Process-local print job store (M2 skeleton).
 * Append-only list + legal status transitions (queued → printing → done|failed).
 */

import { randomUUID } from "node:crypto";

import type {
  EnqueuePrintJobInput,
  PrintJobRecord,
  PrintJobStatus,
  PrintJobStatusView,
  PrintJobStore,
} from "./types.js";

const TERMINAL: ReadonlySet<PrintJobStatus> = new Set(["done", "failed"]);

function toStatusView(job: PrintJobRecord): PrintJobStatusView {
  if (job.error !== undefined) {
    return Object.freeze({
      job_id: job.job_id,
      kind: job.kind,
      status: job.status,
      order_id: job.order_id,
      ticket_no: job.ticket_no,
      created_at: job.created_at,
      updated_at: job.updated_at,
      error: job.error,
    });
  }
  return Object.freeze({
    job_id: job.job_id,
    kind: job.kind,
    status: job.status,
    order_id: job.order_id,
    ticket_no: job.ticket_no,
    created_at: job.created_at,
    updated_at: job.updated_at,
  });
}

export class MemoryPrintJobStore implements PrintJobStore {
  private readonly jobs: PrintJobRecord[] = [];

  async enqueue(input: EnqueuePrintJobInput): Promise<PrintJobRecord> {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const job: PrintJobRecord = Object.freeze({
      job_id: input.job_id ?? randomUUID(),
      kind: input.kind,
      status: "queued" as const,
      order_id: input.order_id,
      ticket_no: input.ticket_no,
      created_at: now,
      updated_at: now,
    });
    this.jobs.push(job);
    return job;
  }

  async list(limit: number): Promise<readonly PrintJobStatusView[]> {
    const capped = Math.max(0, Math.min(limit, 50));
    const newestFirst = [...this.jobs].reverse().slice(0, capped);
    return Object.freeze(newestFirst.map((j) => toStatusView(j)));
  }

  async get(jobId: string): Promise<PrintJobRecord | null> {
    return this.jobs.find((j) => j.job_id === jobId) ?? null;
  }

  async transition(
    jobId: string,
    status: PrintJobStatus,
    options: Readonly<{ error?: string; now?: number }> = {},
  ): Promise<PrintJobRecord> {
    const index = this.jobs.findIndex((j) => j.job_id === jobId);
    if (index < 0) {
      throw new Error(`print job not found: ${jobId}`);
    }
    const current = this.jobs[index]!;
    if (TERMINAL.has(current.status)) {
      throw new Error(`print job ${jobId} is already terminal (${current.status})`);
    }
    if (status === "printing" && current.status !== "queued") {
      throw new Error(`cannot move ${current.status} → printing`);
    }
    if ((status === "done" || status === "failed") && current.status !== "printing") {
      throw new Error(`cannot move ${current.status} → ${status}`);
    }
    if (status === "queued") {
      throw new Error("cannot transition back to queued");
    }
    if (status === "failed" && (options.error === undefined || options.error.length === 0)) {
      throw new Error("failed jobs require non-empty error text");
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const next: PrintJobRecord =
      status === "failed"
        ? Object.freeze({
            job_id: current.job_id,
            kind: current.kind,
            status: "failed",
            order_id: current.order_id,
            ticket_no: current.ticket_no,
            created_at: current.created_at,
            updated_at: now,
            error: options.error as string,
          })
        : Object.freeze({
            job_id: current.job_id,
            kind: current.kind,
            status,
            order_id: current.order_id,
            ticket_no: current.ticket_no,
            created_at: current.created_at,
            updated_at: now,
          });

    this.jobs[index] = next;
    return next;
  }
}

export function createMemoryPrintJobStore(): PrintJobStore {
  return new MemoryPrintJobStore();
}
