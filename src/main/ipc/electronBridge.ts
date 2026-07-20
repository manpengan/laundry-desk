import { ipcMain } from "electron";
import { channelRegistry, invokeChannel } from "./helpers";

export function bindElectronIpc(): void {
  for (const channel of channelRegistry.keys()) {
    ipcMain.handle(channel, (_e, raw) => invokeChannel(channel, raw));
  }
}
