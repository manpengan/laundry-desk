import type { SqlClient } from "../db/types.js";
import { hasUnresolvedPgFactoryDiscrepancy } from "./pg-factory-discrepancy.js";
import { factoryManifestDigest } from "./factory-manifest.js";
import { databaseNow, lockFactoryBatchGraph } from "./pg-factory-locks.js";
import {
  batchStatusAfter,
  custodyAfter,
  pgManifest,
  requiredCheckpoint,
  scanSets,
} from "./pg-factory-support.js";
import type {
  FactoryCheckpointInput,
  FactoryCheckpointResult,
  FactoryManifestRow,
} from "./factory-types.js";

async function nextAttemptNo(
  client: SqlClient,
  input: FactoryCheckpointInput,
): Promise<number | null> {
  const result = await client.query<Readonly<{ attempt_no: number }>>(
    `SELECT COALESCE(MAX(attempt_no), 0)::integer + 1 AS attempt_no
       FROM production_handoff_attempts
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND batch_id = $3::uuid AND checkpoint = $4`,
    [input.org_id, input.store_id, input.batch_id, input.checkpoint],
  );
  const attemptNo = result.rows[0]?.attempt_no;
  return attemptNo ?? null;
}

async function appendAttempt(
  client: SqlClient,
  input: FactoryCheckpointInput,
  attemptId: string,
  attemptNo: number,
  batchVersion: number,
  sets: NonNullable<ReturnType<typeof scanSets>>,
  now: Date,
  newId: () => string,
): Promise<void> {
  const outcome =
    sets.counts.missing_count === 0 && sets.counts.unexpected_count === 0
      ? "matched"
      : "discrepancy";
  await client.query(
    `INSERT INTO production_handoff_attempts (
       id, org_id, store_id, batch_id, batch_version, checkpoint, attempt_no, outcome,
       expected_count, scanned_count, matched_count, missing_count, unexpected_count,
       staff_id, device_id, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14::uuid, $15::uuid, $16
     )`,
    [
      attemptId,
      input.org_id,
      input.store_id,
      input.batch_id,
      batchVersion,
      input.checkpoint,
      attemptNo,
      outcome,
      sets.counts.manifest_count,
      sets.counts.scan_count,
      sets.counts.matched_count,
      sets.counts.missing_count,
      sets.counts.unexpected_count,
      input.staff_id,
      input.device_id,
      now,
    ],
  );
  const items = [
    ...sets.matched.map((row) => ({ ...row, outcome: "matched" as const })),
    ...sets.missing.map((row) => ({ ...row, outcome: "missing" as const })),
    ...sets.unexpected.map((barcode) => ({
      barcode,
      garment_id: null,
      outcome: "unexpected" as const,
    })),
  ];
  for (const item of items) {
    await client.query(
      `INSERT INTO production_handoff_attempt_items (
         id, org_id, store_id, batch_id, attempt_id, checkpoint,
         garment_id, barcode, outcome, recorded_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
                 $7::uuid, $8, $9, $10)`,
      [
        newId(),
        input.org_id,
        input.store_id,
        input.batch_id,
        attemptId,
        input.checkpoint,
        item.garment_id,
        item.barcode,
        item.outcome,
        now,
      ],
    );
  }
}

async function insertDispatchStatusLogs(
  client: SqlClient,
  input: FactoryCheckpointInput,
  manifest: readonly FactoryManifestRow[],
  now: Date,
  newId: () => string,
): Promise<void> {
  if (input.checkpoint !== "store_dispatch") return;
  for (const garment of manifest) {
    if (garment.status !== "received" && garment.status !== "reworked") continue;
    await client.query(
      `INSERT INTO garment_status_log (
         id, org_id, store_id, order_id, garment_id,
         from_status, to_status, reason, staff_id, at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6, 'washing', 'factory_store_dispatch', $7::uuid, $8)`,
      [
        newId(),
        input.org_id,
        input.store_id,
        garment.order_id,
        garment.garment_id,
        garment.status,
        input.staff_id,
        now,
      ],
    );
  }
}

async function advanceExactCheckpoint(
  client: SqlClient,
  input: FactoryCheckpointInput,
  attemptId: string,
  manifest: readonly FactoryManifestRow[],
  now: Date,
  newId: () => string,
): Promise<void> {
  await insertDispatchStatusLogs(client, input, manifest, now, newId);
  const garmentIds = manifest.map((row) => row.garment_id);
  const completed = input.checkpoint === "store_receive";
  await client.query(
    `UPDATE garments
        SET custody_state = $4,
            active_production_batch_id = CASE WHEN $5::boolean THEN NULL ELSE $3::uuid END,
            status = CASE
              WHEN $6::text = 'store_dispatch' AND status IN ('received', 'reworked')
                THEN 'washing'
              ELSE status
            END,
            rack_zone = CASE WHEN $6::text = 'store_dispatch' THEN NULL ELSE rack_zone END,
            rack_slot = CASE WHEN $6::text = 'store_dispatch' THEN NULL ELSE rack_slot END,
            racked_at = CASE WHEN $6::text = 'store_dispatch' THEN NULL ELSE racked_at END,
            racked_by_staff_id = CASE WHEN $6::text = 'store_dispatch' THEN NULL ELSE racked_by_staff_id END
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND id = ANY($7::uuid[])`,
    [
      input.org_id,
      input.store_id,
      input.batch_id,
      custodyAfter(input.checkpoint),
      completed,
      input.checkpoint,
      garmentIds,
    ],
  );
  if (completed) {
    await client.query(
      `UPDATE batch_garments
          SET state = 'completed', updated_by_staff_id = $4::uuid,
              updated_by_device_id = $5::uuid, updated_at = $6
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid
          AND garment_id = ANY($7::uuid[]) AND state = 'active'`,
      [
        input.org_id,
        input.store_id,
        input.batch_id,
        input.staff_id,
        input.device_id,
        now,
        garmentIds,
      ],
    );
  }
  await client.query(
    `INSERT INTO production_handoff_checkpoints (
       id, org_id, store_id, batch_id, checkpoint, attempt_id, outcome,
       matched_count, missing_count, unexpected_count, staff_id, device_id, completed_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, 'matched',
               $7, 0, 0, $8::uuid, $9::uuid, $10)`,
    [
      newId(),
      input.org_id,
      input.store_id,
      input.batch_id,
      input.checkpoint,
      attemptId,
      manifest.length,
      input.staff_id,
      input.device_id,
      now,
    ],
  );
}

export async function recordPgFactoryCheckpoint(
  client: SqlClient,
  input: FactoryCheckpointInput,
  newId: () => string,
): Promise<FactoryCheckpointResult | null> {
  if (input.device_id === null) return null;
  const graph = await lockFactoryBatchGraph(client, input, input.batch_id);
  if (
    graph === null ||
    graph.batch.version !== input.expected_version ||
    requiredCheckpoint(graph.batch.status) !== input.checkpoint
  ) {
    return null;
  }
  if (
    await hasUnresolvedPgFactoryDiscrepancy(client, input, graph.batch.version, input.checkpoint)
  ) {
    return null;
  }
  const allManifest = pgManifest(graph.garments);
  const activeManifest = allManifest.filter((row) => row.member_state === "active");
  const digest = factoryManifestDigest(allManifest);
  if (input.expected_manifest_digest !== undefined && input.expected_manifest_digest !== digest) {
    return null;
  }
  const sets = scanSets(activeManifest, input.garment_ids, input.scanned_barcodes);
  if (sets === null) return null;
  if (
    input.checkpoint === "factory_dispatch" &&
    activeManifest.some((row) => row.qc_status !== "pass" || row.status !== "ready")
  ) {
    return null;
  }
  const attemptNo = await nextAttemptNo(client, input);
  if (attemptNo === null) return null;
  const now = await databaseNow(client);
  const attemptId = newId();
  await appendAttempt(
    client,
    input,
    attemptId,
    attemptNo,
    graph.batch.version,
    sets,
    now.date,
    newId,
  );
  const exact = sets.counts.missing_count === 0 && sets.counts.unexpected_count === 0;
  if (!exact) {
    return Object.freeze({
      batch_id: input.batch_id,
      status: graph.batch.status,
      version: graph.batch.version,
      manifest_digest: digest,
      checkpoint: input.checkpoint,
      attempt_id: attemptId,
      outcome: "discrepancy",
      matched_count: sets.counts.matched_count,
      missing_count: sets.counts.missing_count,
      unexpected_count: sets.counts.unexpected_count,
    });
  }
  await advanceExactCheckpoint(client, input, attemptId, activeManifest, now.date, newId);
  const nextStatus = batchStatusAfter(input.checkpoint);
  const updated = await client.query<Readonly<{ version: number }>>(
    `UPDATE production_batches
        SET status = $4, version = version + 1,
            updated_by_staff_id = $5::uuid, updated_by_device_id = $6::uuid,
            updated_at = $7,
            completed_at = CASE WHEN $4 = 'store_received' THEN $7 ELSE completed_at END
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND version = $8
      RETURNING version`,
    [
      input.org_id,
      input.store_id,
      input.batch_id,
      nextStatus,
      input.staff_id,
      input.device_id,
      now.date,
      input.expected_version,
    ],
  );
  const version = updated.rows[0]?.version;
  return version === undefined
    ? null
    : Object.freeze({
        batch_id: input.batch_id,
        status: nextStatus,
        version,
        manifest_digest: digest,
        checkpoint: input.checkpoint,
        attempt_id: attemptId,
        outcome: "matched",
        matched_count: sets.counts.matched_count,
        missing_count: sets.counts.missing_count,
        unexpected_count: sets.counts.unexpected_count,
      });
}
