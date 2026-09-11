// Packs the MCP server into a Claude Desktop extension: release/coolFTP-<version>.mcpb
//   npm run mcpb            (runs the build first)
// The bundle is the CLI's single bundled file plus a manifest and the icon; no node_modules,
// because Claude Desktop ships its own Node runtime and the CLI bundle has no runtime deps.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dir = path.join(root, "release", "mcpb");
const outName = `coolFTP-${pkg.version}.mcpb`;
const out = path.join(root, "release", outName);
const server = path.join(root, "packages", "cli", "dist", "coolftp.js");
if (!fs.existsSync(server)) throw new Error("packages/cli/dist/coolftp.js is missing: run npm run build first");

const tools = [
  ["coolftp_status", "Which site the current project deploys to, whether the coolFTP desktop app is running, and live connections."],
  ["coolftp_sites", "List the saved sites."],
  ["coolftp_init", "Link a project folder to a site by writing its .coolftp.json."],
  ["coolftp_diff", "Preview a deploy: which files would be added, changed, or are stale on the server. Uploads nothing."],
  ["coolftp_deploy", "Upload the project's changed files, keep the previous versions on the server for undo, then check that the site is live."],
  ["coolftp_verify", "Fetch the site's public URL and the last deploy's files and report what answered, including stale caches."],
  ["coolftp_history", "Recent deploys with their git commit, who deployed, whether the live checks passed, and whether each can be undone."],
  ["coolftp_undo", "Put back the previous versions the last deploy overwrote and remove the files it added. No git needed."],
  ["coolftp_rollback", "Deploy the files of an earlier commit that was live."],
  ["coolftp_ls", "List a remote directory."],
  ["coolftp_stat", "Whether a remote file exists, how big it is, and since when."],
  ["coolftp_read", "Read a remote text file."],
  ["coolftp_write", "Write a remote text file."],
  ["coolftp_upload", "Upload one local file or folder into a remote directory."],
  ["coolftp_download", "Download one remote file or folder into a local directory."],
  ["coolftp_mkdir", "Create a remote directory."],
  ["coolftp_rename", "Rename or move a remote file or folder."],
  ["coolftp_delete", "Delete a remote file or folder, after the user approves it in the coolFTP app."],
];

const manifest = {
  manifest_version: "0.3",
  name: "coolftp",
  display_name: "coolFTP",
  version: pkg.version,
  description: "Deploy a website to its SFTP or FTP server: only changed files go up, undo without git, live checks, approvals in the coolFTP desktop app.",
  long_description:
    "coolFTP gives Claude the tools to put a site on its server the way a careful developer would. A deploy uploads only the files whose content changed, keeps the previous versions on the server so it can be undone, records the git commit that went live, and checks that the site actually answers afterwards. Deletes, undos and rollbacks wait for your click in the coolFTP desktop app, and everything shows up there live. Install the desktop app from coolftp.com, add your site in it, and Claude can deploy from any folder that carries a .coolftp.json.",
  author: { name: "Justin Ledvina", url: "https://coolftp.com" },
  homepage: "https://coolftp.com",
  documentation: "https://github.com/anivdel/coolFTP#readme",
  support: "https://github.com/anivdel/coolFTP/issues",
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "server/coolftp.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/coolftp.js", "mcp"],
      env: { COOLFTP_AGENT: "claude-desktop", COOLFTP_PROJECT: "${user_config.project}" },
    },
  },
  tools: tools.map(([name, description]) => ({ name, description })),
  user_config: {
    project: {
      type: "directory",
      title: "Default project folder",
      description: "Used when you do not name a folder in the chat. Each project can also carry its own .coolftp.json, written by coolftp init or the app's Link folder to site button.",
      required: false,
    },
  },
  keywords: ["ftp", "sftp", "deploy", "website", "hosting", "upload", "undo"],
  license: "MIT",
  repository: { type: "git", url: "https://github.com/anivdel/coolFTP.git" },
  compatibility: { claude_desktop: ">=1.0.0", platforms: ["win32", "darwin", "linux"], runtimes: { node: ">=18.0.0" } },
};

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "server"), { recursive: true });
fs.copyFileSync(server, path.join(dir, "server", "coolftp.js"));
fs.copyFileSync(path.join(root, "packages", "app", "assets", "icon.png"), path.join(dir, "icon.png"));
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// Relative paths on purpose: the checkout lives in a folder with a space, which a shell command line would mangle.
const mcpb = (args) => execSync(`npx --yes @anthropic-ai/mcpb ${args}`, { cwd: root, stdio: "inherit" });
mcpb("validate release/mcpb/manifest.json");
fs.rmSync(out, { force: true });
mcpb(`pack release/mcpb release/${outName}`);

const sha = crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex");
// Keep the MCP Registry entry in step with the bundle.
const registry = path.join(root, "server.json");
if (fs.existsSync(registry)) {
  const s = JSON.parse(fs.readFileSync(registry, "utf8"));
  s.version = pkg.version;
  for (const p of s.packages ?? []) {
    if (p.registryType === "npm") p.version = pkg.version;
    if (p.registryType !== "mcpb") continue;
    p.identifier = `https://coolftp.com/releases/${outName}`;
    p.fileSha256 = sha;
  }
  fs.writeFileSync(registry, JSON.stringify(s, null, 2) + "\n");
}
console.log(`\n${path.relative(root, out)}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB\nSHA-256 ${sha}`);
