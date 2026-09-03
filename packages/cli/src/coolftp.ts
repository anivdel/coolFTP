import path from "node:path";
import { Command } from "commander";
import {
  configDir,
  formatBytes,
  findProjectFile,
  readJson,
  defaultPrivateKey,
  type CoolEvent,
  type EventMeta,
  type DeployResult,
  type DiffResult,
  type DiffPlan,
  type DeployRecord,
  type RemoteEntry,
  type Site,
  type ProjectConfig,
} from "@coolftp/core";
import { createRunner, detectAgent, readHubInfo, type Runner } from "./runner.js";
import { startMcpServer } from "./mcp.js";

declare const __VERSION__: string;

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
  .version(typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0")
  .option("--agent <name>", "name of the agent driving this command (shown in the desktop app)")
  .option("--json", "print machine-readable JSON to stdout", false)
  .option("--direct", "do not route through the running desktop app", false)
  .option("-q, --quiet", "suppress progress output", false);

function globals(): Globals {
  const o = program.opts();
  return { agent: detectAgent(o.agent), json: Boolean(o.json), direct: Boolean(o.direct), quiet: Boolean(o.quiet) };
}

const activeTransfers = new Map<string, { remote: string; size: number; transferred: number }>();

function printer(g: Globals) {
  const out = (s: string) => process.stderr.write(s + "\n");
  return (event: CoolEvent, _meta: EventMeta) => {
    if (g.quiet) return;
    switch (event.type) {
      case "log": {
        const tag =
          event.level === "error" ? c.red("✖") : event.level === "warn" ? c.yellow("!") : event.level === "success" ? c.green("✔") : c.dim("·");
        out(`${tag} ${event.message}`);
        break;
      }
      case "connect":
        if (event.status === "connecting") out(c.dim(`… connecting to ${event.site}`));
        if (event.status === "error") out(c.red(`✖ ${event.site}: ${event.error}`));
        break;
      case "transfer": {
        const t = event.transfer;
        if (t.status === "done") {
          activeTransfers.delete(t.id);
          out(`${t.direction === "upload" ? c.cyan("↑") : c.magenta("↓")} ${t.remote} ${c.dim(formatBytes(t.size))}`);
        } else if (t.status === "error") {
          activeTransfers.delete(t.id);
          out(c.red(`✖ ${t.remote}: ${t.error}`));
        } else if (t.status === "active") {
          activeTransfers.set(t.id, { remote: t.remote, size: t.size, transferred: t.transferred });
        }
        break;
      }
      case "scan":
        if (event.current) process.stderr.write(`\r${c.dim(`scanned ${event.count} files…`)}`);
        else if (event.count) out(`\r${c.dim(`scanned ${event.count} files`)}      `);
        break;
      default:
        break;
    }
  };
}

async function withRunner<T>(fn: (r: Runner, g: Globals) => Promise<T>): Promise<void> {
  const g = globals();
  const runner = await createRunner({ agent: g.agent, direct: g.direct });
  if (!g.quiet && !g.json && runner.mode === "hub") process.stderr.write(c.dim(`via coolFTP app (port ${runner.hubPort})\n`));
  try {
    const result = await fn(runner, g);
    if (g.json && result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
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
        remoteRoot: o.root,
        localRoot: o.local,
        color: o.color,
        url: o.url,
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
  .option("-d, --local-dir <dir>", "sub-directory to deploy, e.g. dist")
  .option("-b, --build <command>", "command to run before each deploy, e.g. \"npm run build\"")
  .option("-i, --ignore <patterns...>", "extra gitignore-style patterns")
  .action((siteName: string, o) =>
    withRunner(async (r, g) => {
      const config: ProjectConfig = { site: siteName };
      if (o.remoteRoot) config.remoteRoot = o.remoteRoot;
      if (o.localDir) config.localDir = o.localDir;
      if (o.build) config.build = o.build;
      if (o.ignore?.length) config.ignore = o.ignore;
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
      const info = { project: file, config: cfg, app: r.mode === "hub" ? { running: true, port: r.hubPort, pid: hub?.pid } : { running: false }, agent: g.agent };
      if (!g.json) {
        process.stdout.write(`${c.bold("project")}  ${file ?? c.dim("no .coolftp.json (run coolftp init <site>)")}\n`);
        if (cfg) process.stdout.write(`${c.bold("site")}     ${cfg.site}${cfg.remoteRoot ? ` → ${cfg.remoteRoot}` : ""}${cfg.localDir ? c.dim(`  (deploys ${cfg.localDir}/)`) : ""}\n`);
        process.stdout.write(`${c.bold("app")}      ${r.mode === "hub" ? c.green(`running on port ${r.hubPort}`) : c.dim("not running (commands run directly)")}\n`);
        process.stdout.write(`${c.bold("agent")}    ${g.agent}\n`);
        process.stdout.write(`${c.bold("config")}   ${configDir()}${r.mode === "hub" ? c.dim("  (sites come from the app while it is open)") : ""}\n`);
      }
      return { ...info, configDir: configDir() };
    }),
  );

// ---------------- browsing ----------------

program
  .command("ls [path]")
  .description("list a remote directory (relative to the site root)")
  .option("-s, --site <name>")
  .option("-l, --long", "show sizes and dates")
  .action((p: string | undefined, o) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, o.site);
      const res = await r.run<{ path: string; entries: RemoteEntry[] }>("ls", { site: s, path: p }, printer(g));
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
  .command("cat <path>")
  .description("print a remote file")
  .option("-s, --site <name>")
  .action((p: string, o) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, o.site);
      const res = await r.run<{ content: string; truncated: boolean }>("read", { site: s, path: p });
      if (!g.json) {
        process.stdout.write(res.content);
        if (res.truncated) process.stderr.write(c.yellow("\n! output truncated\n"));
      }
      return res;
    }),
  );

program
  .command("push <local> [remote]")
  .description("upload a file or directory (remote defaults to the site root)")
  .option("-s, --site <name>")
  .action((local: string, remote: string | undefined, o) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, o.site);
      return r.run("upload", { site: s, local: path.resolve(local), remote: remote ?? "" }, printer(g));
    }),
  );

program
  .command("pull <remote> [local]")
  .description("download a file or directory (local defaults to the current directory)")
  .option("-s, --site <name>")
  .action((remote: string, local: string | undefined, o) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, o.site);
      return r.run("download", { site: s, remote, local: path.resolve(local ?? ".") }, printer(g));
    }),
  );

program
  .command("rm <path>")
  .description("delete a remote file or directory")
  .option("-s, --site <name>")
  .action((p: string, o) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, o.site);
      return r.run("remove", { site: s, path: p }, printer(g));
    }),
  );

program
  .command("mkdir <path>")
  .description("create a remote directory")
  .option("-s, --site <name>")
  .action((p: string, o) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, o.site);
      return r.run("mkdir", { site: s, path: p }, printer(g));
    }),
  );

program
  .command("mv <from> <to>")
  .description("rename or move a remote path")
  .option("-s, --site <name>")
  .action((from: string, to: string, o) =>
    withRunner(async (r, g) => {
      const s = await resolveSite(r, o.site);
      return r.run("rename", { site: s, from, to }, printer(g));
    }),
  );

// ---------------- deploy ----------------

function printPlan(plan: DiffPlan, remoteRoot: string, siteName: string, showDelete: boolean) {
  const w = (s: string) => process.stdout.write(s + "\n");
  w(c.dim(`${siteName}:${remoteRoot}  (basis: ${plan.basis})`));
  for (const f of plan.add) w(`${c.green("+")} ${f}`);
  for (const f of plan.change) w(`${c.yellow("~")} ${f}`);
  for (const f of plan.delete) w(`${c.red("-")} ${f}${showDelete ? "" : c.dim("  (stale, kept unless --delete)")}`);
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

function printDeployExtras(res: DeployResult) {
  if (res.urls?.length && !res.dryRun) {
    const shown = res.urls.slice(0, 8);
    for (const u of shown) process.stdout.write(`${c.cyan("→")} ${u}\n`);
    if (res.urls.length > shown.length) process.stdout.write(c.dim(`  … and ${res.urls.length - shown.length} more\n`));
  }
  if (res.verify) {
    process.stdout.write(res.verify.ok ? c.green("✔ live: site answered on every check\n") : c.red("✖ verification failed, see checks above\n"));
  }
}

program
  .command("rollback")
  .description("put the server back to an earlier deploy (defaults to the previous commit that was live)")
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
          process.stdout.write(`${c.dim(when)}  ${c.green(`+${d.added}`)} ${c.yellow(`~${d.changed}`)} ${c.red(`-${d.deleted}`)}${git}${who}  ${d.message ?? d.git?.subject ?? ""}\n`);
        }
      }
      return list;
    }),
  );

// ---------------- agent integration ----------------

program
  .command("mcp")
  .description("run as an MCP server over stdio (for Claude Code and other agents)")
  .action(async () => {
    const g = globals();
    const runner = await createRunner({ agent: g.agent === "cli" ? "mcp-agent" : g.agent, direct: g.direct });
    await startMcpServer(runner, typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0");
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
  coolftp deploy -m "what changed"        # upload what changed
  coolftp deploy --dry-run                 # preview only
  coolftp deploy --commit -m "msg"         # git commit, then deploy
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
