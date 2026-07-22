/**
 * M2 print handlers: print.ticket.enqueue | print.ticket.process + print.jobs.list.
 */

import { createCommandError } from "@laundry/contracts";
import { randomUUID } from "node:crypto";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { processXp58PrintJob, type ProcessXp58Result } from "./process-xp58.js";
import type { PrintJobKind, PrintJobStore } from "./types.js";

export type PrintHandlerDeps = Readonly<{
  store: PrintJobStore;
  now?: () => number;
  newId?: () => string;
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

    return Object.freeze({
      result: Object.freeze({
        job_id: job.job_id,
        status: job.status,
        kind: job.kind,
        order_id: job.order_id,
        ticket_no: job.ticket_no,
      }),
      audit: Object.freeze({
        entity: "print_job",
        entityId: job.job_id,
        afterJson: JSON.stringify({
          kind: job.kind,
          status: job.status,
          order_id: job.order_id,
          ticket_no: job.ticket_no,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "print.job_queued",
          payload: Object.freeze({
            job_id: job.job_id,
            order_id: job.order_id,
            ticket_no: job.ticket_no,
            kind: job.kind,
          }),
        }),
      ]),
    });
  };
}

function processHandler(deps: PrintHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const jobId = requireString(input.job_id);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);

    let result: ProcessXp58Result;
    try {
      result = await processXp58PrintJob(deps.store, jobId, { now });
    } catch (err) {
      mapProcessError(err);
    }

    const job = result.job;
    return Object.freeze({
      result: Object.freeze({
        job_id: job.job_id,
        status: job.status,
        kind: job.kind,
        order_id: job.order_id,
        ticket_no: job.ticket_no,
        payload_bytes: result.payload_bytes,
      }),
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

function listHandler(deps: PrintHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const limit = input.limit === undefined ? 20 : Math.min(requirePositiveInt(input.limit), 50);
    const jobs = await deps.store.list(limit);
    return Object.freeze({
      result: Object.freeze({
        jobs: Object.freeze(jobs.map((j) => Object.freeze({ ...j }))),
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
}

export function registerPrintQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PrintHandlerDeps,
): void {
  const handlers = createPrintQueryHandlers(deps);
  registry.registerHandler("print.jobs.list", handlers["print.jobs.list"]!);
}
