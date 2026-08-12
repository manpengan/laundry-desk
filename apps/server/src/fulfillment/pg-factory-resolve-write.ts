import type { SqlClient } from "../db/types.js";
import { factoryManifestDigest } from "./factory-manifest.js";
import { databaseNow, lockFactoryBatchGraph } from "./pg-factory-locks.js";
import {
  batchStatusAfter,
  custodyAfter,
  pgManifest,
  requiredCheckpoint,
  sameStringSet,
} from "./pg-factory-support.js";
import type {
  FactoryCheckpoint,
  FactoryCheckpointResult,
  FactoryManifestRow,
  FactoryResolveInput,
} from "./factory-types.js";

type Attempt = Readonly<{
  attempt_id: string;
  batch_version: number;
  checkpoint: FactoryCheckpoint;
  outcome: "matched" | "discrepancy";
  matched_count: number;
  missing_count: number;
  unexpected_count: number;
}>;
type AttemptItem = Readonly<{
  garment_id: string | null;
  barcode: string;
  outcome: "matched" | "missing" | "unexpected";
}>;

async function latestAttempt(
  client: SqlClient,
  input: FactoryResolveInput,
  batchVersion: number,
  checkpoint: FactoryCheckpoint,
): Promise<Readonly<{ attempt: Attempt; items: readonly AttemptItem[] }> | null> {
  // Attempt evidence is immutable and laundry_app intentionally has no UPDATE
  // privilege; the already-held batch graph lock serializes canonical writers.
  const found = await client.query<Attempt>(
    `SELECT id::text AS attempt_id, batch_version, checkpoint, outcome,
            matched_count, missing_count, unexpected_count
      FROM production_handoff_attempts
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid
        AND batch_version = $4 AND checkpoint = $5
      ORDER BY attempt_no DESC, id DESC
      LIMIT 1`,
    [input.org_id, input.store_id, input.batch_id, batchVersion, checkpoint],
  );
  const attempt = found.rows[0];
  if (
    attempt === undefined ||
    attempt.attempt_id !== input.attempt_id ||
    attempt.outcome !== "discrepancy"
  ) {
    return null;
  }
  const already = await client.query(
    `SELECT 1
       FROM production_handoff_discrepancy_resolutions
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND attempt_id = $3::uuid
      LIMIT 1`,
    [input.org_id, input.store_id, attempt.attempt_id],
  );
  if ((already.rowCount ?? already.rows.length) > 0) return null;
  const items = await client.query<AttemptItem>(
    `SELECT garment_id::text, barcode, outcome
       FROM production_handoff_attempt_items
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND attempt_id = $3::uuid
      ORDER BY outcome, barcode`,
    [input.org_id, input.store_id, attempt.attempt_id],
  );
  return Object.freeze({ attempt, items: Object.freeze(items.rows) });
}

async function appendStatusLogs(
  client: SqlClient,
  input: FactoryResolveInput,
  checkpoint: FactoryCheckpoint,
  manifest: readonly FactoryManifestRow[],
  now: Date,
  newId: () => string,
): Promise<void> {
  if (checkpoint !== "store_dispatch") return;
  for (const garment of manifest) {
    if (garment.status !== "received" && garment.status !== "reworked") continue;
    await client.query(
      `INSERT INTO garment_status_log (
         id, org_id, store_id, order_id, garment_id,
         from_status, to_status, reason, staff_id, at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6, 'washing', 'factory_store_dispatch_reconciled', $7::uuid, $8)`,
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

async function applyResolvedCustody(
  client: SqlClient,
  input: FactoryResolveInput,
  checkpoint: FactoryCheckpoint,
  matched: readonly FactoryManifestRow[],
  missingIds: readonly string[],
  now: Date,
  newId: () => string,
): Promise<void> {
  await appendStatusLogs(client, input, checkpoint, matched, now, newId);
  const matchedIds = matched.map((row) => row.garment_id);
  if (matchedIds.length > 0) {
    await client.query(
      `UPDATE garments
          SET custody_state = $4,
              active_production_batch_id = CASE
                WHEN $5::text = 'store_receive' THEN NULL ELSE $3::uuid
              END,
              status = CASE
                WHEN $5::text = 'store_dispatch' AND status IN ('received', 'reworked')
                  THEN 'washing'
                ELSE status
              END,
              rack_zone = CASE WHEN $5::text = 'store_dispatch' THEN NULL ELSE rack_zone END,
              rack_slot = CASE WHEN $5::text = 'store_dispatch' THEN NULL ELSE rack_slot END,
              racked_at = CASE WHEN $5::text = 'store_dispatch' THEN NULL ELSE racked_at END,
              racked_by_staff_id = CASE WHEN $5::text = 'store_dispatch' THEN NULL ELSE racked_by_staff_id END
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND id = ANY($6::uuid[])`,
      [
        input.org_id,
        input.store_id,
        input.batch_id,
        custodyAfter(checkpoint),
        checkpoint,
        matchedIds,
      ],
    );
  }
  if (missingIds.length > 0) {
    await client.query(
      `UPDATE garments
          SET custody_state = 'exception'
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND id = ANY($3::uuid[])`,
      [input.org_id, input.store_id, missingIds],
    );
    await client.query(
      `UPDATE batch_garments
          SET state = 'exception', updated_by_staff_id = $4::uuid,
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
        missingIds,
      ],
    );
  }
  if (checkpoint === "store_receive" && matchedIds.length > 0) {
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
        matchedIds,
      ],
    );
  }
}

export async function resolvePgFactoryDiscrepancy(
  client: SqlClient,
  input: FactoryResolveInput,
  newId: () => string,
): Promise<FactoryCheckpointResult | null> {
  if (input.device_id === null) return null;
  const graph = await lockFactoryBatchGraph(client, input, input.batch_id);
  if (graph === null || graph.batch.version !== input.expected_version) return null;
  const checkpoint = requiredCheckpoint(graph.batch.status);
  if (checkpoint === null) return null;
  const lockedAttempt = await latestAttempt(client, input, graph.batch.version, checkpoint);
  if (
    lockedAttempt === null ||
    lockedAttempt.attempt.batch_version !== graph.batch.version ||
    lockedAttempt.attempt.checkpoint !== checkpoint
  ) {
    return null;
  }
  const allManifest = pgManifest(graph.garments);
  const digest = factoryManifestDigest(allManifest);
  if (input.expected_manifest_digest !== undefined && input.expected_manifest_digest !== digest) {
    return null;
  }
  const missingIds = lockedAttempt.items.flatMap((item) =>
    item.outcome === "missing" && item.garment_id !== null ? [item.garment_id] : [],
  );
  if (!sameStringSet(input.garment_ids, missingIds)) return null;
  const matchedIds = new Set(
    lockedAttempt.items.flatMap((item) =>
      item.outcome === "matched" && item.garment_id !== null ? [item.garment_id] : [],
    ),
  );
  const matched = allManifest.filter((row) => matchedIds.has(row.garment_id));
  if (
    matched.length === 0 ||
    matched.length !== matchedIds.size ||
    matched.some((row) => row.member_state !== "active") ||
    (lockedAttempt.attempt.checkpoint === "factory_dispatch" &&
      matched.some((row) => row.qc_status !== "pass" || row.status !== "ready"))
  ) {
    return null;
  }
  const now = await databaseNow(client);
  await applyResolvedCustody(
    client,
    input,
    lockedAttempt.attempt.checkpoint,
    matched,
    missingIds,
    now.date,
    newId,
  );
  await client.query(
    `INSERT INTO production_handoff_discrepancy_resolutions (
       id, org_id, store_id, batch_id, checkpoint, attempt_id,
       resolution_code, staff_id, device_id, resolved_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid,
               $7, $8::uuid, $9::uuid, $10)`,
    [
      newId(),
      input.org_id,
      input.store_id,
      input.batch_id,
      lockedAttempt.attempt.checkpoint,
      lockedAttempt.attempt.attempt_id,
      input.reason_code,
      input.staff_id,
      input.device_id,
      now.date,
    ],
  );
  await client.query(
    `INSERT INTO production_handoff_checkpoints (
       id, org_id, store_id, batch_id, checkpoint, attempt_id, outcome,
       matched_count, missing_count, unexpected_count, staff_id, device_id, completed_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, 'reconciled',
               $7, $8, $9, $10::uuid, $11::uuid, $12)`,
    [
      newId(),
      input.org_id,
      input.store_id,
      input.batch_id,
      lockedAttempt.attempt.checkpoint,
      lockedAttempt.attempt.attempt_id,
      lockedAttempt.attempt.matched_count,
      lockedAttempt.attempt.missing_count,
      lockedAttempt.attempt.unexpected_count,
      input.staff_id,
      input.device_id,
      now.date,
    ],
  );
  const nextStatus = batchStatusAfter(lockedAttempt.attempt.checkpoint);
  const updated = await client.query<
    Readonly<{ version: number; exception_garment_count: number }>
  >(
    `UPDATE production_batches pb
        SET status = $4, version = version + 1,
            exception_garment_count = (
              SELECT COUNT(*)::integer FROM batch_garments bg
               WHERE bg.org_id = pb.org_id AND bg.store_id = pb.store_id
                 AND bg.batch_id = pb.id AND bg.state = 'exception'
            ),
            updated_by_staff_id = $5::uuid, updated_by_device_id = $6::uuid,
            updated_at = $7,
            completed_at = CASE WHEN $4 = 'store_received' THEN $7 ELSE completed_at END
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND version = $8
      RETURNING version, exception_garment_count`,
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
        checkpoint: lockedAttempt.attempt.checkpoint,
        attempt_id: lockedAttempt.attempt.attempt_id,
        matched_count: lockedAttempt.attempt.matched_count,
        missing_count: lockedAttempt.attempt.missing_count,
        unexpected_count: lockedAttempt.attempt.unexpected_count,
      });
}
