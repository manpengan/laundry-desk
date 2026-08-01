/**
 * Diagnostic lease claim SQL for print_jobs.
 *
 * Split out of pg-print-store.ts to keep that module inside its size budget;
 * These statements claim queued rows only. An expired `printing` row is never
 * reclaimed because another physical submission could duplicate a print.
 */

import type { SqlClient } from "../db/types.js";
import type { PrintJobKind } from "./types.js";

export type ClaimRow = Readonly<{
  id: string;
  kind: PrintJobKind;
  order_id: string;
  ticket_no: string;
  attempt_count: number;
  lease_until: Date;
  worker_id: string;
}>;

/**
 * Take the oldest queued job in one statement.
 *
 * SKIP LOCKED lets concurrent workers pass over rows another worker is already
 * taking rather than serialising behind them, and the single UPDATE keeps
 * select-then-claim from racing.
 */
export async function claimOne(
  client: SqlClient,
  orgId: string,
  storeId: string,
  workerId: string,
  at: Date,
  leaseUntil: Date,
): Promise<ClaimRow | null> {
  const result = await client.query<ClaimRow>(
    `UPDATE print_jobs
     SET status = 'printing',
         attempt_count = attempt_count + 1,
         claimed_at = $4,
         lease_until = $5,
         worker_id = $3,
         updated_at = $4
     WHERE id = (
       SELECT id FROM print_jobs
       WHERE org_id = $1::uuid AND store_id = $2::uuid
         AND status = 'queued'
         AND snapshot_json IS NULL
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, kind, order_id, ticket_no, attempt_count, lease_until, worker_id`,
    [orgId, storeId, workerId, at, leaseUntil],
  );
  return result.rows[0] ?? null;
}

/**
 * Claim one named job. No SKIP LOCKED here: the statement targets a single row,
 * so concurrent callers serialise on that row's lock and the loser finds the
 * claimability predicate no longer true. Still one statement, still atomic.
 */
export async function claimById(
  client: SqlClient,
  orgId: string,
  storeId: string,
  jobId: string,
  workerId: string,
  at: Date,
  leaseUntil: Date,
): Promise<ClaimRow | null> {
  const result = await client.query<ClaimRow>(
    `UPDATE print_jobs
     SET status = 'printing',
         attempt_count = attempt_count + 1,
         claimed_at = $5,
         lease_until = $6,
         worker_id = $4,
         updated_at = $5
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
       AND status = 'queued'
       AND snapshot_json IS NULL
     RETURNING id, kind, order_id, ticket_no, attempt_count, lease_until, worker_id`,
    [orgId, storeId, jobId, workerId, at, leaseUntil],
  );
  return result.rows[0] ?? null;
}
