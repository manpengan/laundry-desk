/**
 * Minimal preload: whitelist only. No nodeIntegration leaks.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("edgeBridge", {
  ping: () => ipcRenderer.invoke("edge:ping"),
});
