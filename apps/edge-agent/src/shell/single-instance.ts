import type { App } from "electron";

/** Returns true if this process should continue (primary instance). */
export function claimPrimaryInstance(app: App): boolean {
  return app.requestSingleInstanceLock();
}

export function onSecondInstance(app: App, showMainWindow: () => void): void {
  app.on("second-instance", () => {
    showMainWindow();
  });
}
