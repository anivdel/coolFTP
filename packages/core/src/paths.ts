import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function configDir(): string {
  const base =
    process.env.COOLFTP_HOME ||
    (process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "coolftp")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "coolftp"));
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Join remote (posix) paths and normalise. */
export function rjoin(...parts: string[]): string {
  const joined = path.posix.join(...parts.map((p) => p.replace(/\\/g, "/")));
  return joined === "" ? "/" : joined;
}

export function rdirname(p: string): string {
  return path.posix.dirname(p.replace(/\\/g, "/"));
}

export function rbasename(p: string): string {
  return path.posix.basename(p.replace(/\\/g, "/"));
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function shortId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
