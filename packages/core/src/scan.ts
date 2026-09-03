import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ignore, { type Ignore } from "ignore";
import { configDir, readJson, writeJson, toPosix } from "./paths.js";
import type { LocalEntry, ManifestFile } from "./types.js";

/** Files never deployed regardless of config. */
export const ALWAYS_IGNORE = [
  ".git/",
  ".coolftp.json",
  ".coolftp/",
  ".coolftpignore",
  ".deployignore",
  "node_modules/",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".env",
  ".env.*",
  "*.log",
];

export function buildIgnore(root: string, extra: string[] = []): Ignore {
  const ig = ignore();
  ig.add(ALWAYS_IGNORE);
  for (const f of [".coolftpignore", ".deployignore"]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) ig.add(fs.readFileSync(p, "utf8"));
  }
  ig.add(extra.filter(Boolean));
  return ig;
}

interface HashCache {
  [rel: string]: { size: number; mtime: number; hash: string };
}

function cacheFile(root: string): string {
  const key = crypto.createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(configDir(), "cache", `${key}.json`);
}

export async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/**
 * Walk a local directory producing a manifest of relative posix paths -> {size, mtime, hash}.
 * Hashes are cached by (size, mtime) so re-scans of big projects are fast.
 */
export async function scanLocal(
  root: string,
  extraIgnore: string[] = [],
  onFile?: (rel: string) => void,
): Promise<Record<string, ManifestFile>> {
  const ig = buildIgnore(root, extraIgnore);
  const cachePath = cacheFile(root);
  const cache = readJson<HashCache>(cachePath, {});
  const out: Record<string, ManifestFile> = {};
  const nextCache: HashCache = {};

  const walk = async (dir: string, relDir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ig.ignores(rel + "/")) continue;
        await walk(abs, rel);
      } else if (e.isFile()) {
        if (ig.ignores(rel)) continue;
        const st = fs.statSync(abs);
        const mtime = Math.floor(st.mtimeMs);
        const cached = cache[rel];
        let hash: string;
        if (cached && cached.size === st.size && cached.mtime === mtime) hash = cached.hash;
        else hash = await hashFile(abs);
        out[rel] = { size: st.size, mtime, hash };
        nextCache[rel] = { size: st.size, mtime, hash };
        onFile?.(rel);
      }
    }
  };
  await walk(root, "");
  try {
    writeJson(cachePath, nextCache);
  } catch {
    /* cache is best-effort */
  }
  return out;
}

/** Non-recursive local listing for the file browser. */
export function listLocal(dir: string): LocalEntry[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: LocalEntry[] = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    try {
      const st = fs.statSync(abs);
      out.push({
        name: e.name,
        path: abs,
        type: st.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file",
        size: st.isDirectory() ? 0 : st.size,
        mtime: Math.floor(st.mtimeMs),
      });
    } catch {
      /* unreadable entry */
    }
  }
  return out.sort(sortEntries);
}

export function sortEntries<T extends { name: string; type: string }>(a: T, b: T): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : b.type === "dir" ? 1 : 0;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** All files under a local path (recursive), as [absolute, relativePosix] pairs. */
export function walkLocalFiles(root: string): Array<{ abs: string; rel: string; size: number }> {
  const out: Array<{ abs: string; rel: string; size: number }> = [];
  const walk = (dir: string, relDir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) out.push({ abs, rel: toPosix(rel), size: fs.statSync(abs).size });
    }
  };
  const st = fs.statSync(root);
  if (st.isFile()) return [{ abs: root, rel: path.basename(root), size: st.size }];
  walk(root, "");
  return out;
}
