import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { CoolFtp, Events, dispatch, listLocal, shortId, type CoolEvent, type EventMeta } from "@coolftp/core";
import { startHub, type AgentCall } from "./hub.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0";

const cf = new CoolFtp();
const events = new Events({ agent: "user", op: "" });
let win: BrowserWindow | null = null;
let hub: { port: number; token: string; close: () => void } | null = null;
const agentCalls: AgentCall[] = [];
const pendingConfirms = new Map<string, (ok: boolean) => void>();

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

events.on((event: CoolEvent, meta: EventMeta) => send("cf:event", { event, meta }));

function createWindow() {
  nativeTheme.themeSource = "dark";
  win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0f17",
    title: "coolFTP",
    icon: path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => (win = null));

  // Dev aid: COOLFTP_SCREENSHOT=<file.png> captures the window after a delay and quits.
  const shot = process.env.COOLFTP_SCREENSHOT;
  if (shot) {
    const delay = Number(process.env.COOLFTP_SCREENSHOT_DELAY || 4000);
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          // An occluded window captures as an empty image; bring it forward first.
          win!.show();
          win!.moveTop();
          win!.focus();
          await new Promise((r) => setTimeout(r, 400));
          const img = await win!.webContents.capturePage();
          fs.writeFileSync(shot, img.toPNG());
        } finally {
          app.quit();
        }
      }, delay);
    });
  }
}

app.whenReady().then(async () => {
  createWindow();
  try {
    hub = await startHub(
      cf,
      events,
      {
        onCall(call) {
          const i = agentCalls.findIndex((c) => c.op === call.op);
          if (i >= 0) agentCalls[i] = call;
          else agentCalls.unshift(call);
          if (agentCalls.length > 200) agentCalls.length = 200;
          send("cf:agent", call);
          if (call.endedAt && win && !win.isFocused()) win.flashFrame(true);
        },
        confirm(call, detail) {
          return new Promise<boolean>((resolve) => {
            if (!win || win.isDestroyed()) return resolve(false);
            pendingConfirms.set(call.op, resolve);
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            win.flashFrame(true);
            send("cf:confirm", { op: call.op, agent: call.agent, summary: call.summary, detail });
            setTimeout(() => {
              if (pendingConfirms.delete(call.op)) {
                send("cf:confirm:expired", { op: call.op });
                resolve(false);
              }
            }, 120_000).unref?.();
          });
        },
      },
      VERSION,
    );
  } catch (err) {
    events.log(`Agent hub failed to start: ${(err as Error).message}`, "error");
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  hub?.close();
  void cf.close();
});

// ---------------- IPC ----------------

ipcMain.handle("rpc", async (_e, method: string, args: Record<string, unknown>) => {
  const child = events.child({ agent: "user", op: shortId() });
  try {
    return { ok: true, result: await dispatch(cf, method, args, child) };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    child.log(message, "error");
    return { ok: false, error: message };
  }
});

ipcMain.handle("local:list", (_e, dir: string) => {
  try {
    return { ok: true, path: path.resolve(dir), entries: listLocal(dir) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("local:home", () => os.homedir());

ipcMain.handle("local:drives", () => {
  if (process.platform !== "win32") return ["/"];
  const drives: string[] = [];
  for (let i = 65; i <= 90; i++) {
    const d = `${String.fromCharCode(i)}:\\`;
    if (fs.existsSync(d)) drives.push(d);
  }
  return drives;
});

ipcMain.handle("local:mkdir", (_e, dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  return true;
});

ipcMain.handle("local:trash", async (_e, p: string) => {
  await shell.trashItem(p);
  return true;
});

ipcMain.handle("local:rename", (_e, from: string, to: string) => {
  fs.renameSync(from, to);
  return true;
});

ipcMain.handle("local:readText", (_e, p: string) => {
  const buf = fs.readFileSync(p);
  return { content: buf.subarray(0, 512 * 1024).toString("utf8"), truncated: buf.length > 512 * 1024 };
});

ipcMain.handle("local:projectFile", (_e, dir: string) => {
  let cur = path.resolve(dir);
  for (;;) {
    const f = path.join(cur, ".coolftp.json");
    if (fs.existsSync(f)) return f;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
});

ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("dialog:pickFiles", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("dialog:pickKey", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "showHiddenFiles"], defaultPath: path.join(os.homedir(), ".ssh") });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("shell:open", (_e, p: string) => shell.openPath(p));
ipcMain.handle("shell:external", (_e, url: string) => shell.openExternal(url));
ipcMain.handle("shell:showInFolder", (_e, p: string) => shell.showItemInFolder(p));

ipcMain.handle("hub:info", () => ({
  port: hub?.port ?? null,
  version: VERSION,
  cliPath: cliPath(),
  calls: agentCalls,
  platform: process.platform,
}));

ipcMain.handle("app:version", () => VERSION);

ipcMain.on("cf:confirm:reply", (_e, op: string, ok: boolean) => {
  const resolve = pendingConfirms.get(op);
  if (resolve) {
    pendingConfirms.delete(op);
    resolve(Boolean(ok));
  }
});

function cliPath(): string {
  // In dev the CLI lives beside the app package; when packaged, it is copied into resources.
  const candidates = [
    path.join(process.resourcesPath || "", "cli", "coolftp.js"),
    path.join(__dirname, "..", "..", "cli", "dist", "coolftp.js"),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return "coolftp";
}
