import { ipcMain } from "electron";
import { IPC_CHANNELS } from "./lib/security-prefs.js";
import { isValidAppSender } from "./lib/sender.js";

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ping, (event) => {
    const senderUrl = event.senderFrame?.url;
    if (!isValidAppSender(senderUrl)) {
      throw new Error("invalid sender");
    }
    return {
      ok: true as const,
      data: {
        offlineCapable: true,
        mode: "edge-agent-d1",
        at: Date.now(),
      },
    };
  });
}
