export {
  FactoryHandoffStateError,
  advanceFactoryHandoff,
  canAdvanceFactoryHandoff,
  canCancelFactoryBatch,
  computeHandoffDifference,
  expectedFactoryHandoffCheckpoint,
} from "./lifecycle.js";
export type {
  FactoryBatchStatus,
  FactoryHandoffAdvance,
  FactoryHandoffCheckpoint,
  GarmentCustodyState,
  HandoffDifference,
} from "./lifecycle.js";
