import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findProjectFile, readJson, formatBytes, type CoolEvent, type ProjectConfig } from "@coolftp/core";
import type { Runner } from "./runner.js";

/**
 * Exposes coolFTP as MCP tools. Every tool routes through the same Runner the CLI uses,
 * so when the desktop app is open the user watches the agent work in real time.
 */
export async function startMcpServer(runner: Runner, version: string): Promise<void> {
  const server = new McpServer({ name: "coolftp", version });

  const siteFor = async (explicit?: string, cwd?: string): Promise<string> => {
    if (explicit) return explicit;
    const file = findProjectFile(cwd || process.cwd());
    if (file) {
      const cfg = readJson<ProjectConfig>(file, { site: "" });
      if (cfg.site) return cfg.site;
    }
    const sites = await runner.run<Array<{ name: string }>>("sites", {});
    if (sites.length === 1) return sites[0].name;
    throw new Error(
      sites.length === 0
        ? "No coolFTP sites configured. Ask the user to add one in the coolFTP app or with `coolftp site add`."
        : `Several sites exist (${sites.map((s) => s.name).join(", ")}); pass site explicitly or run coolftp_init.`,
    );
  };

  const call = async (method: string, args: Record<string, unknown>) => {
    const log: string[] = [];
    const onEvent = (e: CoolEvent) => {
      if (e.type === "log") log.push(`${e.level === "error" ? "ERROR: " : ""}${e.message}`);
      else if (e.type === "transfer" && e.transfer.status === "done") log.push(`${e.transfer.direction === "upload" ? "↑" : "↓"} ${e.transfer.remote} (${formatBytes(e.transfer.size)})`);
      else if (e.type === "transfer" && e.transfer.status === "error") log.push(`FAILED ${e.transfer.remote}: ${e.transfer.error}`);
    };
    const result = await runner.run(method, args, onEvent);
    return { result, log };
  };

  const text = (obj: unknown, log: string[] = []) => ({
    content: [{ type: "text" as const, text: (log.length ? log.join("\n") + "\n\n" : "") + (typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)) }],
  });
  const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(err as Error)?.message || String(err)}` }], isError: true });

  const siteArg = z.string().optional().describe("Site name. Defaults to the site in the nearest .coolftp.json, or the only saved site.");
  const cwdArg = z.string().optional().describe("Project directory. Defaults to the MCP server working directory.");

  server.tool(
    "coolftp_sites",
    "List the servers saved in coolFTP (name, host, protocol, remote root). Secrets are never returned.",
    {},
    async () => {
      try {
        const { result } = await call("sites", {});
        return text(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_status",
    "Show which site the current project deploys to, whether the coolFTP desktop app is running, and live connections.",
    { cwd: cwdArg },
    async ({ cwd }) => {
      try {
        const file = findProjectFile(cwd || process.cwd());
        const cfg = file ? readJson<ProjectConfig>(file, { site: "" }) : null;
        const { result: connections } = await call("connections", {});
        return text({ projectFile: file, config: cfg, app: runner.mode === "hub" ? { running: true, port: runner.hubPort } : { running: false }, connections });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_init",
    "Link a project directory to a site by writing .coolftp.json. Do this once so later deploys need no site argument.",
    {
      cwd: cwdArg,
      site: z.string().describe("Site name to deploy this project to"),
      remoteRoot: z.string().optional().describe("Remote directory for this project, if different from the site root"),
      localDir: z.string().optional().describe("Sub-directory to deploy, e.g. \"dist\""),
      build: z.string().optional().describe("Command to run before each deploy, e.g. \"npm run build\""),
      ignore: z.array(z.string()).optional().describe("Extra gitignore-style patterns"),
    },
    async ({ cwd, site, remoteRoot, localDir, build, ignore }) => {
      try {
        const config: ProjectConfig = { site };
        if (remoteRoot) config.remoteRoot = remoteRoot;
        if (localDir) config.localDir = localDir;
        if (build) config.build = build;
        if (ignore?.length) config.ignore = ignore;
        const { result } = await call("init", { cwd: cwd || process.cwd(), config });
        return text({ file: result, config });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_diff",
    "Preview a deploy: which files would be added, changed or are stale on the server. Uploads nothing.",
    { cwd: cwdArg, site: siteArg, force: z.boolean().optional().describe("Compare as if nothing had been deployed") },
    async ({ cwd, site, force }) => {
      try {
        const { result, log } = await call("diff", { cwd: cwd || process.cwd(), site, force });
        const r = result as { plan: unknown; remoteRoot: string; site: { name: string } };
        return text({ site: r.site.name, remoteRoot: r.remoteRoot, plan: r.plan }, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_deploy",
    "Upload the project's changed files to its web server. Runs the configured build first. Use dryRun to preview, delete to remove stale remote files, commit to git-commit before deploying.",
    {
      cwd: cwdArg,
      site: siteArg,
      message: z.string().optional().describe("Short note stored with the deploy (and used as the commit message with commit=true)"),
      dryRun: z.boolean().optional(),
      delete: z.boolean().optional().describe("Delete remote files that no longer exist locally"),
      force: z.boolean().optional().describe("Re-upload every file"),
      commit: z.boolean().optional().describe("git add -A && git commit before deploying"),
      skipBuild: z.boolean().optional(),
    },
    async ({ cwd, site, message, dryRun, delete: del, force, commit, skipBuild }) => {
      try {
        const { result, log } = await call("deploy", { cwd: cwd || process.cwd(), options: { site, message, dryRun, delete: del, force, commit, skipBuild } });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_history",
    "Recent deploys for a site, newest first, with git commit and which agent did it.",
    { site: siteArg, limit: z.number().int().min(1).max(100).optional() },
    async ({ site, limit }) => {
      try {
        const s = await siteFor(site);
        const { result } = await call("history", { site: s, limit: limit ?? 15 });
        return text(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_ls",
    "List a remote directory. Paths are relative to the site root unless they start with /.",
    { site: siteArg, path: z.string().optional().describe("Remote directory; defaults to the site root") },
    async ({ site, path }) => {
      try {
        const s = await siteFor(site);
        const { result } = await call("ls", { site: s, path });
        const r = result as { path: string; entries: Array<{ name: string; type: string; size: number; mtime: number }> };
        const lines = r.entries.map((e) => `${e.type === "dir" ? "d" : e.type === "link" ? "l" : "-"} ${String(e.size).padStart(10)}  ${e.mtime ? new Date(e.mtime).toISOString().slice(0, 16) : "                "}  ${e.name}${e.type === "dir" ? "/" : ""}`);
        return text(`${s}:${r.path}\n${lines.join("\n") || "(empty)"}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_read",
    "Read a text file from the server (up to 512 KB).",
    { site: siteArg, path: z.string() },
    async ({ site, path }) => {
      try {
        const s = await siteFor(site);
        const { result } = await call("read", { site: s, path });
        const r = result as { path: string; content: string; truncated: boolean };
        return text(`${r.path}${r.truncated ? " (truncated)" : ""}\n\n${r.content}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_write",
    "Write text content to a file on the server, creating parent directories.",
    { site: siteArg, path: z.string(), content: z.string() },
    async ({ site, path, content }) => {
      try {
        const s = await siteFor(site);
        const { result, log } = await call("write", { site: s, path, content });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_upload",
    "Upload a local file or directory to a remote path.",
    { site: siteArg, local: z.string().describe("Absolute or cwd-relative local path"), remote: z.string().optional().describe("Remote path; defaults to the site root") },
    async ({ site, local, remote }) => {
      try {
        const s = await siteFor(site);
        const { result, log } = await call("upload", { site: s, local, remote: remote ?? "" });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_download",
    "Download a remote file or directory to a local path.",
    { site: siteArg, remote: z.string(), local: z.string().describe("Local destination; defaults to the current directory") },
    async ({ site, remote, local }) => {
      try {
        const s = await siteFor(site);
        const { result, log } = await call("download", { site: s, remote, local: local || "." });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_mkdir",
    "Create a remote directory (and parents).",
    { site: siteArg, path: z.string() },
    async ({ site, path }) => {
      try {
        const s = await siteFor(site);
        const { result, log } = await call("mkdir", { site: s, path });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_delete",
    "Delete a remote file or directory. Refuses to delete the site root.",
    { site: siteArg, path: z.string() },
    async ({ site, path }) => {
      try {
        const s = await siteFor(site);
        const { result, log } = await call("remove", { site: s, path });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_rename",
    "Rename or move a remote path.",
    { site: siteArg, from: z.string(), to: z.string() },
    async ({ site, from, to }) => {
      try {
        const s = await siteFor(site);
        const { result, log } = await call("rename", { site: s, from, to });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
