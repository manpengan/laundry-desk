/**
 * M2 skeleton print ticket job queue (enqueue + status list).
 * Memory-first; not in OpenAPI freeze snapshot.
 * Status flow mirrors edge-agent: queued → printing → done | failed.
 */

import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

export const PrintJobKindSchema = z.enum(["xp58", "dl206", "gp3120"]);
export const PrintJobStatusSchema = z.enum(["queued", "printing", "done", "failed"]);

export const PrintTicketEnqueueInputSchema = z.strictObject({
  order_id: z.uuid(),
  ticket_no: z.string().min(1).max(64),
  /** Printer family; omit to use xp58 thermal receipt (handler default). */
  kind: PrintJobKindSchema.optional(),
});

export const PrintJobsListInputSchema = z.strictObject({
  /** Newest-first row cap (max 50). Omit for handler default 20. */
  limit: z.number().int().positive().max(50).optional(),
});

type EnqueueInput = typeof PrintTicketEnqueueInputSchema;
type ListInput = typeof PrintJobsListInputSchema;

/** 排队打印小票：绑定 order_id / ticket_no，返回 job_id（status=queued）。 */
export const printTicketEnqueueCommand: CommandDefinition<EnqueueInput> = defineCommand({
  name: "print.ticket.enqueue",
  version: "0.1.0",
  description: "Enqueue a ticket print job bound to an order and ticket number.",
  description_llm:
    "Queue a counter ticket print job (kind xp58|dl206|gp3120). Returns job_id with status queued. No device I/O in this skeleton.",
  input: PrintTicketEnqueueInputSchema,
  risk: "R1",
  invariants: ["rbac.order_write"],
  idempotent: true,
  sideEffects: ["print.job_queued", "audit.print_job"],
  offline_mode: "grant",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/** 打印任务状态列表：最近 N 条（无设备路径 / 无 payload bytes）。 */
export const printJobsListQuery: QueryDefinition<ListInput> = defineQuery({
  name: "print.jobs.list",
  version: "0.1.0",
  description: "List recent print job status views (no device paths or payload bytes).",
  description_llm:
    "Return newest-first print job status rows (job_id, kind, status, order_id, ticket_no, timestamps, optional error).",
  input: PrintJobsListInputSchema,
  risk: "R1",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 50,
});

export const PRINT_COMMANDS = Object.freeze([printTicketEnqueueCommand] as const);

export const PRINT_COMMAND_NAMES = Object.freeze(
  PRINT_COMMANDS.map((command) => command.name),
) as readonly ["print.ticket.enqueue"];

export const PRINT_QUERIES = Object.freeze([printJobsListQuery] as const);

export const PRINT_QUERY_NAMES = Object.freeze(
  PRINT_QUERIES.map((query) => query.name),
) as readonly ["print.jobs.list"];

/** M2 print command catalog (server command registry). */
export const M2_PRINT_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] =
  Object.freeze([...PRINT_COMMANDS]);

export const M2_PRINT_COMMAND_NAMES = PRINT_COMMAND_NAMES;

/** M2 print query catalog (server query registry). */
export const M2_PRINT_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...PRINT_QUERIES,
]);

export const M2_PRINT_QUERY_NAMES = PRINT_QUERY_NAMES;
