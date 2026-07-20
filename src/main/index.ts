import { app, BrowserWindow, net, protocol } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { join, normalize } from "path";
import { pathToFileURL } from "url";
import { registerAllChannels } from "./ipc/registerAll";
import { bindElectronIpc } from "./ipc/electronBridge";
import { BackupService } from "./services/backupService";
import { PhotoService } from "./services/photoService";
import { SettingsService } from "./services/settingsService";

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    center: true,
    backgroundColor: "#f2f2f7",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (is.dev && devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// 单实例锁：第二个实例直接退出并聚焦已有窗口，避免多开争抢 SQLite 与打印设备
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId("com.laundry-desk");
    registerMediaProtocol();
    registerAllChannels();
    bindElectronIpc();

    try {
      await SettingsService.initDefaults();
      BackupService.initAutoBackup();
    } catch (error) {
      console.error("[Main] initialization failed:", error);
    }

    createWindow();

    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});



function registerMediaProtocol(): void {
  protocol.handle("media", (request) => {
    const rawName = decodeURIComponent(request.url.slice("media://".length));
    const safeName = normalize(rawName).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = PhotoService.getPhotoPath(safeName);
    return net.fetch(pathToFileURL(filePath).toString());
  });
}
