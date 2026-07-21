/**
 * Electron webPreferences hard baseline (ADR-01 §9 / architecture §13.3).
 * Single source of truth for runtime + static tests.
 */
export const SECURITY_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
} as const;

export const APP_SCHEME = "app";
export const APP_HOST = "local";
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** IPC channel whitelist (preload may only expose these). */
export const IPC_CHANNELS = {
  ping: "edge:ping",
  health: "edge:health",
  upgradeStatus: "edge:upgrade-status",
  connection: "edge:connection",
  /** D4 print:enqueue — status only (no device paths / raw bytes). */
  printEnqueue: "edge:print-enqueue",
  /** D4 print:list — status only. */
  printList: "edge:print-list",
  /** D2: issue 60s single-use pairing code + ensure device pubkey (never private key). */
  pairingCreateCode: "pairing:createCode",
  /** D2: public pairing status only (has key / code active window). */
  pairingStatus: "pairing:status",
  /** D3 — status only; never DEK/KEK. */
  queueStatus: "edge:queue-status",
} as const;
