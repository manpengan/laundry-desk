import type { SqlClient } from "../db/types.js";
import { hasUnresolvedPgFactoryDiscrepancy } from "./pg-factory-discrepancy.js";
import { lockFactoryBatchGraph, lockFactoryCreateGarments } from "./pg-factory-locks.js";
import {
  EMPTY_FACTORY_COUNTS,
  pgFactorySummary,
  pgManifest,
  requiredCheckpoint,
  sameStringSet,
  scanSets,
} from "./pg-factory-support.js";
import type {
  FactoryConfirmationCounts,
  FactoryConfirmationSummary,
  FactoryPreparationInput,
} from "./factory-types.js";

type AttemptRow = Readonly<{
  attempt_id: string;
  batch_version: number;
  checkpoint: "store_dispatch" | "factory_receive" | "factory_dispatch" | "store_receive";
  outcome: "matched" | "discrepancy";
  scanned_count: number;
  matched_count: number;
  missing_count: number;
  unexpected_count: number;
}>;

type AttemptItemRow = Readonly<{
  garment_id: string | null;
  outcome: "matched" | "missing" | "unexpected";
}>;

async function latestAttempt(
  client: SqlClient,
  request: Extract<FactoryPreparationInput, { operation: "discrepancy_resolve" }>,
  batchVersion: number,
  checkpoint: AttemptRow["checkpoint"],
): Promise<Readonly<{ attempt: AttemptRow; items: readonly AttemptItemRow[] }> | null> {
  // Attempt evidence is immutable and laundry_app intentionally has no UPDATE
  // privilege; the already-held batch graph lock serializes canonical writers.
  const found = await client.query<AttemptRow>(
    `SELECT id::text AS attempt_id, batch_version, checkpoint, outcome, scanned_count,
            matched_count, missing_count, unexpected_count
      FROM production_handoff_attempts
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid
        AND batch_version = $4 AND checkpoint = $5
      ORDER BY attempt_no DESC, id DESC
      LIMIT 1`,
    [
      request.input.org_id,
      request.input.store_id,
      request.input.batch_id,
      batchVersion,
      checkpoint,
    ],
  );
  const attempt = found.rows[0];
  if (
    attempt === undefined ||
    attempt.attempt_id !== request.input.attempt_id ||
    attempt.outcome !== "discrepancy"
  ) {
    return null;
  }
  const resolution = await client.query(
    `SELECT 1
       FROM production_handoff_discrepancy_resolutions
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND attempt_id = $3::uuid
      LIMIT 1`,
    [request.input.org_id, request.input.store_id, attempt.attempt_id],
  );
  if ((resolution.rowCount ?? resolution.rows.length) > 0) return null;
  const items = await client.query<AttemptItemRow>(
    `SELECT garment_id::text, outcome
       FROM production_handoff_attempt_items
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND attempt_id = $3::uuid
      ORDER BY outcome, barcode`,
    [request.input.org_id, request.input.store_id, attempt.attempt_id],
  );
  return Object.freeze({ attempt, items: Object.freeze(items.rows) });
}

export async function preparePgFactoryConfirmation(
  client: SqlClient,
  request: FactoryPreparationInput,
): Promise<FactoryConfirmationSummary | null> {
  if (request.operation === "batch_create") {
    const rows = await lockFactoryCreateGarments(client, request.input, request.input.garment_ids);
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
    const manifest = pgManifest(rows);
    return pgFactorySummary({
      operation: request.operation,
      graph: null,
      factoryCode: request.input.factory_code,
      expectedVersion: null,
      checkpoint: null,
      manifest,
    });
  }

  const input = request.input;
  const graph = await lockFactoryBatchGraph(client, input, input.batch_id);
  if (graph === null || graph.batch.version !== input.expected_version) return null;
  const allManifest = pgManifest(graph.garments);
  const activeManifest = allManifest.filter((row) => row.member_state === "active");
  if (request.operation === "batch_cancel") {
    if (graph.batch.status !== "packing") return null;
    return pgFactorySummary({
      operation: request.operation,
      graph,
      factoryCode: graph.batch.factory_code,
      expectedVersion: input.expected_version,
      checkpoint: null,
      manifest: allManifest,
    });
  }
  if (request.operation === "checkpoint_record") {
    if (
      requiredCheckpoint(graph.batch.status) !== request.input.checkpoint ||
      (await hasUnresolvedPgFactoryDiscrepancy(
        client,
        input,
        graph.batch.version,
        request.input.checkpoint,
      ))
    ) {
      return null;
    }
    const sets = scanSets(
      activeManifest,
      request.input.garment_ids,
      request.input.scanned_barcodes,
    );
    if (
      sets === null ||
      (request.input.checkpoint === "factory_dispatch" &&
        activeManifest.some((row) => row.qc_status !== "pass" || row.status !== "ready"))
    ) {
      return null;
    }
    return pgFactorySummary({
      operation: request.operation,
      graph,
      factoryCode: graph.batch.factory_code,
      expectedVersion: input.expected_version,
      checkpoint: request.input.checkpoint,
      manifest: activeManifest,
      digestManifest: allManifest,
      counts: sets.counts,
    });
  }
  if (request.operation === "discrepancy_resolve") {
    const checkpoint = requiredCheckpoint(graph.batch.status);
    if (checkpoint === null) return null;
    const latest = await latestAttempt(client, request, graph.batch.version, checkpoint);
    if (
      latest === null ||
      latest.attempt.batch_version !== graph.batch.version ||
      latest.attempt.checkpoint !== checkpoint
    ) {
      return null;
    }
    if (latest.attempt.matched_count === 0) return null;
    const missingIds = latest.items.flatMap((item) =>
      item.outcome === "missing" && item.garment_id !== null ? [item.garment_id] : [],
    );
    if (!sameStringSet(request.input.garment_ids, missingIds)) return null;
    const matchedIds = new Set(
      latest.items.flatMap((item) =>
        item.outcome === "matched" && item.garment_id !== null ? [item.garment_id] : [],
      ),
    );
    if (
      latest.attempt.checkpoint === "factory_dispatch" &&
      allManifest.some(
        (row) =>
          matchedIds.has(row.garment_id) &&
          (row.member_state !== "active" || row.qc_status !== "pass" || row.status !== "ready"),
      )
    ) {
      return null;
    }
    const counts: FactoryConfirmationCounts = Object.freeze({
      ...EMPTY_FACTORY_COUNTS,
      manifest_count: activeManifest.length,
      scan_count: latest.attempt.scanned_count,
      matched_count: latest.attempt.matched_count,
      missing_count: latest.attempt.missing_count,
      unexpected_count: latest.attempt.unexpected_count,
    });
    return pgFactorySummary({
      operation: request.operation,
      graph,
      factoryCode: graph.batch.factory_code,
      expectedVersion: input.expected_version,
      checkpoint: latest.attempt.checkpoint,
      manifest: activeManifest,
      digestManifest: allManifest,
      counts,
    });
  }
  if (
    graph.batch.status !== "factory_received" ||
    (await hasUnresolvedPgFactoryDiscrepancy(
      client,
      input,
      graph.batch.version,
      "factory_dispatch",
    ))
  ) {
    return null;
  }
  const selected = new Set(request.input.garment_ids);
  const checked = activeManifest.filter((row) => selected.has(row.garment_id));
  const checksById = new Map(request.input.checks.map((check) => [check.garment_id, check]));
  if (
    !sameStringSet(
      request.input.garment_ids,
      request.input.checks.map((check) => check.garment_id),
    ) ||
    checked.length !== selected.size ||
    checked.some((row) => {
      const check = checksById.get(row.garment_id);
      return (
        check === undefined ||
        row.custody_state !== "factory" ||
        !["washing", "reworked", "ready"].includes(row.status)
      );
    })
  ) {
    return null;
  }
  const passCount = request.input.checks.filter((check) => check.outcome === "pass").length;
  return pgFactorySummary({
    operation: request.operation,
    graph,
    factoryCode: graph.batch.factory_code,
    expectedVersion: input.expected_version,
    checkpoint: null,
    manifest: checked,
    digestManifest: allManifest,
    counts: Object.freeze({
      ...EMPTY_FACTORY_COUNTS,
      manifest_count: allManifest.length,
      pass_count: passCount,
      rework_count: request.input.checks.length - passCount,
    }),
  });
}
