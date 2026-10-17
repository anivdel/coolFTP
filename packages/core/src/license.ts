import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { configDir, readJson, writeJson } from "./paths.js";
import { LICENSE_PUBLIC_KEY_B64 } from "./license-pubkey.js";

/**
 * coolFTP Pro license keys.
 *
 * Format:  CFP1.<base64url payload JSON>.<base64url Ed25519 signature>
 * The signature covers the string "CFP1.<payload>". Verification is offline with the
 * public key baked into the build; the private key lives only on the license server.
 *
 * Pro is one payment with updates for life: a genuine key unlocks Pro in every build.
 * Keys still carry updatesUntil (issued as 9999-12-31) because builds before this change
 * only unlocked Pro up to that date.
 */
export interface LicensePayload {
  /** 1: a CFP1 coolFTP Pro key. 2: an LS1 Ledvina Software key naming the products it unlocks. */
  v: 1 | 2;
  id: string;
  email: string;
  tier?: "pro";
  /** v2 keys only: which apps this key unlocks, e.g. ["owlsql"] or a bundle's whole list. */
  products?: string[];
  seats: number;
  issued: string;
  updatesUntil?: string;
}

export interface LicenseStatus {
  installed: boolean;
  valid: boolean;
  /** Pro features are unlocked in this build. */
  pro: boolean;
  reason?: string;
  license?: LicensePayload;
  buildDate: string;
  buyUrl: string;
}

export const BUY_URL = "https://coolftp.com/#pro";
const PREFIX = "CFP1";
/** Keys for any Ledvina Software app or bundle, signed with the same key pair. Builds before 0.2 reject them. */
const LS_PREFIX = "LS1";
/** This app's id in an LS1 key's products list. */
export const PRODUCT = "coolftp";
const PRODUCT_NAMES: Record<string, string> = { coolftp: "coolFTP", owlsql: "OwlSQL", woodpecker: "woodpeckerDig", magpie: "magpieSnap" };
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

declare const __BUILD_DATE__: string | undefined;

/** Date of this build (YYYY-MM-DD), injected by the bundler; falls back to today for dev runs. */
export function buildDate(): string {
  return typeof __BUILD_DATE__ === "string" ? __BUILD_DATE__ : new Date().toISOString().slice(0, 10);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function normaliseLicenseKey(input: string): string {
  return input.replace(/\s+/g, "").trim();
}

export function parseLicenseKey(key: string): { payload: LicensePayload; signatureOk: boolean } {
  const parts = normaliseLicenseKey(key).split(".");
  if (parts.length !== 3 || (parts[0] !== PREFIX && parts[0] !== LS_PREFIX)) throw new Error("That is not a coolFTP license key.");
  const [prefix, body, sig] = parts;
  let payload: LicensePayload;
  try {
    payload = JSON.parse(unb64url(body).toString("utf8"));
  } catch {
    throw new Error("License key is damaged (payload).");
  }
  const fieldsOk =
    prefix === PREFIX
      ? payload.v === 1 && Boolean(payload.email) && Boolean(payload.updatesUntil) && payload.tier === "pro"
      : payload.v === 2 && Boolean(payload.email) && Array.isArray(payload.products);
  if (!fieldsOk) throw new Error("License key is damaged (fields).");
  const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(LICENSE_PUBLIC_KEY_B64, "base64")]), format: "der", type: "spki" });
  const signatureOk = crypto.verify(null, Buffer.from(`${prefix}.${body}`), pub, unb64url(sig));
  return { payload, signatureOk };
}

/** Sign a payload. Used by the issuing tool and tests; needs the private key. */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const prefix = payload.v === 2 ? LS_PREFIX : PREFIX;
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign(null, Buffer.from(`${prefix}.${body}`), crypto.createPrivateKey(privateKeyPem));
  return `${prefix}.${body}.${b64url(sig)}`;
}

export function evaluateLicense(key: string | undefined, build = buildDate()): LicenseStatus {
  const base: LicenseStatus = { installed: false, valid: false, pro: false, buildDate: build, buyUrl: BUY_URL };
  if (!key) return { ...base, reason: "No license installed. coolFTP runs as Free." };
  let parsed: ReturnType<typeof parseLicenseKey>;
  try {
    parsed = parseLicenseKey(key);
  } catch (e) {
    return { ...base, installed: true, reason: (e as Error).message };
  }
  if (!parsed.signatureOk) return { ...base, installed: true, reason: "License signature does not match. The key was altered or is not from coolftp.com." };
  const lic = parsed.payload;
  if (lic.v === 2 && !lic.products!.includes(PRODUCT)) {
    const names = lic.products!.map((p) => PRODUCT_NAMES[p] ?? p).join(", ") || "no apps";
    return { ...base, installed: true, reason: `That key is for ${names}, not coolFTP. Get coolFTP Pro at ${BUY_URL}.` };
  }
  return { ...base, installed: true, valid: true, pro: true, license: lic };
}

function licenseFile(): string {
  return path.join(configDir(), "license.json");
}

export function getLicenseStatus(build = buildDate()): LicenseStatus {
  const stored = readJson<{ key?: string }>(licenseFile(), {});
  return evaluateLicense(stored.key, build);
}

/** Verify a key and, when it is genuine, store it. Returns the resulting status. */
export function activateLicense(rawKey: string, build = buildDate()): LicenseStatus {
  const key = normaliseLicenseKey(rawKey);
  const status = evaluateLicense(key, build);
  if (!status.valid) throw new Error(status.reason || "Invalid license key.");
  writeJson(licenseFile(), { key, activatedAt: new Date().toISOString() });
  return status;
}

export function removeLicense(): boolean {
  const f = licenseFile();
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

/** Throw a clear, actionable error when a Pro feature is used without an active license. */
export function requirePro(feature: string, build = buildDate()): LicensePayload {
  const status = getLicenseStatus(build);
  if (status.pro && status.license) return status.license;
  throw new Error(
    status.installed && status.valid
      ? `${feature} needs coolFTP Pro with active updates. ${status.reason}`
      : `${feature} is a coolFTP Pro feature. Get a key at ${BUY_URL}, then run: coolftp license activate <key>`,
  );
}
