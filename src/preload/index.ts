import { contextBridge, ipcRenderer } from "electron";
import { buildApi, type LaundryDeskApi } from "../shared/api";

const api: LaundryDeskApi = buildApi((channel, payload) =>
  payload === undefined
    ? ipcRenderer.invoke(channel)
    : ipcRenderer.invoke(channel, payload),
);
contextBridge.exposeInMainWorld("api", api);
contextBridge.exposeInMainWorld("laundryEnv", { mediaBase: "media://" });

export type { LaundryDeskApi };
