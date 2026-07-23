/**
 * Postgres PrintJobStore: laundry_app + withStoreGuc (SET LOCAL tenant GUCs).
 * Table: print_jobs (0010). Soft order_id bind (no orders FK).
 */

import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type {
  EnqueuePrintJobInput,
  PrintJobKind,
  PrintJobRecord,
  PrintJobStatus,
  PrintJobStatusView,
  PrintJobStore,
  TransitionPrintJobOptions,
} from "./types.js";

export type CreatePgPrintJobStoreOptions = Readonly<{
  orgId: string;
  storeId: string;
  newId?: () => string;
}>;

type PrintJobRow = Readonly<{
  id: string;
  kind: string;
  status: string;
  order_id: string;
  ticket_no: string;
  created_at: Date;
  updated_at: Date;
  error: string | null;
  payload_bytes: number | null;
}>;

const TERMINAL: ReadonlySet<PrintJobStatus> = new Set(["done", "failed"]);

function epochSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function epochToDate(epoch: number): Date {
  return new Date(epoch * 1000);
}

function mapRow(row: PrintJobRow): PrintJobRecord {
  return Object.freeze({
    job_id: row.id,
    kind: row.kind as PrintJobKind,
    status: row.status as PrintJobStatus,
    order_id: row.order_id,
    ticket_no: row.ticket_no,
    created_at: epochSeconds(row.created_at),
    updated_at: epochSeconds(row.updated_at),
    ...(row.error !== null && row.error.length > 0 ? { error: row.error } : {}),
    ...(row.payload_bytes !== null ? { payload_bytes: row.payload_bytes } : {}),
  });
}

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
  if ((next === "done" || next === "failed") && current !== "printing") {
    throw new Error(`cannot move ${current} → ${next}`);
  }
  if (next === "queued") {
    throw new Error("cannot transition back to queued");
  }
}

async function selectJob(
  client: SqlClient,
  orgId: string,
  storeId: string,
  jobId: string,
): Promise<PrintJobRow | null> {
  const result = await client.query<PrintJobRow>(
    `SELECT id, kind, status, order_id, ticket_no, created_at, updated_at, error, payload_bytes
     FROM print_jobs
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [orgId, storeId, jobId],
  );
  return result.rows[0] ?? null;
}

/**
 * Create a PrintJobStore backed by Postgres under laundry_app RLS GUC scope.
 */
export function createPgPrintJobStore(
  pool: PgPool,
  options: CreatePgPrintJobStoreOptions,
): PrintJobStore {
  const { orgId, storeId } = options;
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    enqueue: async (input: EnqueuePrintJobInput): Promise<PrintJobRecord> =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const now = input.now ?? Math.floor(Date.now() / 1000);
        const jobId = input.job_id ?? newId();
        const at = epochToDate(now);
        await client.query(
          `INSERT INTO print_jobs (
             id, org_id, store_id, order_id, ticket_no, kind, status,
             error, payload_bytes, created_at, updated_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
             NULL, NULL, $7, $7
           )`,
          [jobId, orgId, storeId, input.order_id, input.ticket_no, input.kind, at],
        );
        return Object.freeze({
          job_id: jobId,
          kind: input.kind,
          status: "queued" as const,
          order_id: input.order_id,
          ticket_no: input.ticket_no,
          created_at: now,
          updated_at: now,
        });
      }),

    list: async (limit: number): Promise<readonly PrintJobStatusView[]> =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const capped = Math.max(0, Math.min(limit, 50));
        const result = await client.query<PrintJobRow>(
          `SELECT id, kind, status, order_id, ticket_no, created_at, updated_at, error, payload_bytes
           FROM print_jobs
           WHERE org_id = $1::uuid AND store_id = $2::uuid
           ORDER BY created_at DESC
           LIMIT $3`,
          [orgId, storeId, capped],
        );
        return Object.freeze(result.rows.map((row) => toStatusView(mapRow(row))));
      }),

    get: async (jobId: string): Promise<PrintJobRecord | null> =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const row = await selectJob(client, orgId, storeId, jobId);
        return row === null ? null : mapRow(row);
      }),

    transition: async (
      jobId: string,
      status: PrintJobStatus,
      transitionOptions: TransitionPrintJobOptions = {},
    ): Promise<PrintJobRecord> =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const row = await selectJob(client, orgId, storeId, jobId);
        if (row === null) {
          throw new Error(`print job not found: ${jobId}`);
        }
        const current = mapRow(row);
        assertLegalTransition(current.status, status, jobId);
        if (
          status === "failed" &&
          (transitionOptions.error === undefined || transitionOptions.error.length === 0)
        ) {
          throw new Error("failed jobs require non-empty error text");
        }

        const now = transitionOptions.now ?? Math.floor(Date.now() / 1000);
        const error = status === "failed" ? (transitionOptions.error as string) : null;
        const payloadBytes =
          transitionOptions.payload_bytes !== undefined
            ? transitionOptions.payload_bytes
            : (current.payload_bytes ?? null);

        const result = await client.query<PrintJobRow>(
          `UPDATE print_jobs
           SET status = $4, error = $5, payload_bytes = $6, updated_at = $7
           WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
           RETURNING id, kind, status, order_id, ticket_no, created_at, updated_at, error, payload_bytes`,
          [orgId, storeId, jobId, status, error, payloadBytes, epochToDate(now)],
        );
        const updated = result.rows[0];
        if (updated === undefined) {
          throw new Error(`print job update returned no row: ${jobId}`);
        }
        return mapRow(updated);
      }),
  });
}
