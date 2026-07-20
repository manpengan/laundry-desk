export type {
  HealthReport,
  HistoryEntry,
  InstallInput,
  InstallResult,
  RollbackInput,
  RollbackResult,
  SlotInfo,
  SlotName,
  SupportMatrix,
  SupportMatrixRow,
  UpgradeMode,
  UpgradeState,
} from "./types.js";
export { isHealthPassing, healthFromPassFail } from "./health.js";
export { installStandby } from "./install.js";
export { decideRollback } from "./matrix.js";
export { rollbackSlot } from "./rollback.js";
export { canRestoreSnapshot, sha256Hex, snapshotId } from "./snapshot.js";
export {
  appendHistory,
  createInitialState,
  DEFAULT_MIN_SECURE_VERSION,
  standbySlot,
} from "./state.js";
export { compareVersion, isBelowMinSecure } from "./version.js";
