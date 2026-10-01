import { app, Menu, Tray, type BrowserWindow } from "electron";

export type TrayHandles = {
  tray: Tray;
  dispose: () => void;
};

export async function createAppTray(opts: {
  getWindow: () => BrowserWindow | null;
  onQuit: () => void;
}): Promise<TrayHandles> {
  const icon = await app.getFileIcon(app.getPath("exe"), { size: "small" });
  if (icon.isEmpty()) throw new Error("EDGE_TRAY_ICON_UNAVAILABLE");
  const tray = new Tray(icon);
  tray.setToolTip("laundry-desk Edge Agent");
  const showWindow = (): void => {
    const win = opts.getWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  };
  const menu = Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      click: showWindow,
    },
    { type: "separator" },
    { label: "退出", click: () => opts.onQuit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", showWindow);
  return {
    tray,
    dispose: () => {
      tray.destroy();
    },
  };
}
