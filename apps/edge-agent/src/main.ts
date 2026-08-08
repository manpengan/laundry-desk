/**
 * D1 Electron shell — app:// SPA + security baseline + tray / single-instance.
 * No business validation; Edge hosts UI/shell and execution adapters only.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  type Session,
} from "electron";
import { randomUUID, type KeyObject } from "node:crypto";
import { dirname, join } from "node:path";
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
import { createDesktopHttpTransport, DESKTOP_API_BASE_URL } from "./desktop/http-transport.js";
import {
  registerDesktopOperationHandlers,
  type DesktopIpcMainSurface,
} from "./transport/handlers.js";
import { createMainWindow } from "./window.js";
import { FileQueueStore } from "./queue/file-store.js";
import { PersistentEncryptedQueue } from "./queue/persistent-queue.js";
import { SafeStorageKekStore } from "./queue/safe-storage-kek.js";
import { SafeStorageDeviceKeyStore } from "./pairing/safe-storage-device-keys.js";
import {
  SafeStorageAuthorityTrustStore,
  type AuthorityTrustStore,
} from "./pairing/authority-trust.js";
import { discoverCupsQueues } from "./print/cups-process.js";
import { createSignedPrintRuntime, type SignedPrintRuntime } from "./print/runtime.js";
import { OfflineConflictStore } from "./offline/conflict-store.js";
import { FileGrantSequenceStore } from "./offline/grant-sequence-store.js";
import { OfflineCommandRuntime } from "./offline/runtime.js";
import { createOfflineDesktopService } from "./offline/service.js";
import { OfflineReadCache } from "./offline/read-cache.js";
import { createRuntimeUpdateIo, loadUpdatePublicKey } from "./upgrade/runtime-io.js";
import { RuntimeUpdateStateStore } from "./upgrade/runtime-state.js";
import { resolveUpdateConfiguration } from "./upgrade/update-config.js";
import {
  STAGED_HEALTH_ARGUMENT,
  RuntimeUpdateController,
  activationNonceFromArguments,
  launchMacApp,
  macAppBundlePath,
  prepareRuntimeStartup,
  runMacStagedHealth,
  validateMacAppLaunch,
} from "./upgrade/runtime-controller.js";

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
let signedPrintRuntime: SignedPrintRuntime | null = null;
let offlineQueue: PersistentEncryptedQueue | null = null;
let offlineRuntime: OfflineCommandRuntime | null = null;

type BootMode = "normal" | "recovery";

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

async function boot(mode: BootMode): Promise<void> {
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
  const edgeStateRoot = join(app.getPath("userData"), "edge-state");
  const deviceKeyStore = new SafeStorageDeviceKeyStore(edgeStateRoot, safeStorage);
  const deviceKey = deviceKeyStore.load() ?? deviceKeyStore.generate();
  offlineQueue = new PersistentEncryptedQueue({
    kekStore: new SafeStorageKekStore(edgeStateRoot, safeStorage),
    store: new FileQueueStore(edgeStateRoot),
  });
  console.log("[edge-agent] encrypted offline queue ready", offlineQueue.status());
  const desktopTransport = createDesktopHttpTransport(
    createElectronDesktopDependencies({
      net: net as unknown as ElectronDesktopDependencyOptions["net"],
      session: desktopSession as unknown as ElectronDesktopDependencyOptions["session"],
      deviceId,
      deviceSigner: Object.freeze({
        publicKeySpkiBase64Url: deviceKey.exportPublic().publicKeySpkiBase64Url,
        signBytes: (message: Uint8Array) => deviceKey.signBytes(message),
      }),
    }),
  );
  const persistentAuthorityTrust = new SafeStorageAuthorityTrustStore(edgeStateRoot, safeStorage);
  let trustedPrintAuthority: KeyObject | null = null;
  const authorityTrust: AuthorityTrustStore = Object.freeze({
    accept(publicKey: KeyObject): boolean {
      const accepted = persistentAuthorityTrust.accept(publicKey);
      if (accepted) trustedPrintAuthority = publicKey;
      return accepted;
    },
  });
  offlineRuntime = new OfflineCommandRuntime({
    queue: offlineQueue,
    conflicts: new OfflineConflictStore(edgeStateRoot),
    grantSequences: new FileGrantSequenceStore(edgeStateRoot),
    transport: desktopTransport,
    authorityTrust,
    onDiagnostic:
      process.env.LAUNDRY_ACCEPTANCE_DIAGNOSTICS === "offline_queue"
        ? (event) => console.error(`[edge-agent] offline diagnostic ${event}`)
        : undefined,
  });
  if (mode === "recovery") offlineRuntime.setLeaseIssuanceBlocked(true);
  const desktopService = createOfflineDesktopService(
    desktopTransport,
    offlineRuntime,
    new OfflineReadCache({
      rootPath: edgeStateRoot,
      safeStorage,
      authorityTrust,
    }),
    { recoveryReadOnly: mode === "recovery" },
  );
  const cupsQueue = process.env.LAUNDRY_CUPS_QUEUE?.trim() ?? "";
  if (mode === "normal" && cupsQueue.length > 0) {
    signedPrintRuntime = await createSignedPrintRuntime({
      stateRoot: join(edgeStateRoot, "print-dispatch"),
      queue: cupsQueue,
      deviceId,
      devicePrivateKey: deviceKey.privateKey,
      serverPublicKey: () => trustedPrintAuthority,
      ensureAuthority: async () => {
        let current = desktopTransport.edge.currentSession();
        if (current === null) {
          const refreshed = await desktopTransport.auth.refresh();
          if (!refreshed.ok) return false;
          current = desktopTransport.edge.currentSession();
        }
        return (
          current !== null &&
          (await offlineRuntime!.refreshAuthority(current)) &&
          trustedPrintAuthority !== null
        );
      },
      transport: desktopTransport.edge.print,
      onStatus: (status) => console.log("[edge-agent] signed print", status.state, status.message),
      onError: () => console.error("[edge-agent] signed print poll failed closed"),
    });
    await signedPrintRuntime.controller.start();
  }
  const invalidateContinuity = (): void => {
    offlineRuntime?.invalidateContinuity();
    signedPrintRuntime?.continuity.invalidate();
  };
  powerMonitor.on("suspend", invalidateContinuity);
  powerMonitor.on("resume", invalidateContinuity);
  registerDesktopOperationHandlers({
    ipcMain: ipcMain as unknown as DesktopIpcMainSurface,
    service: desktopService,
    expectedWebContentsId: () => mainWindow?.webContents.id ?? null,
  });

  await showMainWindow();
  const tray = createAppTray({
    getWindow: () => mainWindow,
    onQuit: () => app.quit(),
  });
  disposeTray = tray.dispose;
}

async function runStagedHealthProbe(): Promise<boolean> {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const cupsQueue = process.env.LAUNDRY_CUPS_QUEUE?.trim();
  if (cupsQueue !== undefined && cupsQueue.length > 0) {
    const queues = await discoverCupsQueues();
    if (!queues.includes(cupsQueue)) return false;
  }
  try {
    const response = await net.fetch(`${DESKTOP_API_BASE_URL}/health`, {
      method: "GET",
      redirect: "error",
    });
    if (response.status !== 200) return false;
    const body = JSON.parse(await response.text()) as unknown;
    return (
      typeof body === "object" &&
      body !== null &&
      Reflect.get(body, "ok") === true &&
      typeof Reflect.get(body, "data") === "object" &&
      Reflect.get(Reflect.get(body, "data") as object, "status") === "ready"
    );
  } catch {
    return false;
  }
}

async function runApplication(): Promise<void> {
  if (process.argv.includes(STAGED_HEALTH_ARGUMENT)) {
    const ok = await runStagedHealthProbe();
    process.stdout.write(ok ? '{"ok":true}\n' : '{"ok":false}\n');
    app.exit(ok ? 0 : 1);
    return;
  }

  let updateState: RuntimeUpdateStateStore | null = null;
  let pendingConfirmation: Readonly<{ slot: "A" | "B"; nonce: string }> | null = null;
  let bootMode: BootMode = "normal";
  if (app.isPackaged && process.platform === "darwin") {
    const currentAppPath = macAppBundlePath(process.execPath);
    updateState = new RuntimeUpdateStateStore(join(app.getPath("userData"), "updates"), {
      currentVersion: app.getVersion(),
      currentAppPath,
      minimumSecureVersion: app.getVersion(),
    });
    const startup = prepareRuntimeStartup(
      updateState,
      currentAppPath,
      activationNonceFromArguments(process.argv),
    );
    if (startup.action === "launch") {
      await validateMacAppLaunch(currentAppPath, startup.appPath);
      launchMacApp(startup.appPath, startup.activationNonce);
      app.quit();
      return;
    }
    if (startup.action === "recovery") {
      bootMode = "recovery";
    } else {
      pendingConfirmation = startup.pendingConfirmation;
    }
  }

  await boot(bootMode);
  if (bootMode === "normal" && updateState !== null && pendingConfirmation !== null) {
    updateState.confirmActivation(
      pendingConfirmation.slot,
      pendingConfirmation.nonce,
      new Date().toISOString(),
    );
  }

  const updateConfiguration = await resolveUpdateConfiguration({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    env: process.env,
  });
  if (
    bootMode === "normal" &&
    updateConfiguration.enabled &&
    updateState !== null &&
    offlineQueue !== null
  ) {
    const publicKey = await loadUpdatePublicKey(
      join(process.resourcesPath, "update", "update-public-key.pem"),
    );
    const controller = new RuntimeUpdateController({
      manifestUrl: updateConfiguration.manifest_url,
      publicKey,
      context: {
        channel: updateConfiguration.channel,
        current_version: app.getVersion(),
        installed_minimum_secure_version: updateState.snapshot().minimum_secure_version,
        current_local_schema: 3,
        supported_contracts_majors: [0],
      },
      state: updateState,
      io: createRuntimeUpdateIo(),
      queueStatus: () => offlineQueue!.status(),
      stagedHealth: runMacStagedHealth,
      setPrimaryLeaseBlocked: (blocked) => offlineRuntime?.setLeaseIssuanceBlocked(blocked),
    });
    void controller.checkAndStage().then((result) => {
      console.log("[edge-agent] update check", result);
    });
  }
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
    .then(runApplication)
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
    powerMonitor.removeAllListeners("suspend");
    powerMonitor.removeAllListeners("resume");
    disposeTray?.();
    void signedPrintRuntime?.controller.stop();
  });
}
