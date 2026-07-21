/**
 * D1 Electron shell — app:// SPA + security baseline + tray / single-instance.
 * No business validation; Edge hosts UI/shell and execution adapters only.
 */
import { app, BrowserWindow, protocol, session } from "electron";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, verifySpaIntegrity } from "./lib/integrity.js";
import {
  manifestPathFromSpaRoot,
  packageRootFromModuleUrl,
  preloadPathFromDistDir,
  spaRootFromPackageRoot,
} from "./lib/paths.js";
import { APP_SCHEME } from "./lib/security-prefs.js";
import { createRuntimeState, registerIpcHandlers } from "./ipc.js";
import { createAppProtocolHandler } from "./protocol.js";
import { claimPrimaryInstance, onSecondInstance } from "./shell/single-instance.js";
import { createAppTray } from "./shell/tray.js";
import { createMainWindow } from "./window.js";

const distDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = packageRootFromModuleUrl(import.meta.url);
const spaRoot = spaRootFromPackageRoot(packageRoot);
const manifestPath = manifestPathFromSpaRoot(spaRoot);
const preloadPath = preloadPathFromDistDir(distDir);

let mainWindow: BrowserWindow | null = null;
let disposeTray: (() => void) | null = null;
const runtime = createRuntimeState();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function showMainWindow(): void {
  if (!mainWindow) {
    mainWindow = createMainWindow(preloadPath);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
}

function boot(): void {
  const manifest = loadManifest(manifestPath);
  const hash = verifySpaIntegrity(spaRoot, manifest);
  console.log("[edge-agent] SPA integrity ok", hash.slice(0, 12));

  protocol.handle(APP_SCHEME, createAppProtocolHandler(spaRoot));
  denyAllPermissions();
  registerIpcHandlers({
    spaRoot,
    manifestPath,
    getUpgradeState: () => runtime.upgrade,
    getSpool: () => runtime.spool,
    setSpool: (spool) => {
      runtime.spool = spool;
    },
    getPrintJobs: () => runtime.printJobs,
    setPrintJobs: (store) => {
      runtime.printJobs = store;
    },
    getPairing: () => runtime.pairing,
    getQueue: () => runtime.queue,
  });

  showMainWindow();
  const tray = createAppTray({
    getWindow: () => mainWindow,
    onQuit: () => app.quit(),
  });
  disposeTray = tray.dispose;
}

if (!claimPrimaryInstance(app)) {
  app.quit();
} else {
  onSecondInstance(app, showMainWindow);

  app
    .whenReady()
    .then(boot)
    .catch((err: unknown) => {
      console.error("[edge-agent] boot failed", err);
      app.exit(1);
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (app.isReady()) showMainWindow();
  });

  app.on("before-quit", () => {
    disposeTray?.();
  });
}
