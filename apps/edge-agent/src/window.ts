import { BrowserWindow, dialog, type Session } from "electron";
import { APP_ENTRY_URL, APP_SCHEME, SECURITY_WEB_PREFERENCES } from "./lib/security-prefs.js";

export type MainWindowHandle = Readonly<{
  window: BrowserWindow;
  ready: Promise<void>;
}>;

/**
 * Counter-first defaults: three-pane 开单 needs ≥1280; never shrink below 1024.
 * The 600px minimum height still fits a 1366×768 screen at 125% scaling, and the
 * side rail compacts down to 600px without scrolling.
 */
export const MAIN_WINDOW_SIZE = Object.freeze({
  width: 1440,
  height: 900,
  minWidth: 1024,
  minHeight: 600,
});

export function createMainWindow(preloadPath: string, desktopSession: Session): MainWindowHandle {
  const win = new BrowserWindow({
    ...MAIN_WINDOW_SIZE,
    title: "洗衣柜台",
    // Matches the light canvas so the first paint never flashes white.
    backgroundColor: "#f3f4f8",
    // Windows/Linux would otherwise show Electron's English default menu bar
    // above the counter; Alt still reveals it and its shortcuts keep working.
    autoHideMenuBar: true,
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
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: "开单内容尚未保存",
      message: "当前有未暂存内容或待确认的开单结果。",
      detail:
        "建议返回暂存或核对订单与收款记录。继续关闭或刷新会清空本页输入，已经提交的业务不会撤销。",
      buttons: ["返回检查", "确认后继续"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 1) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) {
      event.preventDefault();
    }
  });
}
