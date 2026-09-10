import path from "node:path";
import { Command } from "commander";
import {
  configDir,
  formatBytes,
  findProjectFile,
  readJson,
  cleanRemotePath,
  projectRemotePath,
  defaultPrivateKey,
  type CoolEvent,
  type EventMeta,
  type DeployResult,
  type DiffResult,
  type DiffPlan,
  type DeployRecord,
  type ProgressInfo,
  type RemoteEntry,
  type Site,
  type ProjectConfig,
  type VerifyResult,
} from "@coolftp/core";
import { createRunner, detectAgent, readHubInfo, runnerFactory, sandboxNote, type Runner } from "./runner.js";
import { startMcpServer } from "./mcp.js";
import { formatDuration, groupByDir } from "./format.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0";

/** Exit code when the files landed but the live checks afterwards failed. */
const EXIT_VERIFY_FAILED = 3;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  magenta: (s: string) => (useColor ? `\x1b[35m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

interface Globals {
  agent: string;
  json: boolean;
  direct: boolean;
  quiet: boolean;
}

const program = new Command();
program
  .name("coolftp")
  .description("coolFTP: deploy files to your web server from the terminal, or let a coding agent do it.")
  .version(VERSION)
  .option("--agent <name>", "name of the agent driving this command (shown in the desktop app)")
  .option("--json", "print machine-readable JSON to stdout", false)
  .option("--direct", "do not route through the running desktop app", false)
  .option("-q, --quiet", "no progress or per-file output; results, warnings and errors still print", false);

function globals(): Globals {
  const o = program.opts();
  return { agent: detectAgent(o.agent), json: Boolean(o.json), direct: Boolean(o.direct), quiet: Boolean(o.quiet) };
}

function progressLine(p: ProgressInfo): string {
  const pct = p.totalBytes ? Math.round((p.bytes / p.totalBytes) * 100) : p.totalFiles ? Math.round((p.files / p.totalFiles) * 100) : 0;
  const rate = p.rate > 0 && !p.done ? ` · ${formatBytes(p.rate)}/s` : "";
  const eta = !p.done && p.etaMs > 0 ? ` · ~${formatDuration(p.etaMs)} left` : "";
  const conn = p.connections > 1 ? ` · ${p.connections} connections` : "";
  return `${p.done ? "done: " : ""}${p.files.toLocaleString()}/${p.totalFiles.toLocaleString()} files · ${formatBytes(p.bytes)} of ${formatBytes(p.totalBytes)} (${pct}%)${rate}${eta}${conn}`;
}

/**
 * Prints events as they stream in. On a terminal, big operations show one updating progress
 * line; when the output is captured (an agent's shell), a progress line every few seconds
 * replaces the per-file lines, so a 15,000-file deploy is a screen, not a book.
 */
function printer(g: Globals) {
  const tty = Boolean(process.stderr.isTTY);
  const out = (s: string) => process.stderr.write(s + "\n");
  let bigOp = false;
  let lastProgressAt = 0;
  let progressOpen = false;
  const closeProgress = () => {
    if (progressOpen) {
      process.stderr.write("\n");
      progressOpen = false;
    }
  };
  return (event: CoolEvent, _meta: EventMeta) => {
    switch (event.type) {
      case "log": {
        if (g.quiet && event.level === "info") return;
        closeProgress();
        const tag =
          event.level === "error" ? c.red("✖") : event.level === "warn" ? c.yellow("!") : event.level === "success" ? c.green("✔") : c.dim("·");
        out(`${tag} ${event.message}`);
        break;
      }
      case "connect":
        if (g.quiet) return;
        if (event.status === "connecting") out(c.dim(`… connecting to ${event.site}`));
        if (event.status === "error") out(c.red(`✖ ${event.site}: ${event.error}`));
        break;
      case "transfer": {
        const t = event.transfer;
        if (t.status === "error") {
          closeProgress();
          out(c.red(`✖ ${t.remote}: ${t.error}`));
        } else if (t.status === "done" && !g.quiet && !bigOp) {
          out(`${t.direction === "upload" ? c.cyan("↑") : c.magenta("↓")} ${t.remote} ${c.dim(formatBytes(t.size))}`);
        }
        break;
      }
      case "scan":
        if (g.quiet) return;
        if (event.current) {
          if (tty) process.stderr.write(`\r${c.dim(`scanned ${event.count} files…`)}`);
        } else if (event.count) out(`${tty ? "\r" : ""}${c.dim(`scanned ${event.count} files`)}      `);
        break;
      case "progress": {
        const p = event.progress;
        if (p.totalFiles > 20) bigOp = true;
        if (g.quiet || !bigOp) return;
        const line = c.dim(`· ${progressLine(p)}`);
        if (tty) {
          process.stderr.write(`\r${line}${" ".repeat(12)}`);
          progressOpen = true;
          if (p.done) closeProgress();
        } else if (p.done || Date.now() - lastProgressAt >= 5000) {
          lastProgressAt = Date.now();
          out(line);
        }
        break;
      }
      case "created": {
        if (g.quiet) return;
        const shown = event.dirs.slice(0, 6);
        out(c.dim(`· created ${event.dirs.length} folder${event.dirs.length === 1 ? "" : "s"}: ${shown.join(", ")}${event.dirs.length > shown.length ? `, … ${event.dirs.length - shown.length} more` : ""}`));
        break;
      }
      default:
        break;
    }
  };
}

let versionWarned = false;

async function withRunner<T>(fn: (r: Runner, g: Globals) => Promise<T>): Promise<void> {
  const g = globals();
  const runner = await createRunner({ agent: g.agent, direct: g.direct });
  if (!g.quiet && !g.json && runner.mode === "hub") process.stderr.write(c.dim(`via coolFTP app (port ${runner.hubPort})\n`));
  if (!g.json && !versionWarned && runner.mode === "hub" && runner.appVersion && runner.appVersion !== VERSION) {
    versionWarned = true;
    process.stderr.write(c.yellow(`! the coolFTP app is ${runner.appVersion} and this CLI is ${VERSION}. Commands run inside the app with its version; install the matching app to get the new behaviour there.\n`));
  }
  try {
    const result = await fn(runner, g);
    if (g.json && result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    const r = result as { verify?: VerifyResult; ok?: boolean; checks?: unknown } | undefined;
    if (r && typeof r === "object" && ((r.verify && r.verify.ok === false) || (Array.isArray(r.checks) && r.ok === false))) process.exitCode = EXIT_VERIFY_FAILED;
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    if (g.json) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
    else process.stderr.write(c.red(`✖ ${msg}\n`));
    process.exitCode = 1;
  } finally {
    await runner.close();
  }
}

/** Site from --site, else from the nearest .coolftp.json, else the only site if there is exactly one. */
async function resolveSite(runner: Runner, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const file = findProjectFile(process.cwd());
  if (file) {
    const cfg = readJson<ProjectConfig>(file, { site: "" });
    if (cfg.site) return cfg.site;
  }
  const sites = await runner.run<Array<{ name: string }>>("sites", {});
  if (sites.length === 1) return sites[0].name;
  if (sites.length === 0) throw new Error("No sites yet. Add one: coolftp site add <name> --host <host> --user <user>");
  throw new Error(`Several sites exist (${sites.map((s) => s.name).join(", ")}). Pass --site <name> or run coolftp init <site>.`);
}

/**
 * Site plus the remote path a browsing command acts on. Relative paths follow the project's
 * remoteRoot from .coolftp.json, the same directory deploy writes to.
 */
async function resolveTarget(runner: Runner, explicit: string | undefined, p: string | undefined): Promise<{ site: string; path: string | undefined }> {
  const site = await resolveSite(runner, explicit);
  return { site, path: projectRemotePath(process.cwd(), site, cleanRemotePath(p)) };
}

// ---------------- site ----------------

const site = program.command("site").description("manage saved servers");

site
  .command("add <name>")
  .description("add or update a server")
  .requiredOption("-H, --host <host>", "hostname")
  .requiredOption("-u, --user <user>", "username")
  .option("-p, --port <port>", "port (22 for sftp, 21 for ftp)")
  .option("--protocol <protocol>", "sftp | ftp | ftps", "sftp")
  .option("--password <password>", "password (stored in plain text; prefer --key for sftp)")
  .option("-k, --key <path>", "private key path (defaults to ~/.ssh/id_ed25519 or id_rsa)")
  .option("--passphrase <passphrase>", "private key passphrase")
  .option("-r, --root <remoteRoot>", "remote directory to deploy into", "/")
  .option("-l, --local <localRoot>", "default local project directory")
  .option("--color <hex>", "accent colour in the app")
  .option("--url <url>", "public URL the remote root is served at (enables post-deploy checks)")
  .option("--connections <n>", "parallel connections for large FTP transfers (default 4)")
  .action((name: string, o) =>
    withRunner(async (r, g) => {
      const s: Site = {
        name,
        host: o.host,
        username: o.user,
        port: Number(o.port) || (o.protocol === "sftp" ? 22 : 21),
        protocol: o.protocol,
        password: o.password,
        privateKeyPath: o.key,
        passphrase: o.passphrase,
        remoteRoot: cleanRemotePath(o.root),
        localRoot: o.local,
        color: o.color,
        url: o.url,
        connections: o.connections ? Math.max(1, Number(o.connections) || 1) : undefined,
      };
      const saved = await r.run("addSite", { site: s });
      if (!g.json) {
        process.stderr.write(c.green(`✔ saved site ${c.bold(name)} (${saved.protocol}://${saved.username}@${saved.host}:${saved.port}${saved.remoteRoot})\n`));
        if (saved.protocol === "sftp" && !saved.privateKeyPath && !saved.hasPassword) {
          const k = defaultPrivateKey();
          process.stderr.write(c.dim(k ? `  will authenticate with ${k} or the ssh agent\n` : "  no password or key given; will try the ssh agent\n"));
        }
      }
      return saved;
    }),
  );

site
  .command("list")
  .alias("ls")
  .description("list saved servers")
  .action(() =>
    withRunner(async (r, g) => {
      const sites = await r.run<Array<Site & { hasPassword: boolean }>>("sites", {});
      if (!g.json) {
        if (!sites.length) process.stdout.write(c.dim("no sites yet\n"));
        for (const s of sites) {
          process.stdout.write(`${c.bold(s.name.padEnd(16))} ${s.protocol}://${s.username}@${s.host}:${s.port}${s.remoteRoot}${s.localRoot ? c.dim(`  ⇐ ${s.localRoot}`) : ""}\n`);
        }
      }
      return sites;
    }),
  );

site
  .command("remove <name>")
  .alias("rm")
  .description("remove a saved server")
  .action((name: string) =>
    withRunner(async (r, g) => {
      const ok = await r.run("removeSite", { name });
      if (!g.json) process.stderr.write(ok ? c.green(`✔ removed ${name}\n`) : c.yellow(`! no site named ${name}\n`));
      return { removed: ok };
    }),
  );

site
  .command("test [name]")
  .description("connect and list the remote root")
  .action((name?: string) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, name);
      return r.run("test", { site: s }, printer(g));
    }),
  );

site
  .command("trust <name>")
  .description("forget the recorded SSH host key for a site (after a server rebuild)")
  .action((name: string) =>
    withRunner(async (r, g) => {
      const res = await r.run<{ site: string; forgot: boolean }>("trustSite", { site: name });
      if (!g.json) process.stderr.write(res.forgot ? c.green(`✔ forgot host key for ${res.site}; the next connection will record the new one\n`) : c.dim(`no host key recorded for ${res.site} yet\n`));
      return res;
    }),
  );

site
  .command("keys")
  .description("list recorded SSH host keys")
  .action(() =>
    withRunner(async (r, g) => {
      const keys = await r.run<Array<{ host: string; fingerprint: string; type: string; firstSeen: string }>>("hostKeys", {});
      if (!g.json) {
        if (!keys.length) process.stdout.write(c.dim("no host keys recorded yet\n"));
        for (const k of keys) process.stdout.write(`${c.bold(k.host.padEnd(28))} ${k.type.padEnd(14)} ${k.fingerprint}  ${c.dim(k.firstSeen.slice(0, 10))}\n`);
      }
      return keys;
    }),
  );

// ---------------- project ----------------

program
  .command("init <site>")
  .description("link the current directory to a site (writes .coolftp.json)")
  .option("-r, --remote-root <path>", "remote directory for this project (defaults to the site root)")
  .option("-u, --url <url>", "public URL that directory is served at, e.g. https://example.com (enables post-deploy checks)")
  .option("-d, --local-dir <dir>", "sub-directory to deploy, e.g. dist")
  .option("-b, --build <command>", "command to run before each deploy, e.g. \"npm run build\"")
  .option("-i, --ignore <patterns...>", "extra gitignore-style patterns")
  .option("--keep-backups <n>", "deploys whose previous versions stay on the server for undo (default 5, 0 disables)")
  .action((siteName: string, o) =>
    withRunner(async (r, g) => {
      const config: ProjectConfig = { site: siteName };
      if (o.remoteRoot) config.remoteRoot = cleanRemotePath(o.remoteRoot);
      if (o.url) config.url = String(o.url).replace(/\/+$/, "");
      if (o.localDir) config.localDir = o.localDir;
      if (o.build) config.build = o.build;
      if (o.ignore?.length) config.ignore = o.ignore;
      if (o.keepBackups !== undefined) config.keepBackups = Math.max(0, Number(o.keepBackups) || 0);
      const file = await r.run<string>("init", { cwd: process.cwd(), config });
      if (!g.json) process.stderr.write(c.green(`✔ wrote ${file}\n`) + c.dim("  run `coolftp deploy` to push this project\n"));
      return { file, config };
    }),
  );

program
  .command("status")
  .description("show the project link, the desktop app hub, and connection state")
  .action(() =>
    withRunner(async (r, g) => {
      const file = findProjectFile(process.cwd());
      const cfg = file ? readJson<ProjectConfig>(file, { site: "" }) : null;
      const hub = readHubInfo();
      const note = r.mode === "direct" ? sandboxNote() : undefined;
      const info = {
        project: file,
        config: cfg,
        app: r.mode === "hub" ? { running: true, port: r.hubPort, pid: hub?.pid, version: r.appVersion } : { running: false },
        cli: VERSION,
        agent: g.agent,
        note,
      };
      if (!g.json) {
        process.stdout.write(`${c.bold("project")}  ${file ?? c.dim("no .coolftp.json (run coolftp init <site>)")}\n`);
        if (cfg) process.stdout.write(`${c.bold("site")}     ${cfg.site}${cfg.remoteRoot ? ` → ${cfg.remoteRoot}` : ""}${cfg.url ? c.dim(`  ${cfg.url}`) : ""}${cfg.localDir ? c.dim(`  (deploys ${cfg.localDir}/)`) : ""}\n`);
        process.stdout.write(`${c.bold("app")}      ${r.mode === "hub" ? c.green(`running on port ${r.hubPort}`) + (r.appVersion ? c.dim(` (${r.appVersion})`) : "") : c.dim("not running (commands run directly)")}\n`);
        process.stdout.write(`${c.bold("cli")}      ${VERSION}\n`);
        process.stdout.write(`${c.bold("agent")}    ${g.agent}\n`);
        process.stdout.write(`${c.bold("config")}   ${configDir()}${r.mode === "hub" ? c.dim("  (sites come from the app while it is open)") : ""}\n`);
        if (note) process.stdout.write(c.yellow(`! ${note}\n`));
      }
      return { ...info, configDir: configDir() };
    }),
  );

// ---------------- browsing ----------------

program
  .command("ls [path]")
  .description("list a remote directory (relative to the project's remote directory, or the site root)")
  .option("-s, --site <name>")
  .option("-l, --long", "show sizes and dates")
  .action((p: string | undefined, o) =>
    withRunner(async (r, g) => {
      const { site: s, path: rp } = await resolveTarget(r, o.site, p);
      const res = await r.run<{ path: string; entries: RemoteEntry[] }>("ls", { site: s, path: rp }, printer(g));
      if (!g.json) {
        process.stdout.write(c.dim(`${s}:${res.path}\n`));
        for (const e of res.entries) {
          const name = e.type === "dir" ? c.cyan(e.name + "/") : e.type === "link" ? c.magenta(e.name + "@") : e.name;
          if (o.long) process.stdout.write(`${formatBytes(e.size).padStart(9)}  ${e.mtime ? new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ") : "                "}  ${name}\n`);
          else process.stdout.write(name + "\n");
        }
      }
      return res;
    }),
  );

program
  .command("stat <path>")
  .description("show whether a remote path exists, with its size and date")
  .option("-s, --site <name>")
  .action((p: string, o) =>
    withRunner(async (r, g) => {
      const { site: s, path: rp } = await resolveTarget(r, o.site, p);
      const res = await r.run<RemoteEntry | null>("stat", { site: s, path: rp });
      if (!res) {
        if (!g.json) process.stderr.write(c.red(`✖ not found: ${s}:${rp}\n`));
        process.exitCode = 1;
        return { exists: false, site: s, path: rp };
      }
      if (!g.json) process.stdout.write(`${res.type === "dir" ? "dir " : res.type === "link" ? "link" : "file"}  ${formatBytes(res.size).padStart(9)}  ${res.mtime ? new Date(res.mtime).toISOString().slice(0, 16).replace("T", " ") : "                "}  ${s}:${res.path}\n`);
      return { exists: true, site: s, ...res };
    }),
  );

program
  .command("cat <path>")
  .description("print a remote file")
  .option("-s, --site <name>")
  .action((p: string, o) =>
    withRunner(async (r, g) => {
      const { site: s, path: rp } = await resolveTarget(r, o.site, p);
      const res = await r.run<{ content: string; truncated: boolean }>("read", { site: s, path: rp });
      if (!g.json) {
        process.stdout.write(res.content);
        if (res.truncated) process.stderr.write(c.yellow("\n! output truncated\n"));
      }
      return res;
    }),
  );

program
  .command("push <local> [remote]")
  .description("upload a file or directory (remote defaults to the project's remote directory, or the site root)")
  .option("-s, --site <name>")
  .action((local: string, remote: string | undefined, o) =>
    withRunner(async (r, g) => {
      const { site: s, path: rp } = await resolveTarget(r, o.site, remote);
      return r.run("upload", { site: s, local: path.resolve(local), remote: rp ?? "", cwd: process.cwd() }, printer(g));
    }),
  );

program
  .command("pull <remote> [local]")
  .description("download a file or directory (local defaults to the current directory)")
  .option("-s, --site <name>")
  .action((remote: string, local: string | undefined, o) =>
    withRunner(async (r, g) => {
      const { site: s, path: rp } = await resolveTarget(r, o.site, remote);
      return r.run("download", { site: s, remote: rp, local: path.resolve(local ?? ".") }, printer(g));
    }),
  );

program
  .command("rm <path>")
  .description("delete a remote file or directory")
  .option("-s, --site <name>")
  .action((p: string, o) =>
    withRunner(async (r, g) => {
      const { site: s, path: rp } = await resolveTarget(r, o.site, p);
      return r.run("remove", { site: s, path: rp }, printer(g));
    }),
  );

program
  .command("mkdir <path>")
  .description("create a remote directory")
  .option("-s, --site <name>")
  .action((p: string, o) =>
    withRunner(async (r, g) => {
      const { site: s, path: rp } = await resolveTarget(r, o.site, p);
      return r.run("mkdir", { site: s, path: rp }, printer(g));
    }),
  );

program
  .command("mv <from> <to>")
  .description("rename or move a remote path")
  .option("-s, --site <name>")
  .action((from: string, to: string, o) =>
    withRunner(async (r, g) => {
      const { site: s, path: rf } = await resolveTarget(r, o.site, from);
      const rt = projectRemotePath(process.cwd(), s, cleanRemotePath(to));
      return r.run("rename", { site: s, from: rf, to: rt }, printer(g));
    }),
  );

// ---------------- deploy ----------------

function printPlan(plan: DiffPlan, remoteRoot: string, siteName: string, showDelete: boolean) {
  const w = (s: string) => process.stdout.write(s + "\n");
  w(c.dim(`${siteName}:${remoteRoot}  (basis: ${plan.basis})`));
  const section = (sym: string, paint: (s: string) => string, files: string[], label: string) => {
    if (!files.length) return;
    if (files.length <= 20) {
      for (const f of files) w(`${paint(sym)} ${f}${label.startsWith("stale") ? c.dim("  (stale, kept unless --delete)") : ""}`);
      return;
    }
    w(`${paint(sym)} ${paint(files.length.toLocaleString())} ${label}`);
    for (const [dir, n] of groupByDir(files)) w(`   ${paint(sym)} ${dir}  ${c.dim(n.toLocaleString())}`);
  };
  section("+", c.green, plan.add, "new");
  section("~", c.yellow, plan.change, "changed");
  section("-", c.red, plan.delete, showDelete ? "to delete" : "stale, kept unless --delete");
  w(
    c.bold(`${plan.add.length} new, ${plan.change.length} changed, ${plan.delete.length} stale, ${plan.unchanged} unchanged`) +
      c.dim(`  ${formatBytes(plan.bytes)} to upload`),
  );
}

program
  .command("diff")
  .description("show what deploy would upload, without uploading")
  .option("-s, --site <name>")
  .option("-f, --force", "compare as if nothing had been deployed")
  .action((o) =>
    withRunner(async (r, g) => {
      const res = await r.run<DiffResult>("diff", { cwd: process.cwd(), site: o.site, force: o.force }, printer(g));
      if (!g.json) printPlan(res.plan, res.remoteRoot, res.site.name, false);
      return { plan: res.plan, remoteRoot: res.remoteRoot, site: res.site.name };
    }),
  );

program
  .command("deploy")
  .description("upload changed files of this project to its site")
  .option("-s, --site <name>")
  .option("-m, --message <text>", "note stored with the deploy record")
  .option("--delete", "remove remote files that no longer exist locally")
  .option("--delete-untracked", "with --delete on a first deploy: also remove remote files coolFTP never uploaded")
  .option("-n, --dry-run", "show the plan and stop")
  .option("-f, --force", "re-upload every file")
  .option("-c, --commit", "git add -A && git commit -m <message> before deploying")
  .option("--no-build", "skip the configured build command")
  .action((o) =>
    withRunner(async (r, g) => {
      const res = await r.run<DeployResult>(
        "deploy",
        {
          cwd: process.cwd(),
          options: {
            site: o.site,
            message: o.message,
            delete: o.delete,
            deleteUntracked: o.deleteUntracked,
            dryRun: o.dryRun,
            force: o.force,
            commit: o.commit,
            skipBuild: o.build === false,
          },
        },
        printer(g),
      );
      if (!g.json && res.dryRun) printPlan(res.plan, res.remoteRoot, res.site, Boolean(o.delete));
      if (!g.json) printDeployExtras(res);
      return res;
    }),
  );

function printVerify(v: VerifyResult) {
  if (v.ok) {
    process.stdout.write(v.stale ? c.yellow(`! live, but ${v.stale} file${v.stale === 1 ? " is" : "s are"} still served from an old copy (a cache or CDN in front of the server)\n`) : c.green("✔ live: site answered on every check\n"));
  } else {
    const bad = v.checks.filter((x) => !x.ok);
    const answers = new Set(bad.map((b) => String(b.status || b.error || "nothing")));
    const detail =
      answers.size === 1 && bad.length > 1
        ? `all ${bad.length} checks answered ${[...answers][0]} (e.g. ${bad[0].url})`
        : bad
            .slice(0, 3)
            .map((b) => `${b.url} answered ${b.status || b.error || "nothing"}`)
            .join("; ") + (bad.length > 3 ? `; and ${bad.length - 3} more` : "");
    process.stdout.write(c.red(`✖ verification failed: ${detail}\n`));
  }
}

function printDeployExtras(res: DeployResult) {
  if (res.urls?.length && !res.dryRun) {
    const shown = res.urls.slice(0, 8);
    for (const u of shown) process.stdout.write(`${c.cyan("→")} ${u}\n`);
    if (res.urls.length > shown.length) process.stdout.write(c.dim(`  … and ${res.urls.length - shown.length} more\n`));
  }
  if (res.verify) printVerify(res.verify);
  if (res.record?.backup && !res.dryRun) process.stdout.write(c.dim(`↶ coolftp undo ${describeUndo(res.record.backup)}\n`));
}

/** "restores 3 previous versions kept on the server and removes 2 added files" */
function describeUndo(b: NonNullable<DeployRecord["backup"]>): string {
  const kept = Object.keys(b.changed).length + Object.keys(b.deleted).length;
  const parts: string[] = [];
  if (kept) parts.push(`restores ${kept} previous version${kept === 1 ? "" : "s"} kept on the server`);
  if (b.added.length) parts.push(`removes ${b.added.length} added file${b.added.length === 1 ? "" : "s"}`);
  return parts.join(" and ") || "is available";
}

program
  .command("undo")
  .description("put back the previous versions the last deploy set aside on the server (no git needed)")
  .option("-s, --site <name>")
  .option("-t, --to <deployId>", "undo a specific deploy from history instead of the latest")
  .option("-n, --dry-run", "show what would be restored and removed, without touching the server")
  .option("-m, --message <text>", "note stored with the undo record")
  .action((o) =>
    withRunner(async (r, g) => {
      const res = await r.run<DeployResult & { undoOf: string }>("undo", { cwd: process.cwd(), site: o.site, to: o.to, dryRun: o.dryRun, message: o.message }, printer(g));
      if (!g.json) {
        if (res.dryRun) {
          const w = (s: string) => process.stdout.write(s + "\n");
          w(c.dim(`${res.site}:${res.remoteRoot}  undo of ${res.undoOf}`));
          for (const f of res.plan.change) w(`${c.yellow("↶")} ${f}  ${c.dim("restore previous version")}`);
          for (const f of res.plan.add) w(`${c.green("↶")} ${f}  ${c.dim("put back deleted file")}`);
          for (const f of res.plan.delete) w(`${c.red("-")} ${f}  ${c.dim("remove added file")}`);
        }
        printDeployExtras(res);
      }
      return res;
    }),
  );

program
  .command("verify [paths...]")
  .description("fetch the site's public URL and the last deploy's files (or the given paths) and report what answers")
  .option("-s, --site <name>")
  .action((paths: string[], o) =>
    withRunner(async (r, g) => {
      const res = await r.run<VerifyResult & { urls: string[] }>("verify", { cwd: process.cwd(), site: o.site, paths }, printer(g));
      if (!g.json) printVerify(res);
      return res;
    }),
  );

program
  .command("rollback")
  .description("put the server back to an earlier deploy's commit (defaults to the previous commit that was live)")
  .option("-s, --site <name>")
  .option("-t, --to <commit|deployId>", "commit hash, branch, tag, or a deploy id from history")
  .option("-b, --build", "run the project build command inside the checkout first")
  .option("-m, --message <text>", "note stored with the rollback record")
  .action((o) =>
    withRunner(async (r, g) => {
      const res = await r.run<DeployResult & { commit: string }>("rollback", { cwd: process.cwd(), site: o.site, to: o.to, build: o.build, message: o.message }, printer(g));
      if (!g.json) printDeployExtras(res);
      return res;
    }),
  );

program
  .command("history")
  .description("recent deploys for a site")
  .option("-s, --site <name>")
  .option("-n, --limit <n>", "number of records", "15")
  .action((o) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, o.site);
      const list = await r.run<Array<DeployRecord & { project?: string }>>("history", { site: s, limit: Number(o.limit) });
      if (!g.json) {
        if (!list.length) process.stdout.write(c.dim("no deploys yet\n"));
        for (const d of list) {
          const when = d.at.slice(0, 16).replace("T", " ");
          const who = d.agent && d.agent !== "cli" ? c.magenta(` [${d.agent}]`) : "";
          const git = d.git ? c.dim(` ${d.git.short}${d.git.dirty ? "*" : ""}`) : "";
          const live = d.verify ? (d.verify.ok ? (d.verify.stale ? c.yellow(" !stale") : c.green(" ✔live")) : c.red(" ✖failed")) : "";
          const kind = d.undoOf ? c.yellow("↶undo ") : d.rollbackOf ? c.yellow("↺rollback ") : "";
          const undoable = d.backup ? c.dim(" ↶") : "";
          process.stdout.write(`${c.dim(when)}  ${c.dim(d.id)}  ${c.green(`+${d.added}`)} ${c.yellow(`~${d.changed}`)} ${c.red(`-${d.deleted}`)}${git}${who}${live}${undoable}  ${kind}${d.message ?? d.git?.subject ?? ""}\n`);
        }
      }
      return list;
    }),
  );

// ---------------- license ----------------

interface LicenseStatusLike {
  installed: boolean;
  valid: boolean;
  pro: boolean;
  reason?: string;
  license?: { email: string; issued: string; updatesUntil: string; seats: number; id: string };
  buildDate: string;
  buyUrl: string;
}

function printLicense(s: LicenseStatusLike) {
  if (s.pro && s.license) {
    process.stdout.write(`${c.green("✔ coolFTP Pro")} licensed to ${c.bold(s.license.email)}, updates until ${s.license.updatesUntil} (this build: ${s.buildDate})\n`);
  } else if (s.installed && s.valid) {
    process.stdout.write(`${c.yellow("! coolFTP Pro, updates ended")} ${s.reason}\n`);
  } else {
    process.stdout.write(`${c.dim("coolFTP Free")}  ${s.reason ?? ""}\n${c.dim(`Pro: ${s.buyUrl}`)}\n`);
  }
}

const license = program.command("license").description("show or manage the Pro license");

license
  .command("status", { isDefault: true })
  .description("show the license status")
  .action(() =>
    withRunner(async (r, g) => {
      const s = await r.run<LicenseStatusLike>("license", {});
      if (!g.json) printLicense(s);
      return s;
    }),
  );

license
  .command("activate <key>")
  .description("install a Pro license key on this machine")
  .action((key: string) =>
    withRunner(async (r, g) => {
      const s = await r.run<LicenseStatusLike>("activateLicense", { key });
      if (!g.json) printLicense(s);
      return s;
    }),
  );

license
  .command("remove")
  .description("remove the license from this machine")
  .action(() =>
    withRunner(async (r, g) => {
      const res = await r.run<{ removed: boolean; status: LicenseStatusLike }>("removeLicense", {});
      if (!g.json) process.stderr.write(res.removed ? c.green("✔ license removed\n") : c.dim("no license was installed\n"));
      return res;
    }),
  );

// ---------------- agent integration ----------------

program
  .command("mcp")
  .description("run as an MCP server over stdio (for Claude Code and other agents)")
  .action(async () => {
    const g = globals();
    const factory = runnerFactory({ agent: g.agent === "cli" ? "mcp-agent" : g.agent, direct: g.direct });
    await startMcpServer(factory, VERSION);
  });

program
  .command("agent-setup")
  .description("print the snippets that wire coolFTP into Claude Code and other agents")
  .action(() => {
    const bin = process.argv[1] ? path.resolve(process.argv[1]) : "coolftp";
    process.stdout.write(`${c.bold("Claude Code (MCP, recommended)")}
  claude mcp add coolftp -- node "${bin}" mcp
  # or per project, in .mcp.json:
  { "mcpServers": { "coolftp": { "command": "node", "args": ["${bin.replace(/\\/g, "\\\\")}", "mcp"] } } }

${c.bold("Any agent with a shell")}
  coolftp deploy -m "what changed"        # upload what changed; exit code 3 means uploaded but the live checks failed
  coolftp deploy --dry-run                 # preview only
  coolftp deploy --commit -m "msg"         # git commit, then deploy
  coolftp undo                             # put the previous versions back, no git needed
  coolftp verify                           # re-run the live checks without deploying
  coolftp diff --json                      # machine-readable plan

${c.bold("Tips")}
  · Run ${c.cyan("coolftp init <site>")} once per project so agents never need --site.
  · Keep the desktop app open: agent commands then show up live in its Agents panel.
  · Add a .coolftpignore next to .coolftp.json for files that must never go up.
`);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(c.red(`✖ ${(err as Error).message}\n`));
  process.exit(1);
});
