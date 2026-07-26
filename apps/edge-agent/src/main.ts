/**
 * D1 Electron shell — app:// SPA + security baseline + tray / single-instance.
 * No business validation; Edge hosts UI/shell and execution adapters only.
 */
import { app, BrowserWindow, ipcMain, net, protocol, session, type Session } from "electron";
import { randomUUID } from "node:crypto";
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
  spaRootForRuntime,
} from "./lib/paths.js";
import { APP_SCHEME } from "./lib/security-prefs.js";
import { createAppProtocolHandler } from "./protocol.js";
import { claimPrimaryInstance, onSecondInstance } from "./shell/single-instance.js";
import { createAppTray } from "./shell/tray.js";
import {
  configureDesktopSession,
  DESKTOP_SESSION_PARTITION,
} from "./transport/electron-session.js";
import {
  createElectronDesktopDependencies,
  type ElectronDesktopDependencyOptions,
} from "./desktop/electron-adapter.js";
import { loadOrCreateDeviceId } from "./desktop/device-identity.js";
import { createDesktopHttpTransport } from "./desktop/http-transport.js";
import {
  registerDesktopOperationHandlers,
  type DesktopIpcMainSurface,
} from "./transport/handlers.js";
import { createMainWindow } from "./window.js";

const distDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = packageRootFromModuleUrl(import.meta.url);
const spaResourceRoot = spaRootForRuntime({
  isPackaged: app.isPackaged,
  packageRoot,
  resourcesPath: process.resourcesPath,
});
const manifestPath = manifestPathFromSpaRoot(spaResourceRoot);
const preloadPath = preloadPathFromDistDir(distDir);

let mainWindow: BrowserWindow | null = null;
let mainWindowReady: Promise<void> | null = null;
let activeDesktopSession: Session | null = null;
let disposeTray: (() => void) | null = null;

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

async function showMainWindow(): Promise<void> {
  if (!mainWindow) {
    if (activeDesktopSession === null) return;
    const handle = createMainWindow(preloadPath, activeDesktopSession);
    const createdWindow = handle.window;
    mainWindow = createdWindow;
    mainWindowReady = handle.ready;
    createdWindow.on("closed", () => {
      if (mainWindow === createdWindow) mainWindow = null;
    });
    try {
      await handle.ready;
    } catch (error) {
      if (mainWindow === createdWindow) mainWindow = null;
      if (!createdWindow.isDestroyed()) createdWindow.destroy();
      throw error;
    } finally {
      if (mainWindowReady === handle.ready) mainWindowReady = null;
    }
  } else if (mainWindowReady !== null) {
    await mainWindowReady;
  }
  const readyWindow = mainWindow;
  if (readyWindow === null) return;
  if (readyWindow.isMinimized()) readyWindow.restore();
  readyWindow.show();
  readyWindow.focus();
}

async function boot(): Promise<void> {
  const { manifest, bundleId } = loadCanonicalManifest(manifestPath);
  const activeSpaRoot = activeBundleRootFromSpaRoot(spaResourceRoot, bundleId);
  const verified = verifySpaIntegrity(activeSpaRoot, manifest);
  console.log("[edge-agent] SPA integrity ok", bundleId, Object.keys(verified.entries).length);

  const desktopSession = session.fromPartition(DESKTOP_SESSION_PARTITION);
  await configureDesktopSession(
    desktopSession,
    APP_SCHEME,
    createAppProtocolHandler(activeSpaRoot, manifest),
  );
  activeDesktopSession = desktopSession;

  const deviceId = await loadOrCreateDeviceId({
    userDataPath: app.getPath("userData"),
    randomUUID,
  });
  const desktopTransport = createDesktopHttpTransport(
    createElectronDesktopDependencies({
      net: net as unknown as ElectronDesktopDependencyOptions["net"],
      session: desktopSession as unknown as ElectronDesktopDependencyOptions["session"],
      deviceId,
    }),
  );
  registerDesktopOperationHandlers({
    ipcMain: ipcMain as unknown as DesktopIpcMainSurface,
    service: desktopTransport,
    expectedWebContentsId: () => mainWindow?.webContents.id ?? null,
  });

  await showMainWindow();
  const tray = createAppTray({
    getWindow: () => mainWindow,
    onQuit: () => app.quit(),
  });
  disposeTray = tray.dispose;
}

if (!claimPrimaryInstance(app)) {
  app.quit();
} else {
  const showMainWindowOrExit = (): void => {
    void showMainWindow().catch((error: unknown) => {
      console.error("[edge-agent] window activation failed", error);
      app.exit(1);
    });
  };
  onSecondInstance(app, showMainWindowOrExit);

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
    if (app.isReady()) showMainWindowOrExit();
  });

  app.on("before-quit", () => {
    disposeTray?.();
  });
}
