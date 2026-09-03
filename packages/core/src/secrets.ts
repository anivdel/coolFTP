import { execFileSync } from "node:child_process";

/**
 * At-rest protection for passwords in sites.json.
 * Windows: DPAPI (CurrentUser scope) via PowerShell, so the app and the CLI can both
 * read what the other wrote and nothing is readable from another user account or machine.
 * Other platforms: stored as-is (marked "plain:") until a keychain backend lands.
 */
const PREFIX = "dpapi:";

function ps(script: string, secret: string): string {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, CF_SECRET: secret },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 15000,
  }).trim();
}

export function isProtected(value: string | undefined): boolean {
  return Boolean(value && value.startsWith(PREFIX));
}

export function protectSecret(plain: string | undefined): string | undefined {
  if (!plain || isProtected(plain)) return plain;
  if (process.platform !== "win32") return plain;
  try {
    const b64 = ps(
      "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:CF_SECRET), $null, 'CurrentUser'))",
      plain,
    );
    return b64 ? PREFIX + b64 : plain;
  } catch {
    return plain;
  }
}

export function revealSecret(stored: string | undefined): string | undefined {
  if (!stored || !isProtected(stored)) return stored;
  if (process.platform !== "win32") throw new Error("This password was encrypted on Windows and cannot be read here.");
  try {
    return ps(
      "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:CF_SECRET), $null, 'CurrentUser'))",
      stored.slice(PREFIX.length),
    );
  } catch {
    throw new Error("Could not decrypt the stored password. It was saved by a different Windows user. Re-enter it in the Sites dialog.");
  }
}
