/**
 * M2 print ticket job queue (enqueue + process + retry/reprint + status list).
 * Memory default; PG print_jobs when runtime is pg. Not in OpenAPI freeze snapshot.
 * Status flow: queued → printing → done | failed | uncertain (terminal).
 * Retry/reprint create a **new** print_jobs row (do not resurrect terminal jobs).
 * process is a legacy diagnostic and cannot claim server-snapshotted jobs.
 */

import { z } from "zod";

import { EdgePrinterKindSchema } from "../edge/primitives.js";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

export const PrintJobKindSchema = EdgePrinterKindSchema;
export const PrintJobStatusSchema = z.enum(["queued", "printing", "done", "failed", "uncertain"]);

export const PrintTicketEnqueueInputSchema = z.strictObject({
  order_id: z.uuid(),
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

/** 排队打印小票：只接受 order_id，ticket_no 与票据快照由服务端订单真源派生。 */
export const printTicketEnqueueCommand: CommandDefinition<EnqueueInput> = defineCommand({
  name: "print.ticket.enqueue",
  version: "0.3.0",
  description: "Enqueue a ticket print job from the server-owned order snapshot.",
  description_llm:
    "Queue a counter ticket print job by order_id (kind xp58|dl206|gp3120). The server derives ticket number and immutable receipt snapshot; clients cannot supply either.",
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
  version: "0.2.0",
  description: "Process a legacy diagnostic XP-58 job in-process.",
  description_llm:
    "Diagnostic-only legacy path. Server-snapshotted real-order jobs fail closed and require signed Edge dispatch plus a verified device receipt.",
  input: PrintTicketProcessInputSchema,
  risk: "R1",
  invariants: ["rbac.print_manage"],
  idempotent: false,
  sideEffects: ["print.job_processed", "audit.print_job"],
  // Process is a server-side state machine step; not offline-granted (must be idempotent if grant).
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/** 失败或不确定任务重试：重新读取当前服务端权威快照并新建任务，不复活原 terminal 行。 */
export const printTicketRetryCommand: CommandDefinition<RetryInput> = defineCommand({
  name: "print.ticket.retry",
  version: "0.2.0",
  description:
    "Retry a failed or uncertain print job from the current server-authoritative snapshot.",
  description_llm:
    "Load a failed or uncertain print job, re-read the current server-authoritative order snapshot, and enqueue a NEW queued row with that snapshot and the source printer kind. Never auto-process and never mutate the source row.",
  input: PrintTicketRetryInputSchema,
  risk: "R1",
  invariants: ["rbac.print_manage"],
  // offline grant requires idempotent floor (same as enqueue; bus may still allocate a new job_id).
  idempotent: true,
  sideEffects: ["print.job_queued", "audit.print_job"],
  offline_mode: "grant",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/** 已完成任务补打：重新读取当前服务端权威快照并新建任务，不复活原 terminal 行。 */
export const printTicketReprintCommand: CommandDefinition<ReprintInput> = defineCommand({
  name: "print.ticket.reprint",
  version: "0.2.0",
  description: "Reprint a done print job from the current server-authoritative snapshot.",
  description_llm:
    "Load a done print job, re-read the current server-authoritative order snapshot, and enqueue a NEW queued row with that snapshot and the source printer kind. Never auto-process and never mutate the source row.",
  input: PrintTicketReprintInputSchema,
  risk: "R1",
  invariants: ["rbac.print_manage"],
  // offline grant requires idempotent floor (same as enqueue; bus may still allocate a new job_id).
  idempotent: true,
  sideEffects: ["print.job_queued", "audit.print_job"],
  offline_mode: "grant",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/** 打印任务状态列表：最近 N 条（可含 payload_bytes，无设备路径）。 */
export const printJobsListQuery: QueryDefinition<ListInput> = defineQuery({
  name: "print.jobs.list",
  version: "0.2.0",
  description: "List recent print job status views (no device paths).",
  description_llm:
    "Return newest-first print job status rows (job_id, kind, status, order_id, ticket_no, timestamps, optional error/payload_bytes).",
  input: PrintJobsListInputSchema,
  risk: "R1",
  invariants: ["rbac.print_manage"],
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
