import type { SqlClient } from "../db/types.js";
import { factoryManifestDigest } from "./factory-manifest.js";
import {
  databaseNow,
  lockFactoryBatchGraph,
  lockFactoryCreateGarments,
} from "./pg-factory-locks.js";
import { pgManifest } from "./pg-factory-support.js";
import type {
  FactoryCancelInput,
  FactoryCreateInput,
  FactoryMutationResult,
} from "./factory-types.js";

export async function createPgFactoryBatch(
  client: SqlClient,
  input: FactoryCreateInput,
  newId: () => string,
): Promise<FactoryMutationResult | null> {
  if (input.device_id === null) return null;
  const rows = await lockFactoryCreateGarments(client, input, input.garment_ids);
  if (
    rows === null ||
    rows.some(
      (row) =>
        (row.status !== "received" && row.status !== "reworked") ||
        row.custody_state !== "store" ||
        row.active_production_batch_id !== null,
    )
  ) {
    return null;
  }
  const digest = factoryManifestDigest(pgManifest(rows));
  if (input.expected_manifest_digest !== undefined && input.expected_manifest_digest !== digest) {
    return null;
  }
  const now = await databaseNow(client);
  const batchId = newId();
  await client.query(
    `INSERT INTO production_batches (
       id, org_id, store_id, factory_code, status, version,
       expected_garment_count, exception_garment_count,
       created_by_staff_id, created_by_device_id, created_at,
       updated_by_staff_id, updated_by_device_id, updated_at, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, 'packing', 1, $5, 0,
       $6::uuid, $7::uuid, $8, $6::uuid, $7::uuid, $8, NULL
     )`,
    [
      batchId,
      input.org_id,
      input.store_id,
      input.factory_code,
      rows.length,
      input.staff_id,
      input.device_id,
      now.date,
    ],
  );
  for (const row of rows) {
    await client.query(
      `INSERT INTO batch_garments (
         org_id, store_id, batch_id, order_id, garment_id, state, qc_status,
         added_by_staff_id, added_by_device_id, added_at,
         updated_by_staff_id, updated_by_device_id, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'active', 'pending',
         $6::uuid, $7::uuid, $8, $6::uuid, $7::uuid, $8
       )`,
      [
        input.org_id,
        input.store_id,
        batchId,
        row.order_id,
        row.garment_id,
        input.staff_id,
        input.device_id,
        now.date,
      ],
    );
  }
  await client.query(
    `UPDATE garments
        SET active_production_batch_id = $3::uuid
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND id = ANY($4::uuid[])`,
    [input.org_id, input.store_id, batchId, rows.map((row) => row.garment_id)],
  );
  return Object.freeze({
    batch_id: batchId,
    status: "packing",
    version: 1,
    manifest_digest: digest,
  });
}

export async function cancelPgFactoryBatch(
  client: SqlClient,
  input: FactoryCancelInput,
): Promise<FactoryMutationResult | null> {
  if (input.device_id === null) return null;
  const graph = await lockFactoryBatchGraph(client, input, input.batch_id);
  if (
    graph === null ||
    graph.batch.status !== "packing" ||
    graph.batch.version !== input.expected_version
  ) {
    return null;
  }
  const digest = factoryManifestDigest(pgManifest(graph.garments));
  if (input.expected_manifest_digest !== undefined && input.expected_manifest_digest !== digest) {
    return null;
  }
  const now = await databaseNow(client);
  const garmentIds = graph.garments
    .filter((row) => row.member_state === "active")
    .map((row) => row.garment_id);
  await client.query(
    `UPDATE garments
        SET custody_state = 'store', active_production_batch_id = NULL
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [input.org_id, input.store_id, garmentIds],
  );
  await client.query(
    `UPDATE batch_garments
        SET state = 'completed', updated_by_staff_id = $4::uuid,
            updated_by_device_id = $5::uuid, updated_at = $6
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid
        AND state = 'active'`,
    [input.org_id, input.store_id, input.batch_id, input.staff_id, input.device_id, now.date],
  );
  const updated = await client.query<Readonly<{ version: number }>>(
    `UPDATE production_batches
        SET status = 'cancelled', version = version + 1,
            cancel_reason_code = $8,
            updated_by_staff_id = $4::uuid, updated_by_device_id = $5::uuid,
            updated_at = $6, completed_at = $6
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = 'packing' AND version = $7
      RETURNING version`,
    [
      input.org_id,
      input.store_id,
      input.batch_id,
      input.staff_id,
      input.device_id,
      now.date,
      input.expected_version,
      input.reason_code,
    ],
  );
  const version = updated.rows[0]?.version;
  return version === undefined
    ? null
    : Object.freeze({
        batch_id: input.batch_id,
        status: "cancelled" as const,
        version,
        manifest_digest: digest,
      });
}
