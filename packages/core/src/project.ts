import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./paths.js";
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
