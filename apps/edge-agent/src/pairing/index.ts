export {
  PAIRING_CODE_DIGITS,
  PAIRING_CODE_TTL_MS,
  generateDigitCode,
  OneTimePairingCodeService,
} from "./one-time-code.js";
export type {
  PairingCodeIssue,
  PairingCodeStatus,
  PairingConsumeError,
  PairingConsumeOk,
  PairingConsumeResult,
} from "./one-time-code.js";

export {
  DEVICE_KEY_ALGORITHM,
  MemoryDeviceKeyStore,
  UnimplementedOsDeviceKeyStore,
  base64UrlToBytes,
  bytesToBase64Url,
  exportPublicKeySpkiBase64Url,
  generateEd25519Material,
  importPublicKeySpkiBase64Url,
} from "./device-keys.js";
export type { DeviceKeyMaterial, DeviceKeyStore, DevicePublicKeyExport } from "./device-keys.js";

export { verifyCapabilityTicket } from "./verify-ticket.js";
export type {
  TicketVerifyContext,
  TicketVerifyError,
  TicketVerifyErrorCode,
  TicketVerifyOk,
  TicketVerifyResult,
} from "./verify-ticket.js";

export { EDGE_SIGNED_PROTOCOL_VERSION, signReceipt } from "./sign-receipt.js";
export type { SignedExecutionReceipt } from "./sign-receipt.js";

export { createPairingSession } from "./session.js";
export type { PairingCreateCodeResult, PairingSession, PairingSessionStatus } from "./session.js";
