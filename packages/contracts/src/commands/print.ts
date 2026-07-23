/**
 * M2 print ticket job queue (enqueue + process + retry/reprint + status list).
 * Memory default; PG print_jobs when runtime is pg. Not in OpenAPI freeze snapshot.
 * Status flow: queued → printing → done | failed (terminal).
 * Retry/reprint create a **new** print_jobs row (do not resurrect terminal jobs).
 * process builds XP-58 ESC/POS bytes in-process (no USB / device I/O).
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

export const PrintTicketProcessInputSchema = z.strictObject({
  job_id: z.uuid(),
});

/** Shared job_id input for retry / reprint (same shape as process). */
export const PrintTicketRetryInputSchema = z.strictObject({
  job_id: z.uuid(),
});

export const PrintTicketReprintInputSchema = z.strictObject({
  job_id: z.uuid(),
});

export const PrintJobsListInputSchema = z.strictObject({
  /** Newest-first row cap (max 50). Omit for handler default 20. */
  limit: z.number().int().positive().max(50).optional(),
});

type EnqueueInput = typeof PrintTicketEnqueueInputSchema;
type ProcessInput = typeof PrintTicketProcessInputSchema;
type RetryInput = typeof PrintTicketRetryInputSchema;
type ReprintInput = typeof PrintTicketReprintInputSchema;
type ListInput = typeof PrintJobsListInputSchema;

/** 排队打印小票：绑定 order_id / ticket_no，返回 job_id（status=queued）。 */
export const printTicketEnqueueCommand: CommandDefinition<EnqueueInput> = defineCommand({
  name: "print.ticket.enqueue",
  version: "0.1.0",
  description: "Enqueue a ticket print job bound to an order and ticket number.",
  description_llm:
    "Queue a counter ticket print job (kind xp58|dl206|gp3120). Returns job_id with status queued. No device I/O.",
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

/**
 * 处理排队中的 XP-58 打印任务：queued → printing → done|failed。
 * Builds ESC/POS bytes in-process (mock device success); no USB.
 */
export const printTicketProcessCommand: CommandDefinition<ProcessInput> = defineCommand({
  name: "print.ticket.process",
  version: "0.1.0",
  description: "Process a queued XP-58 print job: build ESC/POS bytes and mark done or failed.",
  description_llm:
    "Load print job by job_id. kind must be xp58. Transition queued→printing, build ESC/POS payload, set payload_bytes and status done. On error mark failed with error text. No USB/device I/O.",
  input: PrintTicketProcessInputSchema,
  risk: "R1",
  invariants: ["rbac.order_write"],
  idempotent: false,
  sideEffects: ["print.job_processed", "audit.print_job"],
  // Process is a server-side state machine step; not offline-granted (must be idempotent if grant).
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/**
 * 失败任务重试：source 必须 status=failed；新建 print_jobs 行（同 order_id/ticket_no/kind）。
 * 不复活原 terminal 行。服务端可对 xp58 自动 process。
 */
export const printTicketRetryCommand: CommandDefinition<RetryInput> = defineCommand({
  name: "print.ticket.retry",
  version: "0.1.0",
  description: "Retry a failed print job by enqueueing a new job with the same order/ticket/kind.",
  description_llm:
    "Load print job by job_id. Source status must be failed. Enqueue a NEW print_jobs row with same order_id, ticket_no, kind. Do not mutate the failed row. Returns new job (may auto-process xp58 to done). No device I/O paths stored.",
  input: PrintTicketRetryInputSchema,
  risk: "R1",
  invariants: ["rbac.order_write"],
  // offline grant requires idempotent floor (same as enqueue; bus may still allocate a new job_id).
  idempotent: true,
  sideEffects: ["print.job_queued", "print.job_processed", "audit.print_job"],
  offline_mode: "grant",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/**
 * 已完成任务补打：source 必须 status=done；新建 print_jobs 行（同 order_id/ticket_no/kind）。
 * 不复活原 terminal 行。服务端可对 xp58 自动 process。
 */
export const printTicketReprintCommand: CommandDefinition<ReprintInput> = defineCommand({
  name: "print.ticket.reprint",
  version: "0.1.0",
  description: "Reprint a done print job by enqueueing a new job with the same order/ticket/kind.",
  description_llm:
    "Load print job by job_id. Source status must be done. Enqueue a NEW print_jobs row with same order_id, ticket_no, kind. Do not mutate the done row. Returns new job (may auto-process xp58 to done). No device I/O paths stored.",
  input: PrintTicketReprintInputSchema,
  risk: "R1",
  invariants: ["rbac.order_write"],
  // offline grant requires idempotent floor (same as enqueue; bus may still allocate a new job_id).
  idempotent: true,
  sideEffects: ["print.job_queued", "print.job_processed", "audit.print_job"],
  offline_mode: "grant",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/** 打印任务状态列表：最近 N 条（可含 payload_bytes，无设备路径）。 */
export const printJobsListQuery: QueryDefinition<ListInput> = defineQuery({
  name: "print.jobs.list",
  version: "0.1.0",
  description: "List recent print job status views (no device paths).",
  description_llm:
    "Return newest-first print job status rows (job_id, kind, status, order_id, ticket_no, timestamps, optional error/payload_bytes).",
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

export const PRINT_COMMANDS = Object.freeze([
  printTicketEnqueueCommand,
  printTicketProcessCommand,
  printTicketRetryCommand,
  printTicketReprintCommand,
] as const);

export const PRINT_COMMAND_NAMES = Object.freeze(
  PRINT_COMMANDS.map((command) => command.name),
) as readonly [
  "print.ticket.enqueue",
  "print.ticket.process",
  "print.ticket.retry",
  "print.ticket.reprint",
];

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
