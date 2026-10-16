#!/usr/bin/env node
// Starts the coolFTP MCP server for the plugin. A `coolftp` already on PATH (npm i -g coolftp)
// wins, so the server matches the CLI and the desktop app the user installed; otherwise npx
// fetches the latest coolftp from npm. stdio is passed straight through.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const win = process.platform === "win32";

function onPath(name) {
  const exts = win ? [".cmd", ".exe", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

const installed = process.env.COOLFTP_BIN || onPath("coolftp");
const script = installed && /\.[cm]?js$/i.test(installed);
const [cmd, args] = script
  ? [process.execPath, [installed, "mcp"]]
  : installed
    ? [installed, ["mcp"]]
    : ["npx", ["-y", "coolftp@latest", "mcp"]];

// Windows runs .cmd shims (npx, a global coolftp) only through the shell. The arguments are fixed,
// and a path with spaces is quoted for cmd.exe.
const shell = win && !script;
const child = spawn(shell && /\s/.test(cmd) ? `"${cmd}"` : cmd, args, {
  stdio: "inherit",
  shell,
  env: { ...process.env, npm_config_update_notifier: "false" },
});

child.on("error", (err) => {
  process.stderr.write(`coolFTP: could not start the MCP server (${err.message}). Install Node 18+ and run: npm i -g coolftp\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
