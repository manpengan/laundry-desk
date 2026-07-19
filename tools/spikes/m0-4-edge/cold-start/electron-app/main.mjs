/**
 * M0-4 cold-start shell — security baseline hard requirements (architecture §13.3).
 * Loads built-in SPA via app:// — not a remote URL.
 */
import {
  app,
  BrowserWindow,
  protocol,
  session,
  ipcMain,
} from "electron";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPA_ROOT = join(__dirname, "spa");
const MANIFEST_PATH = join(SPA_ROOT, "manifest.json");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function loadManifest() {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw);
}

function verifySpaIntegrity(manifest) {
  // Spike: SHA-256 of index.html must match manifest (stand-in for signed SPA package).
  const indexPath = join(SPA_ROOT, "index.html");
  const hash = createHash("sha256")
    .update(readFileSync(indexPath))
    .digest("hex");
  if (hash !== manifest.indexSha256) {
    throw new Error(
      `SPA integrity failed: expected ${manifest.indexSha256}, got ${hash}`,
    );
  }
  return hash;
}

function resolveSpaPath(urlPath) {
  const rel = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\//, "");
  const full = normalize(join(SPA_ROOT, rel));
  if (!full.startsWith(SPA_ROOT)) {
    return null;
  }
  return full;
}

function mimeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "preload", "preload.mjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) {
      event.preventDefault();
    }
  });

  win.loadURL("app://local/index.html");
  return win;
}

app.whenReady().then(() => {
  const manifest = loadManifest();
  const hash = verifySpaIntegrity(manifest);
  console.log("[m0-4] SPA integrity ok", hash.slice(0, 12));

  protocol.handle("app", (request) => {
    const u = new URL(request.url);
    const filePath = resolveSpaPath(u.pathname);
    if (!filePath || !existsSync(filePath)) {
      return new Response("not found", { status: 404 });
    }
    const body = readFileSync(filePath);
    return new Response(body, {
      headers: { "content-type": mimeFor(filePath) },
    });
  });

  session.defaultSession.setPermissionRequestHandler(
    (_wc, _permission, callback) => {
      callback(false);
    },
  );

  // Minimal IPC whitelist + sender frame check
  ipcMain.handle("edge:ping", (event) => {
    if (event.senderFrame?.url && !event.senderFrame.url.startsWith("app://")) {
      throw new Error("invalid sender");
    }
    return {
      ok: true,
      data: {
        offline: true,
        mode: "cold-start-spike",
        at: Date.now(),
      },
    };
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
