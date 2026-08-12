import type { FulfillmentIncidentResult, FulfillmentWorkbenchRow } from "./types.js";
import {
  readMemoryTransactionState,
  writeMemoryTransactionState,
} from "../db/memory-unit-of-work.js";
import type {
  FactoryBatchStatus,
  FactoryCancelReason,
  FactoryCheckpoint,
  FactoryCustodyState,
  FactoryDiscrepancyReason,
  FactoryMemberState,
  FactoryQcReason,
  FactoryQcStatus,
} from "./factory-types.js";

export type MemoryGarment = FulfillmentWorkbenchRow &
  Readonly<{
    org_id: string;
    store_id: string;
    custody_state: FactoryCustodyState;
    active_production_batch_id: string | null;
    customer_pii_purged_at: number | null;
    order_status: "open" | "closed";
  }>;
export type MemoryFactoryBatch = Readonly<{
  batch_id: string;
  org_id: string;
  store_id: string;
  factory_code: string;
  status: FactoryBatchStatus;
  version: number;
  manifest_digest: string;
  exception_count: number;
  cancel_reason: FactoryCancelReason | null;
  created_at: number;
  updated_at: number;
}>;
export type MemoryFactoryMember = Readonly<{
  batch_id: string;
  garment_id: string;
  order_id: string;
  member_state: FactoryMemberState;
  qc_status: FactoryQcStatus;
}>;
export type MemoryAttemptItem = Readonly<{
  barcode: string;
  garment_id: string | null;
  outcome: "matched" | "missing" | "unexpected";
}>;
export type MemoryFactoryAttempt = Readonly<{
  attempt_id: string;
  batch_id: string;
  batch_version: number;
  checkpoint: FactoryCheckpoint;
  outcome: "matched" | "discrepancy";
  items: readonly MemoryAttemptItem[];
  recorded_at: number;
}>;
export type MemoryFactoryCheckpoint = Readonly<{
  batch_id: string;
  checkpoint: FactoryCheckpoint;
  attempt_id: string;
  outcome: "matched" | "reconciled";
  matched_count: number;
  missing_count: number;
  unexpected_count: number;
  completed_at: number;
}>;
export type MemoryFactoryResolution = Readonly<{
  batch_id: string;
  attempt_id: string;
  reason_code: FactoryDiscrepancyReason;
  resolved_at: number;
}>;
export type MemoryFactoryQuality = Readonly<{
  batch_id: string;
  garment_id: string;
  outcome: Exclude<FactoryQcStatus, "pending">;
  reason_code: FactoryQcReason | null;
  inspected_at: number;
}>;

export type MemoryFulfillmentSnapshot = Readonly<{
  garments: readonly MemoryGarment[];
  incidents: readonly FulfillmentIncidentResult[];
  batches: readonly MemoryFactoryBatch[];
  members: readonly MemoryFactoryMember[];
  attempts: readonly MemoryFactoryAttempt[];
  checkpoints: readonly MemoryFactoryCheckpoint[];
  resolutions: readonly MemoryFactoryResolution[];
  quality: readonly MemoryFactoryQuality[];
}>;

export type MemoryFulfillmentState = Readonly<{
  read: () => MemoryFulfillmentSnapshot;
  mutate: <T>(
    operation: (current: MemoryFulfillmentSnapshot) => readonly [MemoryFulfillmentSnapshot, T],
  ) => T;
}>;

function normalizeGarment(row: FulfillmentWorkbenchRow): MemoryGarment {
  return Object.freeze({
    ...row,
    org_id: row.org_id ?? "",
    store_id: row.store_id ?? "",
    custody_state: row.custody_state ?? "store",
    active_production_batch_id: row.active_production_batch_id ?? null,
    customer_pii_purged_at: row.customer_pii_purged_at ?? null,
    order_status: row.order_status ?? "open",
  });
}

export function createMemoryFulfillmentState(
  garments: readonly FulfillmentWorkbenchRow[],
): MemoryFulfillmentState {
  const transactionOwner = Object.freeze({});
  let snapshot: MemoryFulfillmentSnapshot = Object.freeze({
    garments: Object.freeze(garments.map(normalizeGarment)),
    incidents: Object.freeze([]),
    batches: Object.freeze([]),
    members: Object.freeze([]),
    attempts: Object.freeze([]),
    checkpoints: Object.freeze([]),
    resolutions: Object.freeze([]),
    quality: Object.freeze([]),
  });
  return Object.freeze({
    read: () => readMemoryTransactionState(transactionOwner, snapshot),
    mutate: <T>(
      operation: (current: MemoryFulfillmentSnapshot) => readonly [MemoryFulfillmentSnapshot, T],
    ): T => {
      const current = readMemoryTransactionState(transactionOwner, snapshot);
      const [next, result] = operation(current);
      const frozen = Object.freeze(next);
      writeMemoryTransactionState(
        transactionOwner,
        () => snapshot,
        frozen,
        (committed) => {
          snapshot = committed;
        },
      );
      return result;
    },
  });
}
