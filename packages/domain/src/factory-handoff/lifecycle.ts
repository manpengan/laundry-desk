export type FactoryHandoffCheckpoint =
  "store_dispatch" | "factory_receive" | "factory_dispatch" | "store_receive";

export type FactoryBatchStatus =
  | "packing"
  | "store_dispatched"
  | "factory_received"
  | "factory_dispatched"
  | "store_received"
  | "cancelled";

export type GarmentCustodyState = "store" | "to_factory" | "factory" | "to_store" | "exception";

export type FactoryHandoffAdvance = Readonly<{
  status: FactoryBatchStatus;
  custodyState: Exclude<GarmentCustodyState, "exception">;
}>;

export type HandoffDifference = Readonly<{
  matched: readonly string[];
  missing: readonly string[];
  unexpected: readonly string[];
}>;

const CHECKPOINT_BY_STATUS: Readonly<
  Partial<Record<FactoryBatchStatus, FactoryHandoffCheckpoint>>
> = Object.freeze({
  packing: "store_dispatch",
  store_dispatched: "factory_receive",
  factory_received: "factory_dispatch",
  factory_dispatched: "store_receive",
});

const ADVANCE_BY_CHECKPOINT: Readonly<Record<FactoryHandoffCheckpoint, FactoryHandoffAdvance>> =
  Object.freeze({
    store_dispatch: Object.freeze({ status: "store_dispatched", custodyState: "to_factory" }),
    factory_receive: Object.freeze({ status: "factory_received", custodyState: "factory" }),
    factory_dispatch: Object.freeze({ status: "factory_dispatched", custodyState: "to_store" }),
    store_receive: Object.freeze({ status: "store_received", custodyState: "store" }),
  });

export class FactoryHandoffStateError extends Error {
  readonly status: FactoryBatchStatus;
  readonly checkpoint: FactoryHandoffCheckpoint;

  constructor(status: FactoryBatchStatus, checkpoint: FactoryHandoffCheckpoint) {
    super(`Checkpoint '${checkpoint}' is not valid while batch status is '${status}'`);
    this.name = "FactoryHandoffStateError";
    this.status = status;
    this.checkpoint = checkpoint;
  }
}

export const expectedFactoryHandoffCheckpoint = (
  status: FactoryBatchStatus,
): FactoryHandoffCheckpoint | null => CHECKPOINT_BY_STATUS[status] ?? null;

export const canAdvanceFactoryHandoff = (
  status: FactoryBatchStatus,
  checkpoint: FactoryHandoffCheckpoint,
): boolean => expectedFactoryHandoffCheckpoint(status) === checkpoint;

export const advanceFactoryHandoff = (
  status: FactoryBatchStatus,
  checkpoint: FactoryHandoffCheckpoint,
): FactoryHandoffAdvance => {
  if (!canAdvanceFactoryHandoff(status, checkpoint)) {
    throw new FactoryHandoffStateError(status, checkpoint);
  }
  return ADVANCE_BY_CHECKPOINT[checkpoint];
};

export const canCancelFactoryBatch = (status: FactoryBatchStatus): boolean => status === "packing";

const requireUnique = (values: readonly string[], label: string): ReadonlySet<string> => {
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new TypeError(`${label} must contain unique values`);
  }
  return unique;
};

/**
 * Computes server-authoritative checkpoint evidence without mutating either caller-owned array.
 * Contract validation owns barcode syntax; this function owns deterministic set semantics.
 */
export const computeHandoffDifference = (
  expectedBarcodes: readonly string[],
  scannedBarcodes: readonly string[],
): HandoffDifference => {
  const expected = requireUnique(expectedBarcodes, "Expected barcodes");
  const scanned = requireUnique(scannedBarcodes, "Scanned barcodes");
  const matched = [...expected].filter((barcode) => scanned.has(barcode)).sort();
  const missing = [...expected].filter((barcode) => !scanned.has(barcode)).sort();
  const unexpected = [...scanned].filter((barcode) => !expected.has(barcode)).sort();
  return Object.freeze({
    matched: Object.freeze(matched),
    missing: Object.freeze(missing),
    unexpected: Object.freeze(unexpected),
  });
};
