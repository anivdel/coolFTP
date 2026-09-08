import fs from "node:fs";
import path from "node:path";
import { readJson, rjoin, writeJson } from "./paths.js";
import type { ProjectConfig, ResolvedProject } from "./types.js";

export const PROJECT_FILE = ".coolftp.json";

/** Walk up from cwd to find a .coolftp.json. */
export function findProjectFile(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, PROJECT_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveProject(cwd: string, siteOverride?: string): ResolvedProject {
  const configPath = findProjectFile(cwd);
  const root = configPath ? path.dirname(configPath) : path.resolve(cwd);
  const config = configPath ? readJson<ProjectConfig>(configPath, { site: "" }) : { site: "" };
  if (siteOverride) config.site = siteOverride;
  if (!config.site) {
    throw new Error(
      `No site configured for ${root}. Run "coolftp init <site>" in the project, or pass --site <name>.`,
    );
  }
  const localDir = config.localDir ? path.resolve(root, config.localDir) : root;
  return { root, localDir, configPath, config };
}

export function writeProjectConfig(dir: string, config: ProjectConfig): string {
  const file = path.join(dir, PROJECT_FILE);
  writeJson(file, config);
  return file;
}

/**
 * Git Bash (MSYS) rewrites arguments that start with "/" into Windows paths before a
 * program sees them, so `coolftp ls /public_html` arrives as `C:/Program Files/Git/public_html`.
 * Undo that when the prefix is recognisable, otherwise refuse: a drive letter is never a remote path.
 */
export function cleanRemotePath(p: string): string;
export function cleanRemotePath(p: string | undefined): string | undefined;
export function cleanRemotePath(p: string | undefined): string | undefined {
  if (!p || !/^[A-Za-z]:[\\/]/.test(p)) return p;
  const posix = p.replace(/\\/g, "/");
  const msysRoot = (process.env.EXEPATH || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (msysRoot && posix.toLowerCase().startsWith(msysRoot.toLowerCase() + "/")) {
    return posix.slice(msysRoot.length) || "/";
  }
  throw new Error(
    `"${p}" looks like a Windows path, not a path on the server. ` +
      `Git Bash rewrites arguments that start with "/"; use a relative path (public_html/...) or set MSYS_NO_PATHCONV=1.`,
  );
}

/**
 * Where a relative remote path points for this project. When .coolftp.json overrides the
 * site's remoteRoot, paths typed for ls/push/pull/rm are relative to that override, so a
 * project deploying to /public_html can `coolftp push js/app.js js/app.js` and land it
 * next to the deployed copy. Absolute paths and other sites are left alone.
 */
export function projectRemotePath(cwd: string, site: string | undefined, p: string | undefined): string | undefined {
  const configPath = findProjectFile(cwd);
  if (!configPath) return p;
  const config = readJson<ProjectConfig>(configPath, { site: "" });
  const root = config.remoteRoot;
  if (!root || !root.startsWith("/")) return p;
  if (site && config.site && site !== config.site) return p;
  if (p && (p.startsWith("/") || p.startsWith("~"))) return p;
  return p ? rjoin(root, p) : root;
}
