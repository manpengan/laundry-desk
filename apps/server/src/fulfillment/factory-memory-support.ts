import type { GarmentStatus } from "@laundry/domain";

import { factoryManifestDigest, sortedManifest } from "./factory-manifest.js";
import type {
  MemoryAttemptItem,
  MemoryFactoryBatch,
  MemoryFactoryMember,
  MemoryFulfillmentSnapshot,
  MemoryGarment,
} from "./factory-memory-state.js";
import type {
  FactoryBatchListRow,
  FactoryCheckpoint,
  FactoryConfirmationCounts,
  FactoryConfirmationSummary,
  FactoryCheckpointInput,
  FactoryMutationResult,
  FactoryManifestRow,
} from "./factory-types.js";

export function factoryMutation(
  snapshot: MemoryFulfillmentSnapshot,
  batch: MemoryFactoryBatch,
): FactoryMutationResult {
  return Object.freeze({
    batch_id: batch.batch_id,
    status: batch.status,
    version: batch.version,
    manifest_digest: factoryManifestDigest(manifestFor(snapshot, batch.batch_id)),
  });
}

export const ZERO_COUNTS: FactoryConfirmationCounts = Object.freeze({
  manifest_count: 0,
  scan_count: 0,
  matched_count: 0,
  missing_count: 0,
  unexpected_count: 0,
  pass_count: 0,
  rework_count: 0,
});

export function scopedBatch(
  snapshot: MemoryFulfillmentSnapshot,
  orgId: string,
  storeId: string,
  batchId: string,
): MemoryFactoryBatch | null {
  return (
    snapshot.batches.find(
      (batch) => batch.batch_id === batchId && batch.org_id === orgId && batch.store_id === storeId,
    ) ?? null
  );
}

export function membersFor(
  snapshot: MemoryFulfillmentSnapshot,
  batchId: string,
  activeOnly = false,
): readonly MemoryFactoryMember[] {
  return Object.freeze(
    snapshot.members.filter(
      (member) => member.batch_id === batchId && (!activeOnly || member.member_state === "active"),
    ),
  );
}

export function garmentFor(
  snapshot: MemoryFulfillmentSnapshot,
  garmentId: string,
  orgId?: string,
  storeId?: string,
): MemoryGarment | null {
  return (
    snapshot.garments.find(
      (garment) =>
        garment.garment_id === garmentId &&
        (orgId === undefined || garment.org_id === orgId) &&
        (storeId === undefined || garment.store_id === storeId),
    ) ?? null
  );
}

export function validCreateRows(
  snapshot: MemoryFulfillmentSnapshot,
  orgId: string,
  storeId: string,
  garmentIds: readonly string[],
) {
  const unique = new Set(garmentIds);
  const rows = snapshot.garments.filter(
    (garment) =>
      garment.org_id === orgId && garment.store_id === storeId && unique.has(garment.garment_id),
  );
  if (
    unique.size !== garmentIds.length ||
    rows.length !== garmentIds.length ||
    rows.some(
      (garment) =>
        garment.order_status !== "open" ||
        garment.customer_pii_purged_at !== null ||
        (garment.status !== "received" && garment.status !== "reworked") ||
        garment.custody_state !== "store" ||
        garment.active_production_batch_id !== null,
    )
  ) {
    return null;
  }
  return Object.freeze(rows);
}

export function manifestFor(
  snapshot: MemoryFulfillmentSnapshot,
  batchId: string,
  activeOnly = false,
): readonly FactoryManifestRow[] {
  const batch = snapshot.batches.find((candidate) => candidate.batch_id === batchId);
  if (batch === undefined) return Object.freeze([]);
  const rows = membersFor(snapshot, batchId, activeOnly).flatMap((member) => {
    const garment = garmentFor(snapshot, member.garment_id, batch.org_id, batch.store_id);
    return garment === null
      ? []
      : [
          Object.freeze({
            garment_id: garment.garment_id,
            order_id: garment.order_id,
            ticket_no: garment.ticket_no,
            barcode: garment.barcode,
            status: garment.status,
            custody_state: garment.custody_state,
            member_state: member.member_state,
            qc_status: member.qc_status,
          }),
        ];
  });
  return sortedManifest(rows);
}

export function batchListRow(
  snapshot: MemoryFulfillmentSnapshot,
  batch: MemoryFactoryBatch,
): FactoryBatchListRow {
  return Object.freeze({
    batch_id: batch.batch_id,
    factory_code: batch.factory_code,
    status: batch.status,
    version: batch.version,
    manifest_count: membersFor(snapshot, batch.batch_id).length,
    exception_count: batch.exception_count,
    updated_at: batch.updated_at,
  });
}

export function summaryFor(
  snapshot: MemoryFulfillmentSnapshot,
  input: Readonly<{
    operation: FactoryConfirmationSummary["operation"];
    batch: MemoryFactoryBatch | null;
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
    batch_id: input.batch?.batch_id ?? null,
    expected_version: input.expectedVersion,
    checkpoint: input.checkpoint,
    factory_code: input.factoryCode,
    ticket_nos: Object.freeze(manifest.map((row) => row.ticket_no).sort()),
    barcodes: Object.freeze(manifest.map((row) => row.barcode).sort()),
    counts: input.counts ?? Object.freeze({ ...ZERO_COUNTS, manifest_count: manifest.length }),
    manifest_digest: factoryManifestDigest(input.digestManifest ?? manifest),
  });
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const unique = new Set(left);
  return unique.size === left.length && right.every((value) => unique.has(value));
}

export function hasUnresolvedFactoryDiscrepancy(
  snapshot: MemoryFulfillmentSnapshot,
  batchId: string,
  batchVersion: number,
  checkpoint: FactoryCheckpoint,
): boolean {
  return snapshot.attempts.some(
    (attempt) =>
      attempt.batch_id === batchId &&
      attempt.batch_version === batchVersion &&
      attempt.checkpoint === checkpoint &&
      attempt.outcome === "discrepancy" &&
      !snapshot.resolutions.some((resolution) => resolution.attempt_id === attempt.attempt_id),
  );
}

export function checkpointSets(snapshot: MemoryFulfillmentSnapshot, input: FactoryCheckpointInput) {
  const manifest = manifestFor(snapshot, input.batch_id, true);
  if (
    !sameStringSet(
      input.garment_ids,
      manifest.map((row) => row.garment_id),
    )
  )
    return null;
  const byBarcode = new Map(manifest.map((row) => [row.barcode, row]));
  const scanned = new Set(input.scanned_barcodes);
  if (scanned.size !== input.scanned_barcodes.length) return null;
  const matched = manifest.filter((row) => scanned.has(row.barcode));
  const missing = manifest.filter((row) => !scanned.has(row.barcode));
  const unexpected = [...scanned].filter((barcode) => !byBarcode.has(barcode)).sort();
  const counts: FactoryConfirmationCounts = Object.freeze({
    ...ZERO_COUNTS,
    manifest_count: manifest.length,
    scan_count: scanned.size,
    matched_count: matched.length,
    missing_count: missing.length,
    unexpected_count: unexpected.length,
  });
  return Object.freeze({
    manifest,
    matched,
    missing,
    unexpected: Object.freeze(unexpected),
    counts,
  });
}

export function canAdvanceFactoryDispatch(
  snapshot: MemoryFulfillmentSnapshot,
  batchId: string,
  garmentIds: readonly string[],
): boolean {
  const batch = snapshot.batches.find((candidate) => candidate.batch_id === batchId);
  if (batch === undefined) return false;
  const wanted = new Set(garmentIds);
  return membersFor(snapshot, batchId, true)
    .filter((member) => wanted.has(member.garment_id))
    .every(
      (member) =>
        member.qc_status === "pass" &&
        garmentFor(snapshot, member.garment_id, batch.org_id, batch.store_id)?.status === "ready",
    );
}

export function advanceMatched(
  current: MemoryFulfillmentSnapshot,
  batch: MemoryFactoryBatch,
  checkpoint: FactoryCheckpoint,
  matchedIds: readonly string[],
  missingIds: readonly string[],
  at: number,
) {
  const matched = new Set(matchedIds);
  const missing = new Set(missingIds);
  const garments = current.garments.map((garment) => {
    if (garment.org_id !== batch.org_id || garment.store_id !== batch.store_id) return garment;
    if (missing.has(garment.garment_id)) {
      return Object.freeze({ ...garment, custody_state: "exception" as const, updated_at: at });
    }
    if (!matched.has(garment.garment_id)) return garment;
    const completed = checkpoint === "store_receive";
    return Object.freeze({
      ...garment,
      status: dispatchStatus(checkpoint, garment.status),
      custody_state: nextCustody(checkpoint),
      active_production_batch_id: completed ? null : batch.batch_id,
      updated_at: at,
    });
  });
  const members = current.members.map((member) => {
    if (member.batch_id !== batch.batch_id) return member;
    if (missing.has(member.garment_id)) {
      return Object.freeze({ ...member, member_state: "exception" as const });
    }
    return matched.has(member.garment_id) && checkpoint === "store_receive"
      ? Object.freeze({ ...member, member_state: "completed" as const })
      : member;
  });
  const nextBatch: MemoryFactoryBatch = Object.freeze({
    ...batch,
    status: nextBatchStatus(checkpoint),
    version: batch.version + 1,
    exception_count: members.filter(
      (member) => member.batch_id === batch.batch_id && member.member_state === "exception",
    ).length,
    updated_at: at,
  });
  return Object.freeze({
    garments: Object.freeze(garments),
    members: Object.freeze(members),
    nextBatch,
  });
}

export function attemptItems(
  sets: NonNullable<ReturnType<typeof checkpointSets>>,
): readonly MemoryAttemptItem[] {
  return Object.freeze([
    ...sets.matched.map((row) =>
      Object.freeze({
        barcode: row.barcode,
        garment_id: row.garment_id,
        outcome: "matched" as const,
      }),
    ),
    ...sets.missing.map((row) =>
      Object.freeze({
        barcode: row.barcode,
        garment_id: row.garment_id,
        outcome: "missing" as const,
      }),
    ),
    ...sets.unexpected.map((barcode) =>
      Object.freeze({ barcode, garment_id: null, outcome: "unexpected" as const }),
    ),
  ]);
}

export function expectedCheckpoint(status: MemoryFactoryBatch["status"]): FactoryCheckpoint | null {
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

export function nextBatchStatus(checkpoint: FactoryCheckpoint): MemoryFactoryBatch["status"] {
  switch (checkpoint) {
    case "store_dispatch":
      return "store_dispatched";
    case "factory_receive":
      return "factory_received";
    case "factory_dispatch":
      return "factory_dispatched";
    case "store_receive":
      return "store_received";
  }
}

export function nextCustody(checkpoint: FactoryCheckpoint) {
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

export function dispatchStatus(
  checkpoint: FactoryCheckpoint,
  current: GarmentStatus,
): GarmentStatus {
  return checkpoint === "store_dispatch" && (current === "received" || current === "reworked")
    ? "washing"
    : current;
}
