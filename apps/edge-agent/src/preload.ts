/**
 * Minimal preload: whitelist only. No Node APIs leaked to renderer.
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./lib/security-prefs.js";

contextBridge.exposeInMainWorld("edgeBridge", {
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.ping),
});
