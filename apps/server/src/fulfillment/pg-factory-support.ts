import { factoryManifestDigest, sortedManifest } from "./factory-manifest.js";
import type { PgLockedBatchGraph, PgLockedFactoryGarment } from "./pg-factory-locks.js";
import type {
  FactoryBatchStatus,
  FactoryCheckpoint,
  FactoryConfirmationCounts,
  FactoryConfirmationSummary,
  FactoryManifestRow,
} from "./factory-types.js";

export const EMPTY_FACTORY_COUNTS: FactoryConfirmationCounts = Object.freeze({
  manifest_count: 0,
  scan_count: 0,
  matched_count: 0,
  missing_count: 0,
  unexpected_count: 0,
  pass_count: 0,
  rework_count: 0,
});

export function pgManifest(rows: readonly PgLockedFactoryGarment[]): readonly FactoryManifestRow[] {
  return sortedManifest(
    rows.map((row) =>
      Object.freeze({
        garment_id: row.garment_id,
        order_id: row.order_id,
        ticket_no: row.ticket_no,
        barcode: row.barcode,
        status: row.status,
        custody_state: row.custody_state,
        member_state: row.member_state ?? ("active" as const),
        qc_status: row.qc_status ?? ("pending" as const),
      }),
    ),
  );
}

export function pgFactorySummary(
  input: Readonly<{
    operation: FactoryConfirmationSummary["operation"];
    graph: PgLockedBatchGraph | null;
    factoryCode: string;
    expectedVersion: number | null;
    checkpoint: FactoryCheckpoint | null;
    manifest: readonly FactoryManifestRow[];
    digestManifest?: readonly FactoryManifestRow[];
    counts?: FactoryConfirmationCounts;
  }>,
): FactoryConfirmationSummary {
  const manifest = sortedManifest(input.manifest);
  return Object.freeze({
    kind: "factory_handoff" as const,
    operation: input.operation,
    batch_id: input.graph?.batch.batch_id ?? null,
    expected_version: input.expectedVersion,
    checkpoint: input.checkpoint,
    factory_code: input.factoryCode,
    ticket_nos: Object.freeze(manifest.map((row) => row.ticket_no).sort()),
    barcodes: Object.freeze(manifest.map((row) => row.barcode).sort()),
    counts:
      input.counts ?? Object.freeze({ ...EMPTY_FACTORY_COUNTS, manifest_count: manifest.length }),
    manifest_digest: factoryManifestDigest(input.digestManifest ?? manifest),
  });
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const unique = new Set(left);
  return unique.size === left.length && right.every((value) => unique.has(value));
}

export function requiredCheckpoint(status: FactoryBatchStatus): FactoryCheckpoint | null {
  switch (status) {
    case "packing":
      return "store_dispatch";
    case "store_dispatched":
      return "factory_receive";
    case "factory_received":
      return "factory_dispatch";
    case "factory_dispatched":
      return "store_receive";
    default:
      return null;
  }
}

export function batchStatusAfter(checkpoint: FactoryCheckpoint) {
  switch (checkpoint) {
    case "store_dispatch":
      return "store_dispatched" as const;
    case "factory_receive":
      return "factory_received" as const;
    case "factory_dispatch":
      return "factory_dispatched" as const;
    case "store_receive":
      return "store_received" as const;
  }
}

export function custodyAfter(checkpoint: FactoryCheckpoint) {
  switch (checkpoint) {
    case "store_dispatch":
      return "to_factory" as const;
    case "factory_receive":
      return "factory" as const;
    case "factory_dispatch":
      return "to_store" as const;
    case "store_receive":
      return "store" as const;
  }
}

export function scanSets(
  manifest: readonly FactoryManifestRow[],
  submittedGarmentIds: readonly string[],
  scannedBarcodes: readonly string[],
) {
  if (
    !sameStringSet(
      submittedGarmentIds,
      manifest.map((row) => row.garment_id),
    )
  )
    return null;
  const scanned = new Set(scannedBarcodes);
  if (scanned.size !== scannedBarcodes.length) return null;
  const byBarcode = new Map(manifest.map((row) => [row.barcode, row]));
  const matched = manifest.filter((row) => scanned.has(row.barcode));
  const missing = manifest.filter((row) => !scanned.has(row.barcode));
  const unexpected = [...scanned].filter((barcode) => !byBarcode.has(barcode)).sort();
  const counts: FactoryConfirmationCounts = Object.freeze({
    ...EMPTY_FACTORY_COUNTS,
    manifest_count: manifest.length,
    scan_count: scanned.size,
    matched_count: matched.length,
    missing_count: missing.length,
    unexpected_count: unexpected.length,
  });
  return Object.freeze({
    matched: Object.freeze(matched),
    missing: Object.freeze(missing),
    unexpected: Object.freeze(unexpected),
    counts,
  });
}
