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
  printEnqueue: (kindOrOpts?: string | { kind?: string; autoProcess?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.printEnqueue, kindOrOpts),
  printProcess: (input?: { jobId?: string; kind?: string; ticketNo?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.printProcess, input),
  printList: () => ipcRenderer.invoke(IPC_CHANNELS.printList),
  // D2: pairing code + public status only — never private keys.
  pairingCreateCode: () => ipcRenderer.invoke(IPC_CHANNELS.pairingCreateCode),
  pairingStatus: () => ipcRenderer.invoke(IPC_CHANNELS.pairingStatus),
  /** D3: status projection only — never keys or envelope plaintext. */
  queueStatus: () => ipcRenderer.invoke(IPC_CHANNELS.queueStatus),
});
