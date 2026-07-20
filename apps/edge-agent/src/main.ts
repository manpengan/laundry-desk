/**
 * D1 Electron shell — app:// built-in SPA + security baseline (ADR-01 §9).
 * No business validation here; Edge only hosts UI/shell and later execution adapters.
 */
import { app, protocol, session } from "electron";
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
import { registerIpcHandlers } from "./ipc.js";
import { createAppProtocolHandler } from "./protocol.js";
import { createMainWindow } from "./window.js";

const distDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = packageRootFromModuleUrl(import.meta.url);
const spaRoot = spaRootFromPackageRoot(packageRoot);
const preloadPath = preloadPathFromDistDir(distDir);

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

function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
}

function boot(): void {
  const manifest = loadManifest(manifestPathFromSpaRoot(spaRoot));
  const hash = verifySpaIntegrity(spaRoot, manifest);
  console.log("[edge-agent] SPA integrity ok", hash.slice(0, 12));

  protocol.handle(APP_SCHEME, createAppProtocolHandler(spaRoot));
  denyAllPermissions();
  registerIpcHandlers();
  createMainWindow(preloadPath);
}

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
  // macOS: re-open shell window if user clicks dock icon with no windows
  if (app.isReady()) {
    createMainWindow(preloadPath);
  }
});
