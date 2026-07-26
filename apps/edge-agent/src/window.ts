import { BrowserWindow, type Session } from "electron";
import { APP_ENTRY_URL, APP_SCHEME, SECURITY_WEB_PREFERENCES } from "./lib/security-prefs.js";

export type MainWindowHandle = Readonly<{
  window: BrowserWindow;
  ready: Promise<void>;
}>;

export function createMainWindow(preloadPath: string, desktopSession: Session): MainWindowHandle {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    show: false,
    webPreferences: {
      preload: preloadPath,
      session: desktopSession,
      ...SECURITY_WEB_PREFERENCES,
    },
  });

  applyNavigationGuards(win);
  return Object.freeze({
    window: win,
    ready: win.loadURL(APP_ENTRY_URL),
  });
}

export function applyNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) {
      event.preventDefault();
    }
  });
}
