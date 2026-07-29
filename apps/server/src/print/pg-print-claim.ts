/**
 * Lease claim SQL for print_jobs (0021).
 *
 * Split out of pg-print-store.ts to keep that module inside its size budget;
 * these three statements are the whole claim protocol and belong together.
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
 * Retire jobs whose lease expired after the final allowed attempt.
 *
 * Runs before every claim so an exhausted job leaves the claimable set instead
 * of being re-claimed forever by a payload that kills its worker.
 */
export async function failExhausted(
  client: SqlClient,
  orgId: string,
  storeId: string,
  maxAttempts: number,
  at: Date,
): Promise<void> {
  await client.query(
    `UPDATE print_jobs
     SET status = 'failed',
         error = 'print worker gave up after ' || attempt_count || ' attempts',
         claimed_at = NULL, lease_until = NULL, worker_id = NULL,
         updated_at = $4
     WHERE org_id = $1::uuid AND store_id = $2::uuid
       AND status = 'printing'
       AND lease_until IS NOT NULL AND lease_until <= $4
       AND attempt_count >= $3`,
    [orgId, storeId, maxAttempts, at],
  );
}

/**
 * Take the oldest claimable job in one statement.
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
  maxAttempts: number,
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
     WHERE id = (
       SELECT id FROM print_jobs
       WHERE org_id = $1::uuid AND store_id = $2::uuid
         AND attempt_count < $3
         AND (
           status = 'queued'
           OR (status = 'printing' AND lease_until IS NOT NULL AND lease_until <= $5)
         )
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, kind, order_id, ticket_no, attempt_count, lease_until, worker_id`,
    [orgId, storeId, maxAttempts, workerId, at, leaseUntil],
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
  maxAttempts: number,
  at: Date,
  leaseUntil: Date,
): Promise<ClaimRow | null> {
  const result = await client.query<ClaimRow>(
    `UPDATE print_jobs
     SET status = 'printing',
         attempt_count = attempt_count + 1,
         claimed_at = $6,
         lease_until = $7,
         worker_id = $5,
         updated_at = $6
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
       AND attempt_count < $4
       AND (
         status = 'queued'
         OR (status = 'printing' AND lease_until IS NOT NULL AND lease_until <= $6)
       )
     RETURNING id, kind, order_id, ticket_no, attempt_count, lease_until, worker_id`,
    [orgId, storeId, jobId, maxAttempts, workerId, at, leaseUntil],
  );
  return result.rows[0] ?? null;
}
