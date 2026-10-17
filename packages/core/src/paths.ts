import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let migrated = false;

/**
 * Where coolFTP keeps sites, history, known hosts and the hub file.
 *
 * On Windows this is %USERPROFILE%\.coolftp, not %APPDATA%\coolftp. Packaged apps (the Claude
 * desktop app is an MSIX package) get a private copy of %APPDATA%: a file written there from
 * inside the package lands in its LocalCache folder and from then on hides the real file from
 * every process in that package. The home folder is not redirected, so the app, the CLI and an
 * MCP server started by Claude Desktop all see the same files.
 */
export function configDir(): string {
  if (process.env.COOLFTP_HOME) {
    fs.mkdirSync(process.env.COOLFTP_HOME, { recursive: true });
    return process.env.COOLFTP_HOME;
  }
  if (process.platform !== "win32") {
    const base = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "coolftp");
    fs.mkdirSync(base, { recursive: true });
    return base;
  }
  const base = path.join(os.homedir(), ".coolftp");
  fs.mkdirSync(base, { recursive: true });
  if (!migrated) {
    migrated = true;
    try {
      migrateLegacyConfig(base);
    } catch {
      /* best effort: a failed migration leaves an empty config, never a broken one */
    }
  }
  return base;
}

/** The Windows config folder used up to 0.1.4. Undefined elsewhere or with COOLFTP_HOME set. */
export function legacyConfigDir(): string | undefined {
  if (process.platform !== "win32" || process.env.COOLFTP_HOME) return undefined;
  return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "coolftp");
}

/** Sandboxed copies of the legacy config that packaged apps wrote under their LocalCache. */
export function sandboxShadowDirs(): string[] {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return [];
  const packages = path.join(process.env.LOCALAPPDATA, "Packages");
  const out: string[] = [];
  try {
    for (const name of fs.readdirSync(packages)) {
      const dir = path.join(packages, name, "LocalCache", "Roaming", "coolftp");
      if (fs.existsSync(dir)) out.push(dir);
    }
  } catch {
    /* no Packages folder */
  }
  return out;
}

const MIGRATED_MARKER = "migrated.json";
const SKIP = new Set(["hub.json", MIGRATED_MARKER]);

/**
 * One-time move from %APPDATA%\coolftp to the new folder. Copies, never deletes, the old files.
 *
 * Sandboxed copies are moved aside first (renamed to coolftp.sandbox-bak-<date>), so a process
 * running inside a package reads the real %APPDATA% files rather than its stale copy. Sites and
 * files that only exist in a sandboxed copy are added after, so nothing saved there is lost.
 */
export function migrateLegacyConfig(target: string): void {
  if (fs.existsSync(path.join(target, MIGRATED_MARKER)) || fs.existsSync(path.join(target, "sites.json"))) return;
  const legacy = legacyConfigDir();
  if (!legacy) return;

  const stamp = new Date().toISOString().slice(0, 10);
  const shadows: string[] = [];
  for (const dir of sandboxShadowDirs()) {
    let dest = `${dir}.sandbox-bak-${stamp}`;
    for (let i = 2; fs.existsSync(dest); i++) dest = `${dir}.sandbox-bak-${stamp}-${i}`;
    try {
      fs.renameSync(dir, dest);
      shadows.push(dest);
    } catch {
      shadows.push(dir);
    }
  }

  const copied: string[] = [];
  if (fs.existsSync(legacy)) copyMissing(legacy, target, copied);
  for (const dir of shadows) {
    mergeSites(path.join(dir, "sites.json"), path.join(target, "sites.json"), copied);
    copyMissing(dir, target, copied);
  }
  writeJson(path.join(target, MIGRATED_MARKER), { from: legacy, sandboxCopies: shadows, files: copied.length, at: new Date().toISOString() });
}

function copyMissing(from: string, to: string, copied: string[]): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.endsWith(".tmp")) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyMissing(src, dest, copied);
    } else if (entry.isFile() && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      copied.push(dest);
    }
  }
}

/** Add sites from `from` whose names are not already in `to`. */
function mergeSites(from: string, to: string, copied: string[]): void {
  if (!fs.existsSync(from) || !fs.existsSync(to)) return;
  const extra = readJson<{ sites?: { name: string }[] }>(from, {}).sites ?? [];
  const current = readJson<{ sites?: { name: string }[] }>(to, {}).sites ?? [];
  const have = new Set(current.map((s) => s.name.toLowerCase()));
  const add = extra.filter((s) => s?.name && !have.has(s.name.toLowerCase()));
  if (!add.length) return;
  writeJson(to, { sites: [...current, ...add] });
  copied.push(to);
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
