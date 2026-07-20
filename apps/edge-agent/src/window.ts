import { BrowserWindow } from "electron";
import { APP_ENTRY_URL, APP_SCHEME, SECURITY_WEB_PREFERENCES } from "./lib/security-prefs.js";

export function createMainWindow(preloadPath: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    show: true,
    webPreferences: {
      preload: preloadPath,
      ...SECURITY_WEB_PREFERENCES,
    },
  });

  applyNavigationGuards(win);
  void win.loadURL(APP_ENTRY_URL);
  return win;
}

export function applyNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) {
      event.preventDefault();
    }
  });
}
