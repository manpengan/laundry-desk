import type { GarmentStatus } from "@laundry/domain";

export type FactoryCheckpoint =
  "store_dispatch" | "factory_receive" | "factory_dispatch" | "store_receive";
export type FactoryBatchStatus =
  | "packing"
  | "store_dispatched"
  | "factory_received"
  | "factory_dispatched"
  | "store_received"
  | "cancelled";
export type FactoryCustodyState = "store" | "to_factory" | "factory" | "to_store" | "exception";
export type FactoryMemberState = "active" | "exception" | "completed";
export type FactoryQcStatus = "pending" | "pass" | "rework";
export type FactoryQcReason = "stain_remaining" | "damage_found" | "finish_incomplete" | "other";
export type FactoryCancelReason = "duplicate_batch" | "customer_request" | "operational_error";
export type FactoryDiscrepancyReason =
  "manifest_corrected" | "recount_verified" | "exception_accepted";

export type FactoryCommandScope = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
  device_id: string | null;
  at: number;
}>;

export type FactoryCreateInput = FactoryCommandScope &
  Readonly<{
    factory_code: string;
    garment_ids: readonly string[];
    expected_manifest_digest?: string | undefined;
  }>;
export type FactoryCancelInput = FactoryCommandScope &
  Readonly<{
    batch_id: string;
    expected_version: number;
    reason_code: FactoryCancelReason;
    expected_manifest_digest?: string | undefined;
  }>;
export type FactoryCheckpointInput = FactoryCommandScope &
  Readonly<{
    batch_id: string;
    checkpoint: FactoryCheckpoint;
    expected_version: number;
    garment_ids: readonly string[];
    scanned_barcodes: readonly string[];
    expected_manifest_digest?: string | undefined;
  }>;
export type FactoryResolveInput = FactoryCommandScope &
  Readonly<{
    batch_id: string;
    attempt_id: string;
    expected_version: number;
    garment_ids: readonly string[];
    reason_code: FactoryDiscrepancyReason;
    expected_manifest_digest?: string | undefined;
  }>;
export type FactoryQualityCheck = Readonly<{
  garment_id: string;
  outcome: Exclude<FactoryQcStatus, "pending">;
  reason_code: FactoryQcReason | null;
}>;
export type FactoryQualityInput = FactoryCommandScope &
  Readonly<{
    batch_id: string;
    expected_version: number;
    garment_ids: readonly string[];
    checks: readonly FactoryQualityCheck[];
    expected_manifest_digest?: string | undefined;
  }>;

export type FactoryMutationResult = Readonly<{
  batch_id: string;
  status: FactoryBatchStatus;
  version: number;
  manifest_digest: string;
}>;
export type FactoryCheckpointResult = FactoryMutationResult &
  Readonly<{
    checkpoint: FactoryCheckpoint;
    attempt_id: string;
    outcome?: "matched" | "discrepancy";
    matched_count: number;
    missing_count: number;
    unexpected_count: number;
  }>;
export type FactoryQualityResult = FactoryMutationResult &
  Readonly<{ pass_count: number; rework_count: number }>;

export type FactoryBatchListRow = Readonly<{
  batch_id: string;
  factory_code: string;
  status: FactoryBatchStatus;
  version: number;
  manifest_count: number;
  exception_count: number;
  updated_at: number;
}>;
export type FactoryEligibleGarment = Readonly<{
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
  status: GarmentStatus;
  custody_state: FactoryCustodyState;
}>;
export type FactoryManifestRow = FactoryEligibleGarment &
  Readonly<{ member_state: FactoryMemberState; qc_status: FactoryQcStatus }>;
export type FactoryCheckpointRow = Readonly<{
  checkpoint: FactoryCheckpoint;
  completed_at: number;
  matched_count: number;
  missing_count: number;
  unexpected_count: number;
}>;
export type FactoryAttemptView = Readonly<{
  attempt_id: string;
  checkpoint: FactoryCheckpoint;
  outcome: "matched" | "discrepancy";
  matched_barcodes: readonly string[];
  missing_barcodes: readonly string[];
  unexpected_barcodes: readonly string[];
  recorded_at: number;
}>;
export type FactoryQualityView = Readonly<{
  garment_id: string;
  outcome: Exclude<FactoryQcStatus, "pending">;
  reason_code: FactoryQcReason | null;
  inspected_at: number;
}>;
export type FactoryBatchListResult = Readonly<{
  batches: readonly FactoryBatchListRow[];
  eligible_garments: readonly FactoryEligibleGarment[];
}>;
export type FactoryBatchDetailResult = Readonly<{
  batch: FactoryBatchListRow;
  manifest: readonly FactoryManifestRow[];
  checkpoints: readonly FactoryCheckpointRow[];
  latest_attempt: FactoryAttemptView | null;
  quality_checks: readonly FactoryQualityView[];
}>;

export type FactoryConfirmationCounts = Readonly<{
  manifest_count: number;
  scan_count: number;
  matched_count: number;
  missing_count: number;
  unexpected_count: number;
  pass_count: number;
  rework_count: number;
}>;
export type FactoryConfirmationSummary = Readonly<{
  kind: "factory_handoff";
  operation:
    "batch_create" | "batch_cancel" | "checkpoint_record" | "discrepancy_resolve" | "quality_check";
  batch_id: string | null;
  expected_version: number | null;
  checkpoint: FactoryCheckpoint | null;
  factory_code: string;
  ticket_nos: readonly string[];
  barcodes: readonly string[];
  counts: FactoryConfirmationCounts;
  manifest_digest: string;
}>;

export type FactoryPreparationInput =
  | Readonly<{ operation: "batch_create"; input: FactoryCreateInput }>
  | Readonly<{ operation: "batch_cancel"; input: FactoryCancelInput }>
  | Readonly<{ operation: "checkpoint_record"; input: FactoryCheckpointInput }>
  | Readonly<{ operation: "discrepancy_resolve"; input: FactoryResolveInput }>
  | Readonly<{ operation: "quality_check"; input: FactoryQualityInput }>;

export type FactoryHandoffStore = Readonly<{
  prepareFactoryConfirmation: (
    request: FactoryPreparationInput,
  ) => Promise<FactoryConfirmationSummary | null>;
  createFactoryBatch: (input: FactoryCreateInput) => Promise<FactoryMutationResult | null>;
  cancelFactoryBatch: (input: FactoryCancelInput) => Promise<FactoryMutationResult | null>;
  recordFactoryCheckpoint: (
    input: FactoryCheckpointInput,
  ) => Promise<FactoryCheckpointResult | null>;
  resolveFactoryDiscrepancy: (
    input: FactoryResolveInput,
  ) => Promise<FactoryCheckpointResult | null>;
  recordFactoryQuality: (input: FactoryQualityInput) => Promise<FactoryQualityResult | null>;
  listFactoryBatches: (
    orgId: string,
    storeId: string,
    options: Readonly<{ statuses?: readonly FactoryBatchStatus[]; limit: number }>,
  ) => Promise<FactoryBatchListResult>;
  getFactoryBatch: (
    orgId: string,
    storeId: string,
    batchId: string,
  ) => Promise<FactoryBatchDetailResult | null>;
}>;
