import { Menu, Tray, nativeImage, type BrowserWindow, type NativeImage } from "electron";

export type TrayHandles = {
  tray: Tray;
  dispose: () => void;
};

function emptyIcon(): NativeImage {
  // 1×1 transparent PNG — real branded icon lands with packaging.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  return nativeImage.createFromBuffer(png);
}

export function createAppTray(opts: {
  getWindow: () => BrowserWindow | null;
  onQuit: () => void;
}): TrayHandles {
  const tray = new Tray(emptyIcon());
  tray.setToolTip("laundry-desk Edge Agent");
  const menu = Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      click: () => {
        const win = opts.getWindow();
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      },
    },
    { type: "separator" },
    { label: "退出", click: () => opts.onQuit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", () => {
    const win = opts.getWindow();
    win?.show();
    win?.focus();
  });
  return {
    tray,
    dispose: () => {
      tray.destroy();
    },
  };
}
