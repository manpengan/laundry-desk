/**
 * print_jobs local state machine + execution receipt payload (D4).
 * Status flow: queued → printing → done | failed.
 * Receipt shape matches A4 ExecutionReceiptPayload for D2 signReceipt.
 */
import { randomUUID } from "node:crypto";

import type { ExecutionReceiptPayload } from "@laundry/contracts";

export type PrintJobStatus = "queued" | "printing" | "done" | "failed";
export type PrintJobKind = "xp58" | "dl206" | "gp3120";

export type PrintJobRecord = Readonly<{
  id: string;
  kind: PrintJobKind;
  status: PrintJobStatus;
  createdAt: number;
  updatedAt: number;
  /** Monotonic positive seq for execution receipts. */
  seq: number;
  /** UUID nonce bound into D2 execution receipt. */
  ticketNonce: string;
  error?: string;
}>;

/** Status-only projection safe for renderer IPC (no device paths / bytes). */
export type PrintJobStatusView = Readonly<{
  id: string;
  kind: PrintJobKind;
  status: PrintJobStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}>;

export type PrintJobStore = Readonly<{
  jobs: readonly PrintJobRecord[];
  nextSeq: number;
}>;

let idSeq = 0;

export function createPrintJobStore(): PrintJobStore {
  return Object.freeze({ jobs: Object.freeze([] as PrintJobRecord[]), nextSeq: 1 });
}

export function enqueuePrintJob(
  store: PrintJobStore,
  kind: PrintJobKind,
  now = Date.now(),
  ticketNonce: string = randomUUID(),
): { store: PrintJobStore; job: PrintJobRecord } {
  if (store.nextSeq < 1) {
    throw new Error("nextSeq must be a positive integer");
  }
  idSeq += 1;
  const job: PrintJobRecord = Object.freeze({
    id: `print-${idSeq}`,
    kind,
    status: "queued" as const,
    createdAt: now,
    updatedAt: now,
    seq: store.nextSeq,
    ticketNonce,
  });
  const next: PrintJobStore = Object.freeze({
    jobs: Object.freeze([...store.jobs, job]),
    nextSeq: store.nextSeq + 1,
  });
  return { store: next, job };
}

const TERMINAL: ReadonlySet<PrintJobStatus> = new Set(["done", "failed"]);

function findJob(store: PrintJobStore, id: string): PrintJobRecord | undefined {
  return store.jobs.find((j) => j.id === id);
}

/**
 * Transition a job. Legal edges:
 *   queued → printing
 *   printing → done | failed
 * failed always keeps error text.
 */
export function transitionPrintJob(
  store: PrintJobStore,
  id: string,
  status: PrintJobStatus,
  options: { error?: string; now?: number } = {},
): PrintJobStore {
  const current = findJob(store, id);
  if (!current) {
    throw new Error(`print job not found: ${id}`);
  }
  if (TERMINAL.has(current.status)) {
    throw new Error(`print job ${id} is already terminal (${current.status})`);
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

  const now = options.now ?? Date.now();
  const jobs: PrintJobRecord[] = store.jobs.map((j) => {
    if (j.id !== id) return j;
    if (status === "failed") {
      const failed: PrintJobRecord = Object.freeze({
        id: j.id,
        kind: j.kind,
        status: "failed",
        createdAt: j.createdAt,
        updatedAt: now,
        seq: j.seq,
        ticketNonce: j.ticketNonce,
        error: options.error as string,
      });
      return failed;
    }
    // Clear error on non-failed transitions.
    const next: PrintJobRecord = Object.freeze({
      id: j.id,
      kind: j.kind,
      status,
      createdAt: j.createdAt,
      updatedAt: now,
      seq: j.seq,
      ticketNonce: j.ticketNonce,
    });
    return next;
  });

  return Object.freeze({ jobs: Object.freeze(jobs), nextSeq: store.nextSeq });
}

export function getPrintJob(store: PrintJobStore, id: string): PrintJobRecord | undefined {
  return findJob(store, id);
}

/** Status-only list for IPC — never exposes ticketNonce or payload bytes. */
export function listPrintJobStatus(store: PrintJobStore): readonly PrintJobStatusView[] {
  return Object.freeze(
    store.jobs.map((j) => {
      if (j.error !== undefined) {
        return Object.freeze({
          id: j.id,
          kind: j.kind,
          status: j.status,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          error: j.error,
        });
      }
      return Object.freeze({
        id: j.id,
        kind: j.kind,
        status: j.status,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      });
    }),
  );
}

/**
 * Build A4 execution receipt payload for D2 `signReceipt`.
 * Only terminal jobs (done|failed) may produce a receipt.
 */
export function buildExecutionReceiptPayload(
  job: PrintJobRecord,
  at: Date = new Date(),
): ExecutionReceiptPayload {
  if (job.status !== "done" && job.status !== "failed") {
    throw new Error(`receipt requires terminal job, got ${job.status}`);
  }
  return Object.freeze({
    ticket_nonce: job.ticketNonce,
    result: job.status === "done" ? ("succeeded" as const) : ("failed" as const),
    seq: job.seq,
    at: at.toISOString(),
  });
}
