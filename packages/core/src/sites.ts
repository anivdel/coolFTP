import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { configDir, readJson, writeJson, expandHome } from "./paths.js";
import type { Site } from "./types.js";

const FILE = () => path.join(configDir(), "sites.json");

export function loadSites(): Site[] {
  const data = readJson<{ sites: Site[] }>(FILE(), { sites: [] });
  return data.sites ?? [];
}

export function saveSites(sites: Site[]): void {
  writeJson(FILE(), { sites });
}

export function getSite(name: string): Site {
  const s = loadSites().find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) throw new Error(`Unknown site "${name}". Run: coolftp site list`);
  return s;
}

/** Sentinel the desktop app sends to keep a stored password without ever reading it back. */
export const KEEP_SECRET = "__KEEP__";

export function upsertSite(site: Site): Site {
  const sites = loadSites();
  const i = sites.findIndex((x) => x.name.toLowerCase() === site.name.toLowerCase());
  const existing = i >= 0 ? sites[i] : undefined;
  if (site.password === KEEP_SECRET) site.password = existing?.password;
  if (site.passphrase === KEEP_SECRET || (site.passphrase === undefined && existing?.passphrase)) site.passphrase = existing?.passphrase;
  const normalised = normaliseSite(site);
  if (i >= 0) sites[i] = normalised;
  else sites.push(normalised);
  saveSites(sites);
  return normalised;
}

export function removeSite(name: string): boolean {
  const sites = loadSites();
  const next = sites.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
  saveSites(next);
  return next.length !== sites.length;
}

export function normaliseSite(site: Site): Site {
  const s: Site = { ...site };
  s.name = s.name.trim();
  s.protocol = s.protocol || "sftp";
  s.port = Number(s.port) || (s.protocol === "sftp" ? 22 : 21);
  s.remoteRoot = (s.remoteRoot || "/").replace(/\\/g, "/");
  if (!s.remoteRoot.startsWith("/") && !/^~/.test(s.remoteRoot)) s.remoteRoot = "/" + s.remoteRoot;
  if (s.remoteRoot.length > 1) s.remoteRoot = s.remoteRoot.replace(/\/+$/, "");
  if (s.privateKeyPath) s.privateKeyPath = expandHome(s.privateKeyPath);
  if (s.localRoot) s.localRoot = path.resolve(expandHome(s.localRoot));
  if (!s.password) delete s.password;
  if (!s.privateKeyPath) delete s.privateKeyPath;
  if (!s.passphrase) delete s.passphrase;
  return s;
}

/** Find a usable default SSH private key. */
export function defaultPrivateKey(): string | undefined {
  const dir = path.join(os.homedir(), ".ssh");
  for (const n of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export type PublicSite = Omit<Site, "password" | "passphrase"> & { hasPassword: boolean };

/** Strip secrets for display / sending to agents. */
export function publicSite(site: Site): PublicSite {
  const { password: _p, passphrase: _pp, ...rest } = site;
  return { ...rest, hasPassword: Boolean(site.password) };
}
