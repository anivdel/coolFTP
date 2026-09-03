import crypto from "node:crypto";
import path from "node:path";
import { configDir, readJson, writeJson } from "./paths.js";

/**
 * Trust-on-first-use SSH host key store, like ~/.ssh/known_hosts but JSON.
 * First connection records the server's key fingerprint; a later mismatch is refused
 * because it is exactly what a man-in-the-middle looks like.
 */
interface KnownHosts {
  [hostPort: string]: { fingerprint: string; type: string; firstSeen: string };
}

const FILE = () => path.join(configDir(), "known_hosts.json");

export function fingerprintOf(key: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export type HostKeyVerdict = { ok: true; firstUse: boolean; fingerprint: string } | { ok: false; expected: string; actual: string };

export function checkHostKey(host: string, port: number, keyType: string, key: Buffer): HostKeyVerdict {
  const id = `${host.toLowerCase()}:${port}`;
  const store = readJson<KnownHosts>(FILE(), {});
  const fingerprint = fingerprintOf(key);
  const known = store[id];
  if (!known) {
    store[id] = { fingerprint, type: keyType, firstSeen: new Date().toISOString() };
    writeJson(FILE(), store);
    return { ok: true, firstUse: true, fingerprint };
  }
  if (known.fingerprint === fingerprint) return { ok: true, firstUse: false, fingerprint };
  return { ok: false, expected: known.fingerprint, actual: fingerprint };
}

export function forgetHostKey(host: string, port: number): boolean {
  const id = `${host.toLowerCase()}:${port}`;
  const store = readJson<KnownHosts>(FILE(), {});
  if (!(id in store)) return false;
  delete store[id];
  writeJson(FILE(), store);
  return true;
}

export function listHostKeys(): Array<{ host: string; fingerprint: string; type: string; firstSeen: string }> {
  const store = readJson<KnownHosts>(FILE(), {});
  return Object.entries(store).map(([host, v]) => ({ host, ...v }));
}
