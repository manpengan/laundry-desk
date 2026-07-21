/**
 * Library surface for unit tests and future adapters.
 * Runtime entry is `main.ts` (package.json `"main"`).
 */
export { mimeFor } from "./lib/mime.js";
export {
  isSpaManifest,
  loadManifest,
  sha256Hex,
  verifySpaIntegrity,
  type SpaManifest,
} from "./lib/integrity.js";
export { resolveSpaPath } from "./lib/spa-path.js";
export { isValidAppSender } from "./lib/sender.js";
export {
  APP_ENTRY_URL,
  APP_HOST,
  APP_SCHEME,
  IPC_CHANNELS,
  SECURITY_WEB_PREFERENCES,
} from "./lib/security-prefs.js";
export {
  manifestPathFromSpaRoot,
  packageRootFromModuleUrl,
  preloadPathFromDistDir,
  spaRootFromPackageRoot,
} from "./lib/paths.js";
export { createAppProtocolHandler } from "./protocol.js";
export { checkShellHealth, type ShellHealth } from "./shell/health.js";
export { mockConnection, type EdgeConnectionSnapshot } from "./shell/connection-mock.js";
export {
  advanceJob,
  createMockSpool,
  enqueue,
  listJobs,
  type MockPrintJob,
  type MockSpool,
} from "./print/mock-spool.js";
export {
  buildExecutionReceiptPayload,
  createPrintJobStore,
  enqueuePrintJob,
  getPrintJob,
  listPrintJobStatus,
  transitionPrintJob,
  type PrintJobKind,
  type PrintJobRecord,
  type PrintJobStatus,
  type PrintJobStatusView,
  type PrintJobStore,
} from "./print/print-jobs.js";
export {
  buildXp58EscPos,
  escAlign,
  escCut,
  escFeed,
  escInit,
  escLine,
} from "./print/escpos-xp58.js";
export {
  renderTicketTemplate,
  type RenderedTicket,
  type TicketLineItem,
  type TicketTemplateInput,
} from "./print/template-render.js";
export {
  DEFAULT_SAMPLE_TICKET,
  executeJob,
  type ExecuteJobOptions,
  type ExecuteJobResult,
} from "./print/executor.js";
export { fenToYuanGbk, fenToYuanText, YUAN_SIGN_GBK } from "./drivers/render/money-gbk.js";
export {
  estimateCode128Dots,
  estimateCode128Modules,
  fitsXp58,
  XP58_PRINTABLE_DOTS,
} from "./drivers/render/code128-width.js";
export {
  appendHistory,
  canRestoreSnapshot,
  compareVersion,
  createInitialState,
  decideRollback,
  DEFAULT_MIN_SECURE_VERSION,
  healthFromPassFail,
  installStandby,
  isBelowMinSecure,
  isHealthPassing,
  rollbackSlot,
  snapshotId,
  standbySlot,
} from "./upgrade/index.js";
export type {
  HealthReport,
  InstallInput,
  InstallResult,
  RollbackInput,
  RollbackResult,
  SupportMatrix,
  UpgradeState,
} from "./upgrade/index.js";

// D2 pairing + capability ticket verify + execution receipt sign (pure core).
export {
  DEVICE_KEY_ALGORITHM,
  EDGE_SIGNED_PROTOCOL_VERSION,
  MemoryDeviceKeyStore,
  OneTimePairingCodeService,
  PAIRING_CODE_DIGITS,
  PAIRING_CODE_TTL_MS,
  UnimplementedOsDeviceKeyStore,
  createPairingSession,
  generateDigitCode,
  generateEd25519Material,
  signReceipt,
  verifyCapabilityTicket,
} from "./pairing/index.js";
export type {
  DeviceKeyMaterial,
  DeviceKeyStore,
  DevicePublicKeyExport,
  PairingCreateCodeResult,
  PairingSession,
  PairingSessionStatus,
  SignedExecutionReceipt,
  TicketVerifyContext,
  TicketVerifyResult,
} from "./pairing/index.js";
