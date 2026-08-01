/**
 * Process-local print job store (M2).
 * Append-only list + legal status transitions (queued → printing → done|failed|uncertain).
 */

import { randomUUID } from "node:crypto";

import { PrintSnapshotSchema, type PrintSnapshot } from "@laundry/contracts";

import type {
  EnqueuePrintJobInput,
  EnqueueOrderPrintJobInput,
  PrintJobRecord,
  PrintJobStatus,
  PrintJobStatusView,
  PrintJobStore,
  RequeuePrintJobInput,
  TransitionPrintJobOptions,
} from "./types.js";

const TERMINAL: ReadonlySet<PrintJobStatus> = new Set(["done", "failed", "uncertain"]);

export type MemoryPrintJobStoreOptions = Readonly<{
  loadSnapshot?: (orderId: string) => Promise<PrintSnapshot | null>;
}>;

function toStatusView(job: PrintJobRecord): PrintJobStatusView {
  return Object.freeze({
    job_id: job.job_id,
    kind: job.kind,
    status: job.status,
    order_id: job.order_id,
    ticket_no: job.ticket_no,
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.payload_bytes !== undefined ? { payload_bytes: job.payload_bytes } : {}),
  });
}

function assertLegalTransition(current: PrintJobStatus, next: PrintJobStatus, jobId: string): void {
  if (TERMINAL.has(current)) {
    throw new Error(`print job ${jobId} is already terminal (${current})`);
  }
  if (next === "printing" && current !== "queued") {
    throw new Error(`cannot move ${current} → printing`);
  }
  if ((next === "done" || next === "failed" || next === "uncertain") && current !== "printing") {
    throw new Error(`cannot move ${current} → ${next}`);
  }
  if (next === "queued") {
    throw new Error("cannot transition back to queued");
  }
}

function diagnosticSnapshot(input: EnqueuePrintJobInput): PrintSnapshot {
  return PrintSnapshotSchema.parse({
    version: 1,
    store_name: "Explicit print diagnostic",
    store_phone: null,
    order_id: input.order_id,
    ticket_no: input.ticket_no,
    received_at: new Date((input.now ?? 0) * 1_000).toISOString(),
    customer_name: null,
    customer_phone: null,
    note: null,
    lines: [
      {
        line_index: 0,
        service_code: "diagnostic",
        category_code: "diagnostic",
        unit_price_cents: 0,
        qty: 1,
        line_total_cents: 0,
        color: null,
        brand: null,
      },
    ],
    totals: {
      original_cents: 0,
      discount_cents: 0,
      addon_cents: 0,
      urgent_cents: 0,
      freight_cents: 0,
      payable_cents: 0,
      paid_cents: 0,
      balance_cents: 0,
    },
    payment_methods: [],
  });
}

export class MemoryPrintJobStore implements PrintJobStore {
  private readonly jobs: PrintJobRecord[] = [];
  private readonly snapshots = new Map<string, PrintSnapshot>();

  constructor(private readonly options: MemoryPrintJobStoreOptions = {}) {}

  private append(
    input: Readonly<{
      order_id: string;
      ticket_no: string;
      kind: PrintJobRecord["kind"];
      snapshot: PrintSnapshot;
      job_id?: string;
      now?: number;
    }>,
  ): PrintJobRecord {
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
    this.snapshots.set(job.job_id, input.snapshot);
    return job;
  }

  async enqueue(input: EnqueuePrintJobInput): Promise<PrintJobRecord> {
    return this.append({
      ...input,
      snapshot: diagnosticSnapshot(input),
    });
  }

  async enqueueFromOrder(input: EnqueueOrderPrintJobInput): Promise<PrintJobRecord> {
    const snapshot = await this.options.loadSnapshot?.(input.order_id);
    if (snapshot === undefined || snapshot === null || snapshot.order_id !== input.order_id) {
      throw new Error(`print order not found or not printable: ${input.order_id}`);
    }
    return this.append({
      ...input,
      ticket_no: snapshot.ticket_no,
      snapshot,
    });
  }

  async requeueFromSource(input: RequeuePrintJobInput): Promise<PrintJobRecord> {
    const source = await this.get(input.source_job_id);
    const snapshot = this.snapshots.get(input.source_job_id);
    if (source === null || snapshot === undefined) {
      throw new Error(`print source not found: ${input.source_job_id}`);
    }
    const allowed =
      input.action === "reprint"
        ? source.status === "done"
        : source.status === "failed" || source.status === "uncertain";
    if (!allowed) throw new Error(`print source status is not ${input.action} eligible`);
    return this.append({
      order_id: source.order_id,
      ticket_no: source.ticket_no,
      kind: source.kind,
      snapshot,
      ...(input.job_id === undefined ? {} : { job_id: input.job_id }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  async list(limit: number): Promise<readonly PrintJobStatusView[]> {
    const capped = Math.max(0, Math.min(limit, 50));
    const newestFirst = [...this.jobs].reverse().slice(0, capped);
    return Object.freeze(newestFirst.map((j) => toStatusView(j)));
  }

  /** Internal reporting projection; unlike the renderer-facing list, this is not truncated. */
  async listAll(): Promise<readonly PrintJobStatusView[]> {
    return Object.freeze([...this.jobs].reverse().map((job) => toStatusView(job)));
  }

  async get(jobId: string): Promise<PrintJobRecord | null> {
    return this.jobs.find((j) => j.job_id === jobId) ?? null;
  }

  async transition(
    jobId: string,
    status: PrintJobStatus,
    options: TransitionPrintJobOptions = {},
  ): Promise<PrintJobRecord> {
    const index = this.jobs.findIndex((j) => j.job_id === jobId);
    if (index < 0) {
      throw new Error(`print job not found: ${jobId}`);
    }
    const current = this.jobs[index]!;
    assertLegalTransition(current.status, status, jobId);
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
            ...(current.payload_bytes !== undefined
              ? { payload_bytes: current.payload_bytes }
              : {}),
          })
        : Object.freeze({
            job_id: current.job_id,
            kind: current.kind,
            status,
            order_id: current.order_id,
            ticket_no: current.ticket_no,
            created_at: current.created_at,
            updated_at: now,
            ...(options.payload_bytes !== undefined
              ? { payload_bytes: options.payload_bytes }
              : current.payload_bytes !== undefined
                ? { payload_bytes: current.payload_bytes }
                : {}),
          });

    this.jobs[index] = next;
    return next;
  }
}

export function createMemoryPrintJobStore(
  options: MemoryPrintJobStoreOptions = {},
): MemoryPrintJobStore {
  return new MemoryPrintJobStore(options);
}
