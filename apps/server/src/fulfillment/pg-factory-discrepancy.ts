import type { SqlClient } from "../db/types.js";
import type { FactoryCheckpoint } from "./factory-types.js";
import type { PgFactoryScope } from "./pg-factory-locks.js";

export async function hasUnresolvedPgFactoryDiscrepancy(
  client: SqlClient,
  scope: PgFactoryScope & Readonly<{ batch_id: string }>,
  batchVersion: number,
  checkpoint: FactoryCheckpoint,
): Promise<boolean> {
  const result = await client.query<Readonly<{ blocked: boolean }>>(
    `SELECT EXISTS (
       SELECT 1
         FROM production_handoff_attempts attempt
         LEFT JOIN production_handoff_discrepancy_resolutions resolution
           ON resolution.org_id = attempt.org_id
          AND resolution.store_id = attempt.store_id
          AND resolution.attempt_id = attempt.id
        WHERE attempt.org_id = $1::uuid AND attempt.store_id = $2::uuid
          AND attempt.batch_id = $3::uuid AND attempt.batch_version = $4
          AND attempt.checkpoint = $5 AND attempt.outcome = 'discrepancy'
          AND resolution.id IS NULL
     ) AS blocked`,
    [scope.org_id, scope.store_id, scope.batch_id, batchVersion, checkpoint],
  );
  return result.rows[0]?.blocked === true;
}
