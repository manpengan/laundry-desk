/**
 * Narrow renderer capability bridge. Transport controls and runtime APIs stay main-only.
 */
import type {
  DesktopCommandExecuteInput,
  DesktopCommandExecuteResult,
  DesktopHealthGetResult,
  DesktopLoginInput,
  DesktopLoginResult,
  DesktopLogoutResult,
  DesktopOfflineResolveInput,
  DesktopOfflineResumeResult,
  DesktopOfflineStatusResult,
  DesktopPinChallengeResult,
  DesktopPinVerifyResult,
  DesktopPhotoDeleteInput,
  DesktopPhotoDeleteResult,
  DesktopPhotoReadInput,
  DesktopPhotoReadResult,
  DesktopPhotoUploadInput,
  DesktopPhotoUploadResult,
  DesktopQueryExecuteInput,
  DesktopQueryExecuteResult,
  DesktopRefreshResult,
  PinChallengeRequest,
  PinVerifyRequest,
} from "@laundry/contracts";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./lib/security-prefs.js";

const EMPTY_DESKTOP_INPUT = Object.freeze({});

const laundryDesktop = Object.freeze({
  auth: Object.freeze({
    login: (input: DesktopLoginInput): Promise<DesktopLoginResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.auth.login, input),
    refresh: (): Promise<DesktopRefreshResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.auth.refresh, EMPTY_DESKTOP_INPUT),
    pinChallenge: (input: PinChallengeRequest): Promise<DesktopPinChallengeResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.auth.pinChallenge, input),
    pinVerify: (input: PinVerifyRequest): Promise<DesktopPinVerifyResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.auth.pinVerify, input),
    logout: (): Promise<DesktopLogoutResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.auth.logout, EMPTY_DESKTOP_INPUT),
  }),
  command: Object.freeze({
    execute: (input: DesktopCommandExecuteInput): Promise<DesktopCommandExecuteResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.command.execute, input),
  }),
  query: Object.freeze({
    execute: (input: DesktopQueryExecuteInput): Promise<DesktopQueryExecuteResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.query.execute, input),
  }),
  photo: Object.freeze({
    upload: (input: DesktopPhotoUploadInput): Promise<DesktopPhotoUploadResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.photo.upload, input),
    read: (input: DesktopPhotoReadInput): Promise<DesktopPhotoReadResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.photo.read, input),
    delete: (input: DesktopPhotoDeleteInput): Promise<DesktopPhotoDeleteResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.photo.delete, input),
  }),
  offline: Object.freeze({
    resume: (): Promise<DesktopOfflineResumeResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.offline.resume, EMPTY_DESKTOP_INPUT),
    status: (): Promise<DesktopOfflineStatusResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.offline.status, EMPTY_DESKTOP_INPUT),
    resolve: (input: DesktopOfflineResolveInput): Promise<DesktopOfflineStatusResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.offline.resolve, input),
  }),
  health: Object.freeze({
    get: (): Promise<DesktopHealthGetResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.health.get, EMPTY_DESKTOP_INPUT),
  }),
});

contextBridge.exposeInMainWorld("laundryDesktop", laundryDesktop);
