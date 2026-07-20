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
  printEnqueue: "edge:print-enqueue",
  printList: "edge:print-list",
} as const;
