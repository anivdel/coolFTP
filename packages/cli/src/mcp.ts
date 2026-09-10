import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  findProjectFile,
  readJson,
  formatBytes,
  projectRemotePath,
  type CoolEvent,
  type DeployResult,
  type DeployRecord,
  type ProjectConfig,
  type VerifyResult,
} from "@coolftp/core";
import type { Runner } from "./runner.js";
import { sandboxNote } from "./runner.js";
import { capList, compactPlan, formatDuration } from "./format.js";

/** Per-file lines an agent sees before the rest collapse into a count. */
const LOG_FILE_LINES = 20;

/** What coolftp_undo would do with this deploy's backup. */
function describeUndo(b: NonNullable<DeployRecord["backup"]>): string {
  const kept = Object.keys(b.changed).length + Object.keys(b.deleted).length;
  const parts: string[] = [];
  if (kept) parts.push(`restores ${kept} previous version${kept === 1 ? "" : "s"} kept on the server`);
  if (b.added.length) parts.push(`removes ${b.added.length} added file${b.added.length === 1 ? "" : "s"}`);
  return `coolftp_undo ${parts.join(" and ") || "is available"}`;
}

/**
 * Exposes coolFTP as MCP tools. Every call asks the factory for a runner, so the desktop app
 * can be opened or closed while a session runs: calls route through it whenever it is up.
 */
export async function startMcpServer(factory: { get(): Promise<Runner> }, version: string): Promise<void> {
  const server = new McpServer({ name: "coolftp", version });

  const siteFor = async (runner: Runner, explicit?: string, cwd?: string): Promise<string> => {
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

  /** Run a method, collecting a readable log: full detail for small jobs, a summary for big ones. */
  const call = async (method: string, args: Record<string, unknown>) => {
    const runner = await factory.get();
    const log: string[] = [];
    let fileLines = 0;
    let lastProgress = "";
    const onEvent = (e: CoolEvent) => {
      if (e.type === "log") log.push(`${e.level === "error" ? "ERROR: " : e.level === "warn" ? "WARNING: " : ""}${e.message}`);
      else if (e.type === "transfer" && e.transfer.status === "done") {
        fileLines++;
        if (fileLines <= LOG_FILE_LINES) log.push(`${e.transfer.direction === "upload" ? "↑" : "↓"} ${e.transfer.remote} (${formatBytes(e.transfer.size)})`);
      } else if (e.type === "transfer" && e.transfer.status === "error") log.push(`FAILED ${e.transfer.remote}: ${e.transfer.error}`);
      else if (e.type === "progress" && e.progress.done) {
        const p = e.progress;
        lastProgress = `${p.files.toLocaleString()} files, ${formatBytes(p.bytes)} in ${p.connections > 1 ? `${p.connections} connections` : "one connection"}`;
      } else if (e.type === "created") log.push(`Created folder${e.dirs.length === 1 ? "" : "s"}: ${capList(e.dirs, 10).join(", ")}${e.topLevel.length ? ` (new top-level: ${e.topLevel.join(", ")})` : ""}`);
    };
    const result = await runner.run(method, args, onEvent);
    if (fileLines > LOG_FILE_LINES) log.push(`… ${fileLines - LOG_FILE_LINES} more files${lastProgress ? ` (${lastProgress})` : ""}`);
    const warning =
      runner.mode === "hub" && runner.appVersion && runner.appVersion !== version
        ? `NOTE: the coolFTP app is ${runner.appVersion} and this MCP server is ${version}; commands run inside the app with its version.`
        : undefined;
    return { result, log: warning ? [warning, ...log] : log, runner };
  };

  const text = (obj: unknown, log: string[] = []) => ({
    content: [{ type: "text" as const, text: (log.length ? log.join("\n") + "\n\n" : "") + (typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)) }],
  });
  const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(err as Error)?.message || String(err)}` }], isError: true });

  const verifySummary = (v?: VerifyResult) =>
    v ? { ok: v.ok, stale: v.stale, checks: v.checks.map((c) => ({ url: c.url, status: c.status, ok: c.ok, content: c.content, error: c.error })) } : undefined;
  const recordSummary = (r?: DeployRecord) =>
    r
      ? {
          id: r.id,
          at: r.at,
          message: r.message,
          added: r.added,
          changed: r.changed,
          deleted: r.deleted,
          bytes: r.bytes,
          duration: formatDuration(r.durationMs),
          git: r.git ? `${r.git.short} on ${r.git.branch}${r.git.dirty ? " (dirty)" : ""}` : undefined,
          undoOf: r.undoOf,
          rollbackOf: r.rollbackOf,
          connections: r.connections,
          backup: r.backup ? { id: r.backup.id, files: Object.keys(r.backup.changed).length + Object.keys(r.backup.deleted).length + r.backup.added.length, bytes: r.backup.bytes } : undefined,
        }
      : undefined;
  /** Deploy-shaped results without thousands of paths: counts, folders, a few examples. */
  const compactDeploy = (r: DeployResult & { undoOf?: string; commit?: string }) => {
    const live = r.verify ? (r.verify.ok ? (r.verify.stale ? "live, but some files are still served from an old copy (cache or CDN)" : "live: every check passed") : "NOT VERIFIED: the site did not answer as expected, do not report this deploy as live") : undefined;
    return {
      site: r.site,
      remoteRoot: r.remoteRoot,
      dryRun: r.dryRun,
      live,
      record: recordSummary(r.record),
      plan: compactPlan(r.plan),
      urls: capList(r.urls, 8),
      verify: verifySummary(r.verify),
      createdDirs: r.createdDirs?.length ? capList(r.createdDirs, 10) : undefined,
      undoOf: r.undoOf,
      commit: r.commit,
      undo: r.record?.backup && !r.dryRun ? describeUndo(r.record.backup) : undefined,
    };
  };

  const siteArg = z.string().optional().describe("Site name. Defaults to the site in the nearest .coolftp.json, or the only saved site.");
  const cwdArg = z.string().optional().describe("Project directory. Defaults to the MCP server working directory.");
  const pathNote = "Relative paths are relative to the project's remote directory from .coolftp.json (the same place deploy writes to), or the site root when the project has none. Paths starting with / are absolute on the server.";
  /** Site and remote path for a browsing tool, honouring the project's remoteRoot. */
  const target = async (runner: Runner, cwd: string | undefined, site: string | undefined, p: string | undefined) => {
    const s = await siteFor(runner, site, cwd);
    return { site: s, path: projectRemotePath(cwd || process.cwd(), s, p) };
  };

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
    "Show which site the current project deploys to, whether the coolFTP desktop app is running (calls route through it when it is), and live connections.",
    { cwd: cwdArg },
    async ({ cwd }) => {
      try {
        const file = findProjectFile(cwd || process.cwd());
        const cfg = file ? readJson<ProjectConfig>(file, { site: "" }) : null;
        const { result: connections, runner } = await call("connections", {});
        const note = runner.mode === "direct" ? sandboxNote() : undefined;
        return text({
          projectFile: file,
          config: cfg,
          app: runner.mode === "hub" ? { running: true, port: runner.hubPort, version: runner.appVersion } : { running: false },
          cli: version,
          mode: runner.mode,
          connections,
          note,
        });
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
      url: z.string().optional().describe("Public URL that remote directory is served at, e.g. https://example.com. Enables post-deploy verification with correct URLs."),
      localDir: z.string().optional().describe("Sub-directory to deploy, e.g. \"dist\""),
      build: z.string().optional().describe("Command to run before each deploy, e.g. \"npm run build\""),
      ignore: z.array(z.string()).optional().describe("Extra gitignore-style patterns"),
      keepBackups: z.number().int().min(0).optional().describe("Deploys whose previous versions stay on the server for undo (default 5, 0 disables)"),
    },
    async ({ cwd, site, remoteRoot, url, localDir, build, ignore, keepBackups }) => {
      try {
        const config: ProjectConfig = { site };
        if (remoteRoot) config.remoteRoot = remoteRoot;
        if (url) config.url = url.replace(/\/+$/, "");
        if (localDir) config.localDir = localDir;
        if (build) config.build = build;
        if (ignore?.length) config.ignore = ignore;
        if (keepBackups !== undefined) config.keepBackups = keepBackups;
        const { result } = await call("init", { cwd: cwd || process.cwd(), config });
        return text({ file: result, config });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_diff",
    "Preview a deploy: which files would be added, changed or are stale on the server. Uploads nothing. Long lists are summarised by folder.",
    { cwd: cwdArg, site: siteArg, force: z.boolean().optional().describe("Compare as if nothing had been deployed") },
    async ({ cwd, site, force }) => {
      try {
        const { result, log } = await call("diff", { cwd: cwd || process.cwd(), site, force });
        const r = result as { plan: DeployResult["plan"]; remoteRoot: string; site: { name: string } };
        return text({ site: r.site.name, remoteRoot: r.remoteRoot, plan: compactPlan(r.plan) }, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_deploy",
    "Upload the project's changed files to its web server. Runs the configured build first. Use dryRun to preview, delete to remove stale remote files, commit to git-commit before deploying. The result says whether the site verified as live; only call it live when verify.ok is true. Previous versions of changed files stay on the server so coolftp_undo can revert.",
    {
      cwd: cwdArg,
      site: siteArg,
      message: z.string().optional().describe("Short note stored with the deploy (and used as the commit message with commit=true)"),
      dryRun: z.boolean().optional(),
      delete: z.boolean().optional().describe("Delete remote files that no longer exist locally"),
      force: z.boolean().optional().describe("Re-upload every file"),
      commit: z.boolean().optional().describe("git add -A && git commit before deploying"),
      skipBuild: z.boolean().optional(),
      deleteUntracked: z.boolean().optional().describe("Only with delete on a first deploy: also remove remote files coolFTP never uploaded. Ask the user before setting this."),
    },
    async ({ cwd, site, message, dryRun, delete: del, force, commit, skipBuild, deleteUntracked }) => {
      try {
        const { result, log } = await call("deploy", { cwd: cwd || process.cwd(), options: { site, message, dryRun, delete: del, force, commit, skipBuild, deleteUntracked } });
        return text(compactDeploy(result as DeployResult), log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_undo",
    "Put back the previous versions the last deploy set aside on the server: overwritten files are restored, files it added are removed, files it deleted come back. Needs no git. Use dryRun to see what it would do. The coolFTP app asks the user to approve when it is open.",
    {
      cwd: cwdArg,
      site: siteArg,
      to: z.string().optional().describe("Deploy id from coolftp_history to undo instead of the latest (only if no later deploy touched its files)"),
      dryRun: z.boolean().optional().describe("Report what would be restored and removed without changing the server"),
      message: z.string().optional(),
    },
    async ({ cwd, site, to, dryRun, message }) => {
      try {
        const { result, log } = await call("undo", { cwd: cwd || process.cwd(), site, to, dryRun, message });
        return text(compactDeploy(result as DeployResult & { undoOf: string }), log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_verify",
    "Fetch the project's public URL and the files of the last deploy (or the given paths) and report status codes, plus whether static files are being served with the local bytes. Deploys nothing.",
    { cwd: cwdArg, site: siteArg, paths: z.array(z.string()).optional().describe("Paths relative to the project's remote directory to check instead of the last deploy's files") },
    async ({ cwd, site, paths }) => {
      try {
        const { result, log } = await call("verify", { cwd: cwd || process.cwd(), site, paths });
        const r = result as VerifyResult & { urls: string[] };
        return text({ live: r.ok ? (r.stale ? "live, but some files are still served from an old copy" : "live") : "NOT LIVE: a check failed", ...verifySummary(r) }, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_rollback",
    "Put the server back to an earlier deploy's git commit. With no target, restores the previous commit that was live for this project. Requires git; for a quick revert of the last deploy without git use coolftp_undo. The coolFTP app asks the user to approve when it is open.",
    {
      cwd: cwdArg,
      site: siteArg,
      to: z.string().optional().describe("Commit hash, branch, tag, or a deploy id from coolftp_history"),
      build: z.boolean().optional().describe("Run the project build command inside the checkout before deploying"),
      message: z.string().optional(),
    },
    async ({ cwd, site, to, build, message }) => {
      try {
        const { result, log } = await call("rollback", { cwd: cwd || process.cwd(), site, to, build, message });
        return text(compactDeploy(result as DeployResult & { commit: string }), log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_history",
    "Recent deploys for a site, newest first, with git commit, which agent did it, whether the live checks passed, and whether it can be undone.",
    { site: siteArg, limit: z.number().int().min(1).max(100).optional() },
    async ({ site, limit }) => {
      try {
        const runner = await factory.get();
        const s = await siteFor(runner, site);
        const { result } = await call("history", { site: s, limit: limit ?? 15 });
        const list = (result as Array<DeployRecord & { project?: string }>).map((d) => ({
          ...recordSummary(d),
          agent: d.agent,
          project: d.project,
          live: d.verify ? (d.verify.ok ? (d.verify.stale ? "stale" : "live") : "failed") : undefined,
          undoable: Boolean(d.backup),
          files: capList(d.files, 10),
        }));
        return text(list);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_ls",
    `List a remote directory. ${pathNote}`,
    { cwd: cwdArg, site: siteArg, path: z.string().optional().describe("Remote directory; defaults to the project's remote directory") },
    async ({ cwd, site, path }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rp } = await target(runner, cwd, site, path);
        const { result } = await call("ls", { site: s, path: rp });
        const r = result as { path: string; entries: Array<{ name: string; type: string; size: number; mtime: number }> };
        const lines = r.entries.map((e) => `${e.type === "dir" ? "d" : e.type === "link" ? "l" : "-"} ${String(e.size).padStart(10)}  ${e.mtime ? new Date(e.mtime).toISOString().slice(0, 16) : "                "}  ${e.name}${e.type === "dir" ? "/" : ""}`);
        return text(`${s}:${r.path}\n${lines.join("\n") || "(empty)"}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_stat",
    `Check whether a remote path exists and get its type, size and date, without downloading it. ${pathNote}`,
    { cwd: cwdArg, site: siteArg, path: z.string() },
    async ({ cwd, site, path }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rp } = await target(runner, cwd, site, path);
        const { result } = await call("stat", { site: s, path: rp });
        return text(result ? { exists: true, site: s, ...(result as object) } : { exists: false, site: s, path: rp });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_read",
    `Read a text file from the server (up to 512 KB). ${pathNote}`,
    { cwd: cwdArg, site: siteArg, path: z.string() },
    async ({ cwd, site, path }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rp } = await target(runner, cwd, site, path);
        const { result } = await call("read", { site: s, path: rp });
        const r = result as { path: string; content: string; truncated: boolean };
        return text(`${r.path}${r.truncated ? " (truncated)" : ""}\n\n${r.content}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_write",
    `Write text content to a file on the server, creating parent directories. ${pathNote}`,
    { cwd: cwdArg, site: siteArg, path: z.string(), content: z.string() },
    async ({ cwd, site, path, content }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rp } = await target(runner, cwd, site, path);
        const { result, log } = await call("write", { site: s, path: rp, content });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_upload",
    `Upload a local file or directory to a remote path. The server confirms each file's size afterwards, and files inside the project's remote directory are recorded in the deploy manifest so the next deploy does not send them again. ${pathNote}`,
    { cwd: cwdArg, site: siteArg, local: z.string().describe("Absolute or cwd-relative local path"), remote: z.string().optional().describe("Remote path; defaults to the project's remote directory") },
    async ({ cwd, site, local, remote }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rp } = await target(runner, cwd, site, remote);
        const { result, log } = await call("upload", { site: s, local, remote: rp ?? "", cwd: cwd || process.cwd() });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_download",
    `Download a remote file or directory to a local path. ${pathNote}`,
    { cwd: cwdArg, site: siteArg, remote: z.string(), local: z.string().describe("Local destination; defaults to the current directory") },
    async ({ cwd, site, remote, local }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rp } = await target(runner, cwd, site, remote);
        const { result, log } = await call("download", { site: s, remote: rp, local: local || "." });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_mkdir",
    `Create a remote directory (and parents). ${pathNote}`,
    { cwd: cwdArg, site: siteArg, path: z.string() },
    async ({ cwd, site, path }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rp } = await target(runner, cwd, site, path);
        const { result, log } = await call("mkdir", { site: s, path: rp });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_delete",
    `Delete a remote file or directory. Refuses to delete the site root. The coolFTP app asks the user to approve when it is open. ${pathNote}`,
    { cwd: cwdArg, site: siteArg, path: z.string() },
    async ({ cwd, site, path }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rp } = await target(runner, cwd, site, path);
        const { result, log } = await call("remove", { site: s, path: rp });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "coolftp_rename",
    `Rename or move a remote path. ${pathNote}`,
    { cwd: cwdArg, site: siteArg, from: z.string(), to: z.string() },
    async ({ cwd, site, from, to }) => {
      try {
        const runner = await factory.get();
        const { site: s, path: rf } = await target(runner, cwd, site, from);
        const rt = projectRemotePath(cwd || process.cwd(), s, to);
        const { result, log } = await call("rename", { site: s, from: rf, to: rt });
        return text(result, log);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
