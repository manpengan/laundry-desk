import { BrowserWindow, type Session } from "electron";
import { APP_ENTRY_URL, APP_SCHEME, SECURITY_WEB_PREFERENCES } from "./lib/security-prefs.js";

export type MainWindowHandle = Readonly<{
  window: BrowserWindow;
  ready: Promise<void>;
}>;

/** Counter-first defaults: three-pane 开单 needs ≥1280; never shrink below 1024. */
export const MAIN_WINDOW_SIZE = Object.freeze({
  width: 1440,
  height: 900,
  minWidth: 1024,
  minHeight: 680,
});

export function createMainWindow(preloadPath: string, desktopSession: Session): MainWindowHandle {
  const win = new BrowserWindow({
    ...MAIN_WINDOW_SIZE,
    title: "洗衣柜台",
    // Matches the light canvas so the first paint never flashes white.
    backgroundColor: "#f3f4f8",
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
