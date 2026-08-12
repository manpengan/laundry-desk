import type { GarmentStatus } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import type {
  FactoryAttemptView,
  FactoryBatchDetailResult,
  FactoryBatchListResult,
  FactoryBatchListRow,
  FactoryBatchStatus,
  FactoryCheckpointRow,
  FactoryCustodyState,
  FactoryEligibleGarment,
  FactoryManifestRow,
  FactoryMemberState,
  FactoryQcReason,
  FactoryQcStatus,
  FactoryQualityView,
} from "./factory-types.js";
import { requiredCheckpoint } from "./pg-factory-support.js";

const epoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1_000);

type BatchSqlRow = Readonly<{
  batch_id: string;
  factory_code: string;
  status: FactoryBatchStatus;
  version: number;
  manifest_count: number;
  exception_count: number;
  updated_at: Date | string;
}>;

const mapBatch = (row: BatchSqlRow): FactoryBatchListRow =>
  Object.freeze({ ...row, updated_at: epoch(row.updated_at) });

export async function listPgFactoryBatches(
  client: SqlClient,
  orgId: string,
  storeId: string,
  options: Readonly<{ statuses?: readonly FactoryBatchStatus[]; limit: number }>,
): Promise<FactoryBatchListResult> {
  const batches = await client.query<BatchSqlRow>(
    `SELECT pb.id::text AS batch_id, pb.factory_code, pb.status, pb.version,
            pb.expected_garment_count AS manifest_count,
            pb.exception_garment_count AS exception_count, pb.updated_at
       FROM production_batches pb
      WHERE pb.org_id = $1::uuid AND pb.store_id = $2::uuid
        AND ($3::text[] IS NULL OR pb.status = ANY($3::text[]))
      ORDER BY pb.updated_at DESC, pb.id
      LIMIT $4`,
    [orgId, storeId, options.statuses ?? null, options.limit],
  );
  const eligible = await client.query<FactoryEligibleGarment>(
    `SELECT g.id::text AS garment_id, g.order_id::text, o.ticket_no, g.barcode,
            g.status, g.custody_state
       FROM garments g
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND o.status = 'open'
        AND o.customer_pii_purged_at IS NULL
        AND g.customer_pii_purged_at IS NULL
        AND g.status IN ('received', 'reworked')
        AND g.custody_state = 'store'
        AND g.active_production_batch_id IS NULL
      ORDER BY g.id
      LIMIT 100`,
    [orgId, storeId],
  );
  return Object.freeze({
    batches: Object.freeze(batches.rows.map(mapBatch)),
    eligible_garments: Object.freeze(eligible.rows.map((row) => Object.freeze({ ...row }))),
  });
}

type ManifestSqlRow = Readonly<{
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
  status: GarmentStatus;
  custody_state: FactoryCustodyState;
  member_state: FactoryMemberState;
  qc_status: FactoryQcStatus;
}>;

type CheckpointSqlRow = Omit<FactoryCheckpointRow, "completed_at"> &
  Readonly<{ completed_at: Date | string }>;
type QualitySqlRow = Omit<FactoryQualityView, "inspected_at"> &
  Readonly<{ inspected_at: Date | string; reason_code: FactoryQcReason | null }>;
type AttemptSqlRow = Readonly<{
  attempt_id: string;
  checkpoint: FactoryAttemptView["checkpoint"];
  outcome: FactoryAttemptView["outcome"];
  recorded_at: Date | string;
}>;
type AttemptItemSqlRow = Readonly<{
  barcode: string;
  outcome: "matched" | "missing" | "unexpected";
}>;

async function latestAttempt(
  client: SqlClient,
  orgId: string,
  storeId: string,
  batchId: string,
  batchVersion: number,
  checkpoint: FactoryAttemptView["checkpoint"] | null,
): Promise<FactoryAttemptView | null> {
  if (checkpoint === null) return null;
  const found = await client.query<AttemptSqlRow>(
    `SELECT id::text AS attempt_id, checkpoint, outcome, recorded_at
      FROM production_handoff_attempts
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid
        AND batch_version = $4 AND checkpoint = $5
      ORDER BY attempt_no DESC, id DESC
      LIMIT 1`,
    [orgId, storeId, batchId, batchVersion, checkpoint],
  );
  const attempt = found.rows[0];
  if (attempt === undefined) return null;
  const items = await client.query<AttemptItemSqlRow>(
    `SELECT barcode, outcome
       FROM production_handoff_attempt_items
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND attempt_id = $3::uuid
      ORDER BY barcode`,
    [orgId, storeId, attempt.attempt_id],
  );
  const barcodes = (outcome: AttemptItemSqlRow["outcome"]) =>
    Object.freeze(
      items.rows.filter((item) => item.outcome === outcome).map((item) => item.barcode),
    );
  return Object.freeze({
    attempt_id: attempt.attempt_id,
    checkpoint: attempt.checkpoint,
    outcome: attempt.outcome,
    matched_barcodes: barcodes("matched"),
    missing_barcodes: barcodes("missing"),
    unexpected_barcodes: barcodes("unexpected"),
    recorded_at: epoch(attempt.recorded_at),
  });
}

export async function getPgFactoryBatch(
  client: SqlClient,
  orgId: string,
  storeId: string,
  batchId: string,
): Promise<FactoryBatchDetailResult | null> {
  const batch = await client.query<BatchSqlRow>(
    `SELECT pb.id::text AS batch_id, pb.factory_code, pb.status, pb.version,
            pb.expected_garment_count AS manifest_count,
            pb.exception_garment_count AS exception_count, pb.updated_at
      FROM production_batches pb
      WHERE pb.org_id = $1::uuid AND pb.store_id = $2::uuid AND pb.id = $3::uuid
      LIMIT 1`,
    [orgId, storeId, batchId],
  );
  const batchRow = batch.rows[0];
  if (batchRow === undefined) return null;
  const manifest = await client.query<ManifestSqlRow>(
    `SELECT g.id::text AS garment_id, g.order_id::text, o.ticket_no, g.barcode,
              g.status, g.custody_state, bg.state AS member_state, bg.qc_status
         FROM batch_garments bg
         JOIN garments g
           ON g.org_id = bg.org_id AND g.store_id = bg.store_id AND g.id = bg.garment_id
         JOIN orders o
           ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
        WHERE bg.org_id = $1::uuid AND bg.store_id = $2::uuid AND bg.batch_id = $3::uuid
        ORDER BY g.id
        LIMIT 100`,
    [orgId, storeId, batchId],
  );
  const checkpoints = await client.query<CheckpointSqlRow>(
    `SELECT checkpoint, completed_at, matched_count, missing_count, unexpected_count
         FROM production_handoff_checkpoints
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid
        ORDER BY completed_at, checkpoint
        LIMIT 4`,
    [orgId, storeId, batchId],
  );
  const quality = await client.query<QualitySqlRow>(
    `SELECT garment_id::text, outcome, reason_code, inspected_at
         FROM garment_qc_log
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid
        ORDER BY inspected_at DESC, id DESC
        LIMIT 100`,
    [orgId, storeId, batchId],
  );
  const attempt = await latestAttempt(
    client,
    orgId,
    storeId,
    batchId,
    batchRow.version,
    requiredCheckpoint(batchRow.status),
  );
  return Object.freeze({
    batch: mapBatch(batchRow),
    manifest: Object.freeze(
      manifest.rows.map((row): FactoryManifestRow => Object.freeze({ ...row })),
    ),
    checkpoints: Object.freeze(
      checkpoints.rows.map((row) =>
        Object.freeze({ ...row, completed_at: epoch(row.completed_at) }),
      ),
    ),
    latest_attempt: attempt,
    quality_checks: Object.freeze(
      quality.rows.map((row) => Object.freeze({ ...row, inspected_at: epoch(row.inspected_at) })),
    ),
  });
}
