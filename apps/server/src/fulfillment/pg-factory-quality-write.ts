import type { GarmentStatus } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import { factoryManifestDigest } from "./factory-manifest.js";
import { hasUnresolvedPgFactoryDiscrepancy } from "./pg-factory-discrepancy.js";
import { databaseNow, lockFactoryBatchGraph } from "./pg-factory-locks.js";
import { pgManifest, sameStringSet } from "./pg-factory-support.js";
import type { FactoryQualityInput, FactoryQualityResult } from "./factory-types.js";

async function appendQualityEvidence(
  client: SqlClient,
  input: FactoryQualityInput,
  check: FactoryQualityInput["checks"][number],
  orderId: string,
  previousStatus: GarmentStatus,
  now: Date,
  newId: () => string,
): Promise<void> {
  const inspection = await client.query<Readonly<{ inspection_no: number }>>(
    `SELECT COALESCE(MAX(inspection_no), 0)::integer + 1 AS inspection_no
       FROM garment_qc_log
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND batch_id = $3::uuid AND garment_id = $4::uuid`,
    [input.org_id, input.store_id, input.batch_id, check.garment_id],
  );
  const inspectionNo = inspection.rows[0]?.inspection_no;
  if (inspectionNo === undefined) throw new Error("Factory QC inspection sequence unavailable");
  await client.query(
    `INSERT INTO garment_qc_log (
       id, org_id, store_id, batch_id, order_id, garment_id,
       inspection_no, outcome, reason_code, staff_id, device_id, inspected_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
               $7, $8, $9, $10::uuid, $11::uuid, $12)`,
    [
      newId(),
      input.org_id,
      input.store_id,
      input.batch_id,
      orderId,
      check.garment_id,
      inspectionNo,
      check.outcome,
      check.reason_code,
      input.staff_id,
      input.device_id,
      now,
    ],
  );
  const nextStatus = check.outcome === "pass" ? "ready" : "reworked";
  if (previousStatus !== nextStatus) {
    await client.query(
      `INSERT INTO garment_status_log (
         id, org_id, store_id, order_id, garment_id,
         from_status, to_status, reason, staff_id, at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6, $7, $8, $9::uuid, $10)`,
      [
        newId(),
        input.org_id,
        input.store_id,
        orderId,
        check.garment_id,
        previousStatus,
        nextStatus,
        check.outcome === "rework" ? `factory_qc:${check.reason_code}` : "factory_qc:pass",
        input.staff_id,
        now,
      ],
    );
  }
  if (check.outcome === "rework") {
    await client.query(
      `INSERT INTO garment_incidents (
         id, org_id, store_id, order_id, garment_id, kind, note,
         compensation_cents, staff_id, created_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 'rework', $6, 0, $7::uuid, $8)`,
      [
        newId(),
        input.org_id,
        input.store_id,
        orderId,
        check.garment_id,
        `factory_qc:${check.reason_code}`,
        input.staff_id,
        now,
      ],
    );
  }
}

export async function recordPgFactoryQuality(
  client: SqlClient,
  input: FactoryQualityInput,
  newId: () => string,
): Promise<FactoryQualityResult | null> {
  if (input.device_id === null) return null;
  const graph = await lockFactoryBatchGraph(client, input, input.batch_id);
  if (
    graph === null ||
    graph.batch.status !== "factory_received" ||
    graph.batch.version !== input.expected_version ||
    !sameStringSet(
      input.garment_ids,
      input.checks.map((check) => check.garment_id),
    )
  ) {
    return null;
  }
  if (
    await hasUnresolvedPgFactoryDiscrepancy(client, input, graph.batch.version, "factory_dispatch")
  ) {
    return null;
  }
  const allManifest = pgManifest(graph.garments);
  const activeById = new Map(
    allManifest.filter((row) => row.member_state === "active").map((row) => [row.garment_id, row]),
  );
  if (
    input.checks.some((check) => {
      const garment = activeById.get(check.garment_id);
      if (garment === undefined || garment.custody_state !== "factory") return true;
      return !["washing", "reworked", "ready"].includes(garment.status);
    })
  ) {
    return null;
  }
  const digest = factoryManifestDigest(allManifest);
  if (input.expected_manifest_digest !== undefined && input.expected_manifest_digest !== digest) {
    return null;
  }
  const now = await databaseNow(client);
  for (const check of input.checks) {
    const garment = activeById.get(check.garment_id)!;
    await appendQualityEvidence(
      client,
      input,
      check,
      garment.order_id,
      garment.status,
      now.date,
      newId,
    );
  }
  for (const check of input.checks) {
    await client.query(
      `UPDATE garments
          SET status = $4, rack_zone = NULL, rack_slot = NULL,
              racked_at = NULL, racked_by_staff_id = NULL
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
      [
        input.org_id,
        input.store_id,
        check.garment_id,
        check.outcome === "pass" ? "ready" : "reworked",
      ],
    );
    await client.query(
      `UPDATE batch_garments
          SET qc_status = $4, updated_by_staff_id = $5::uuid,
              updated_by_device_id = $6::uuid, updated_at = $7
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND batch_id = $3::uuid AND garment_id = $8::uuid AND state = 'active'`,
      [
        input.org_id,
        input.store_id,
        input.batch_id,
        check.outcome,
        input.staff_id,
        input.device_id,
        now.date,
        check.garment_id,
      ],
    );
  }
  const updated = await client.query<Readonly<{ version: number }>>(
    `UPDATE production_batches
        SET version = version + 1,
            updated_by_staff_id = $4::uuid, updated_by_device_id = $5::uuid,
            updated_at = $6
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND version = $7
      RETURNING version`,
    [
      input.org_id,
      input.store_id,
      input.batch_id,
      input.staff_id,
      input.device_id,
      now.date,
      input.expected_version,
    ],
  );
  const version = updated.rows[0]?.version;
  if (version === undefined) return null;
  const passCount = input.checks.filter((check) => check.outcome === "pass").length;
  return Object.freeze({
    batch_id: input.batch_id,
    status: graph.batch.status,
    version,
    manifest_digest: digest,
    pass_count: passCount,
    rework_count: input.checks.length - passCount,
  });
}
