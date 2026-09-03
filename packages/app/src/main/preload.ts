import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  rpc: (method: string, args: Record<string, unknown> = {}) => ipcRenderer.invoke("rpc", method, args),
  local: {
    list: (dir: string) => ipcRenderer.invoke("local:list", dir),
    home: () => ipcRenderer.invoke("local:home"),
    drives: () => ipcRenderer.invoke("local:drives"),
    mkdir: (dir: string) => ipcRenderer.invoke("local:mkdir", dir),
    trash: (p: string) => ipcRenderer.invoke("local:trash", p),
    rename: (from: string, to: string) => ipcRenderer.invoke("local:rename", from, to),
    readText: (p: string) => ipcRenderer.invoke("local:readText", p),
    projectFile: (dir: string) => ipcRenderer.invoke("local:projectFile", dir),
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
    pickFiles: () => ipcRenderer.invoke("dialog:pickFiles"),
    pickKey: () => ipcRenderer.invoke("dialog:pickKey"),
  },
  shell: {
    open: (p: string) => ipcRenderer.invoke("shell:open", p),
    external: (url: string) => ipcRenderer.invoke("shell:external", url),
    showInFolder: (p: string) => ipcRenderer.invoke("shell:showInFolder", p),
  },
  hubInfo: () => ipcRenderer.invoke("hub:info"),
  version: () => ipcRenderer.invoke("app:version"),
  pathFor: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return (file as File & { path?: string }).path ?? "";
    }
  },
  onEvent: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("cf:event", handler);
    return () => ipcRenderer.removeListener("cf:event", handler);
  },
  onAgent: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("cf:agent", handler);
    return () => ipcRenderer.removeListener("cf:agent", handler);
  },
  onConfirm: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("cf:confirm", handler);
    return () => ipcRenderer.removeListener("cf:confirm", handler);
  },
  onConfirmExpired: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("cf:confirm:expired", handler);
    return () => ipcRenderer.removeListener("cf:confirm:expired", handler);
  },
  replyConfirm: (op: string, ok: boolean) => ipcRenderer.send("cf:confirm:reply", op, ok),
};

contextBridge.exposeInMainWorld("coolftp", api);

export type CoolFtpApi = typeof api;
