/**
 * D1 Electron shell — app:// SPA + security baseline + tray / single-instance.
 * No business validation; Edge hosts UI/shell and execution adapters only.
 */
import { app, BrowserWindow } from "electron";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeBundleRootFromSpaRoot,
  loadCanonicalManifest,
  verifySpaIntegrity,
} from "./lib/integrity.js";
import {
  manifestPathFromSpaRoot,
  packageRootFromModuleUrl,
  preloadPathFromDistDir,
  spaRootFromPackageRoot,
} from "./lib/paths.js";
import { createRuntimeState, registerIpcHandlers } from "./ipc.js";
import { claimPrimaryInstance, onSecondInstance } from "./shell/single-instance.js";
import { createAppTray } from "./shell/tray.js";
import { createMainWindow } from "./window.js";

const distDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = packageRootFromModuleUrl(import.meta.url);
const spaResourceRoot = spaRootFromPackageRoot(packageRoot);
const manifestPath = manifestPathFromSpaRoot(spaResourceRoot);
const preloadPath = preloadPathFromDistDir(distDir);

let mainWindow: BrowserWindow | null = null;
let disposeTray: (() => void) | null = null;
const runtime = createRuntimeState();

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

function boot(): void {
  const { manifest, bundleId } = loadCanonicalManifest(manifestPath);
  const activeSpaRoot = activeBundleRootFromSpaRoot(spaResourceRoot, bundleId);
  const verified = verifySpaIntegrity(activeSpaRoot, manifest);
  console.log("[edge-agent] SPA integrity ok", bundleId, Object.keys(verified.entries).length);

  registerIpcHandlers({
    spaRoot: activeSpaRoot,
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
