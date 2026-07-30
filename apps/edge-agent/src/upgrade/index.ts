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
export {
  canonicalizeReleaseManifest,
  evaluateReleaseRollback,
  ReleaseManifestAuthoritySchema,
  SignedReleaseManifestSchema,
  signReleaseManifest,
  verifyReleaseArtifact,
  verifyReleaseManifest,
  verifyReleaseRollbackArtifact,
} from "./release-manifest.js";
export { createRuntimeUpdateIo, loadUpdatePublicKey } from "./runtime-io.js";
export type { RuntimeUpdateIo, UpdateFetch } from "./runtime-io.js";
export { RuntimeUpdateStateStore } from "./runtime-state.js";
export type { RuntimeSlotName, RuntimeUpdateState } from "./runtime-state.js";
export {
  ACTIVATION_ARGUMENT_PREFIX,
  STAGED_HEALTH_ARGUMENT,
  RuntimeUpdateController,
  activationNonceFromArguments,
  launchMacApp,
  macAppBundlePath,
  prepareRuntimeStartup,
  runMacStagedHealth,
  validateMacAppLaunch,
} from "./runtime-controller.js";
export type {
  RuntimeUpdateControllerOptions,
  RuntimeUpdateResult,
  StartupAction,
} from "./runtime-controller.js";
export type {
  ReleaseManifestAuthority,
  ReleaseVerificationContext,
  ReleaseVerificationResult,
  SignedReleaseManifest,
} from "./release-manifest.js";
