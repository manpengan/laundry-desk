/**
 * Minimal preload: whitelist only. No Node APIs leaked to renderer.
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./lib/security-prefs.js";

contextBridge.exposeInMainWorld("edgeBridge", {
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.ping),
  health: () => ipcRenderer.invoke(IPC_CHANNELS.health),
  upgradeStatus: () => ipcRenderer.invoke(IPC_CHANNELS.upgradeStatus),
  connection: () => ipcRenderer.invoke(IPC_CHANNELS.connection),
  printEnqueue: (kind?: string) => ipcRenderer.invoke(IPC_CHANNELS.printEnqueue, kind),
  printList: () => ipcRenderer.invoke(IPC_CHANNELS.printList),
});
