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
  DesktopPinChallengeResult,
  DesktopPinVerifyResult,
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
  health: Object.freeze({
    get: (): Promise<DesktopHealthGetResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.health.get, EMPTY_DESKTOP_INPUT),
  }),
});

contextBridge.exposeInMainWorld("laundryDesktop", laundryDesktop);
