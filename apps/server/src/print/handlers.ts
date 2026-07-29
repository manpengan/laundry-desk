/**
 * M2 print handlers: enqueue | process | retry | reprint + print.jobs.list.
 * Retry/reprint create a new print_jobs row (terminal source jobs stay terminal).
 */

import { createCommandError } from "@laundry/contracts";
import { randomUUID } from "node:crypto";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import type { FileSpool } from "./file-spool.js";
import type { PrintWorkerController } from "./worker-controller.js";
import { runPrintJob } from "./worker.js";
import { HandlerCommandError } from "../bus/types.js";
import { processXp58PrintJob, type ProcessXp58Result } from "./process-xp58.js";
import type { PrintJobKind, PrintJobRecord, PrintJobStatus, PrintJobStore } from "./types.js";

export type PrintHandlerDeps = Readonly<{
  store: PrintJobStore;
  now?: () => number;
  newId?: () => string;
  /**
   * Mock file spool. When present, `print.ticket.process` prints through it
   * instead of building ESC/POS bytes — ADR-14 defers real hardware, so the
   * mock is the first-party path for now. Without a spool the ESC/POS builder
   * stays in place unchanged.
   */
  spool?: FileSpool;
  /** Identifies this server as the printing worker in the job lease. */
  workerId?: string;
  /** Runtime-owned background worker; handlers expose only its safe status view. */
  worker?: PrintWorkerController;
}>;

const KIND_SET: ReadonlySet<string> = new Set(["xp58", "dl206", "gp3120"]);

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requirePositiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function parseKind(value: unknown): PrintJobKind {
  if (value === undefined) return "xp58";
  if (typeof value !== "string" || !KIND_SET.has(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value as PrintJobKind;
}

function mapProcessError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not found")) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  if (message.includes("is not xp58") || message.includes("is not queued")) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  if (message.includes("terminal") || message.includes("cannot move")) {
    throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  }
  throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
}

type JobResultFields = Readonly<{
  job_id: string;
  status: PrintJobStatus;
  kind: PrintJobKind;
  order_id: string;
  ticket_no: string;
  payload_bytes?: number;
}>;

function jobResultFields(job: PrintJobRecord, payloadBytes?: number): JobResultFields {
  return Object.freeze({
    job_id: job.job_id,
    status: job.status,
    kind: job.kind,
    order_id: job.order_id,
    ticket_no: job.ticket_no,
    ...(payloadBytes !== undefined
      ? { payload_bytes: payloadBytes }
      : job.payload_bytes !== undefined
        ? { payload_bytes: job.payload_bytes }
        : {}),
  });
}

function enqueueOutcome(
  job: PrintJobRecord,
  options: Readonly<{
    sourceJobId?: string;
    action: "enqueue" | "retry" | "reprint";
    payloadBytes?: number;
    processed?: boolean;
  }>,
): HandlerOutcome {
  const queuedEvent = Object.freeze({
    type: "print.job_queued",
    payload: Object.freeze({
      job_id: job.job_id,
      order_id: job.order_id,
      ticket_no: job.ticket_no,
      kind: job.kind,
      ...(options.sourceJobId !== undefined ? { source_job_id: options.sourceJobId } : {}),
      action: options.action,
    }),
  });
  const events =
    options.processed === true
      ? Object.freeze([
          queuedEvent,
          Object.freeze({
            type: "print.job_processed",
            payload: Object.freeze({
              job_id: job.job_id,
              status: job.status,
              ...(options.payloadBytes !== undefined
                ? { payload_bytes: options.payloadBytes }
                : {}),
            }),
          }),
        ])
      : Object.freeze([queuedEvent]);

  return Object.freeze({
    result: jobResultFields(job, options.payloadBytes),
    audit: Object.freeze({
      entity: "print_job",
      entityId: job.job_id,
      afterJson: JSON.stringify({
        kind: job.kind,
        status: job.status,
        order_id: job.order_id,
        ticket_no: job.ticket_no,
        action: options.action,
        ...(options.sourceJobId !== undefined ? { source_job_id: options.sourceJobId } : {}),
        ...(options.payloadBytes !== undefined ? { payload_bytes: options.payloadBytes } : {}),
      }),
    }),
    events,
  });
}

/**
 * Auto-process xp58 after enqueue (receive / retry / reprint convenience).
 * Other kinds stay queued. Process failures surface as handler errors (job may be failed).
 */
async function maybeProcessXp58(
  deps: PrintHandlerDeps,
  job: PrintJobRecord,
  now: number,
): Promise<Readonly<{ job: PrintJobRecord; payloadBytes?: number; processed: boolean }>> {
  if (job.kind !== "xp58") {
    return Object.freeze({ job, processed: false });
  }
  let result: ProcessXp58Result;
  try {
    result = await processXp58PrintJob(deps.store, job.job_id, { now });
  } catch (err) {
    mapProcessError(err);
  }
  return Object.freeze({
    job: result.job,
    payloadBytes: result.payload_bytes,
    processed: true,
  });
}

function enqueueHandler(deps: PrintHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const orderId = requireString(input.order_id);
    const ticketNo = requireString(input.ticket_no);
    const kind = parseKind(input.kind);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const jobId = deps.newId?.() ?? randomUUID();

    const job = await deps.store.enqueue({
      order_id: orderId,
      ticket_no: ticketNo,
      kind,
      job_id: jobId,
      now,
    });

    return enqueueOutcome(job, { action: "enqueue" });
  };
}

/**
 * Mock print path: claim the named job, render a text artifact into the spool
 * and settle the job. The worker already records the artifact and maps failures
 * to safe codes, so this only has to translate the outcome into the envelope.
 */
async function processViaSpool(
  deps: PrintHandlerDeps,
  spool: FileSpool,
  jobId: string,
  now: number,
): Promise<PrintJobRecord> {
  const outcome = await runPrintJob(
    {
      store: deps.store,
      spool,
      workerId: deps.workerId ?? "local-server",
      now: () => now,
    },
    jobId,
  );
  if (outcome.kind === "idle") {
    // Not claimable: already terminal, out of attempts, or held by a live lease.
    throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  }
  const job = await deps.store.get(jobId);
  if (job === null) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  return job;
}

function processHandler(deps: PrintHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const jobId = requireString(input.job_id);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);

    const spool = deps.spool;
    if (spool !== undefined) {
      const job = await processViaSpool(deps, spool, jobId, now);
      return Object.freeze({
        result: jobResultFields(job, job.payload_bytes ?? 0),
        audit: Object.freeze({
          entity: "print_job",
          entityId: job.job_id,
          afterJson: JSON.stringify({
            kind: job.kind,
            status: job.status,
            payload_bytes: job.payload_bytes ?? 0,
          }),
        }),
        events: Object.freeze([
          Object.freeze({
            type: "print.job_processed",
            payload: Object.freeze({ job_id: job.job_id, status: job.status }),
          }),
        ]),
      });
    }

    let result: ProcessXp58Result;
    try {
      result = await processXp58PrintJob(deps.store, jobId, { now });
    } catch (err) {
      mapProcessError(err);
    }

    const job = result.job;
    return Object.freeze({
      result: jobResultFields(job, result.payload_bytes),
      audit: Object.freeze({
        entity: "print_job",
        entityId: job.job_id,
        afterJson: JSON.stringify({
          kind: job.kind,
          status: job.status,
          payload_bytes: result.payload_bytes,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "print.job_processed",
          payload: Object.freeze({
            job_id: job.job_id,
            status: job.status,
            payload_bytes: result.payload_bytes,
          }),
        }),
      ]),
    });
  };
}

/**
 * Clone terminal source into a new queued job, then auto-process xp58.
 * expectedStatus: failed → retry; done → reprint.
 */
function requeueHandler(
  deps: PrintHandlerDeps,
  expectedStatus: "failed" | "done",
  action: "retry" | "reprint",
): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const sourceJobId = requireString(input.job_id);

    const source = await deps.store.get(sourceJobId);
    if (source === null) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    if (source.status !== expectedStatus) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }

    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const newJobId = deps.newId?.() ?? randomUUID();
    const enqueued = await deps.store.enqueue({
      order_id: source.order_id,
      ticket_no: source.ticket_no,
      kind: source.kind,
      job_id: newJobId,
      now,
    });

    const after = await maybeProcessXp58(deps, enqueued, now);
    return enqueueOutcome(after.job, {
      action,
      sourceJobId,
      ...(after.payloadBytes !== undefined ? { payloadBytes: after.payloadBytes } : {}),
      processed: after.processed,
    });
  };
}

function listHandler(deps: PrintHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const limit = input.limit === undefined ? 20 : Math.min(requirePositiveInt(input.limit), 50);
    const jobs = await deps.store.list(limit);
    return Object.freeze({
      result: Object.freeze({
        jobs: Object.freeze(jobs.map((j) => Object.freeze({ ...j }))),
        ...(deps.worker === undefined ? {} : { worker: deps.worker.status() }),
      }),
    });
  };
}

export function createPrintCommandHandlers(
  deps: PrintHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "print.ticket.enqueue": enqueueHandler(deps),
    "print.ticket.process": processHandler(deps),
    "print.ticket.retry": requeueHandler(deps, "failed", "retry"),
    "print.ticket.reprint": requeueHandler(deps, "done", "reprint"),
  });
}

export function createPrintQueryHandlers(
  deps: PrintHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "print.jobs.list": listHandler(deps),
  });
}

export function registerPrintCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PrintHandlerDeps,
): void {
  const handlers = createPrintCommandHandlers(deps);
  registry.registerHandler("print.ticket.enqueue", handlers["print.ticket.enqueue"]!);
  registry.registerHandler("print.ticket.process", handlers["print.ticket.process"]!);
  registry.registerHandler("print.ticket.retry", handlers["print.ticket.retry"]!);
  registry.registerHandler("print.ticket.reprint", handlers["print.ticket.reprint"]!);
}

export function registerPrintQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PrintHandlerDeps,
): void {
  const handlers = createPrintQueryHandlers(deps);
  registry.registerHandler("print.jobs.list", handlers["print.jobs.list"]!);
}
