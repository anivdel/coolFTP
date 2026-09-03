import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ConnectionPool } from "./connections.js";
import { Events, silentEvents } from "./events.js";
import { configDir, formatBytes, rdirname, readJson, rjoin, shortId, writeJson, toPosix } from "./paths.js";
import { resolveProject, writeProjectConfig } from "./project.js";
import { scanLocal, walkLocalFiles } from "./scan.js";
import { getSite, loadSites, publicSite, removeSite, upsertSite, type PublicSite } from "./sites.js";
import { gitCommitAll, gitInfo, gitRevParse, gitWorktreeAdd, gitWorktreeRemove } from "./git.js";
import { forgetHostKey, listHostKeys } from "./knownhosts.js";
import type {
  DeployRecord,
  DiffPlan,
  Manifest,
  ManifestFile,
  ProjectConfig,
  RemoteEntry,
  ResolvedProject,
  Site,
  Transport,
  TransferProgress,
} from "./types.js";

export const MANIFEST_DIR = ".coolftp";
export const MANIFEST_FILE = "manifest.json";

export interface DeployOptions {
  site?: string;
  /** Delete remote files that no longer exist locally. */
  delete?: boolean;
  dryRun?: boolean;
  /** Re-upload everything, ignoring the manifest. */
  force?: boolean;
  message?: string;
  /** git add -A && git commit -m <message> before deploying. */
  commit?: boolean;
  /** Skip the configured build command. */
  skipBuild?: boolean;
  /** Allow --delete to remove remote files coolFTP never uploaded (first deploy into a non-empty folder). */
  deleteUntracked?: boolean;
  /** Internal: mark the deploy as a rollback to this commit. */
  rollbackOf?: string;
}

export interface VerifyCheck {
  url: string;
  status: number;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

export interface DiffResult {
  project: ResolvedProject;
  site: PublicSite;
  remoteRoot: string;
  plan: DiffPlan;
  local: Record<string, ManifestFile>;
}

export interface DeployResult {
  dryRun: boolean;
  plan: DiffPlan;
  record?: DeployRecord;
  remoteRoot: string;
  site: string;
  /** Public URLs of the files that changed, when the site has a url configured. */
  urls: string[];
  /** HTTP checks run after the deploy, when the site has a url configured. */
  verify?: VerifyResult;
}

/**
 * Every operation the CLI, the MCP server and the desktop app can perform.
 * Progress is reported through the Events instance passed to each call.
 */
export class CoolFtp {
  constructor(public pool = new ConnectionPool()) {}

  // ---------- sites ----------

  sites(): PublicSite[] {
    return loadSites().map(publicSite);
  }

  addSite(site: Site): PublicSite {
    return publicSite(upsertSite(site));
  }

  removeSite(name: string): boolean {
    return removeSite(name);
  }

  async test(siteName: string, events: Events = silentEvents()): Promise<{ ok: true; cwd: string; protocol: string; entries: number }> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const cwd = await t.realpath(site.remoteRoot.startsWith("~") ? "." : site.remoteRoot).catch(() => site.remoteRoot);
    const entries = await t.list(cwd);
    events.log(`Connected to ${site.host} via ${t.protocol}. ${cwd} has ${entries.length} entries.`, "success");
    return { ok: true, cwd, protocol: t.protocol, entries: entries.length };
  }

  // ---------- browsing ----------

  private async resolveRemote(site: Site, t: Transport, p?: string): Promise<string> {
    const base = site.remoteRoot;
    const target = !p ? base : p.startsWith("/") ? p : rjoin(base, p);
    if (target.startsWith("~")) {
      const home = await t.realpath(".");
      return rjoin(home, target.slice(1));
    }
    return target;
  }

  async ls(siteName: string, remotePath?: string, events: Events = silentEvents()): Promise<{ path: string; entries: RemoteEntry[] }> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const p = await this.resolveRemote(site, t, remotePath);
    const entries = await t.list(p);
    this.pool.touch(site.name);
    return { path: p, entries: entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)) };
  }

  async stat(siteName: string, remotePath: string): Promise<RemoteEntry | null> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site);
    return t.stat(await this.resolveRemote(site, t, remotePath));
  }

  async read(siteName: string, remotePath: string, maxBytes = 512 * 1024): Promise<{ path: string; content: string; truncated: boolean }> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site);
    const p = await this.resolveRemote(site, t, remotePath);
    const buf = await t.readFile(p);
    const truncated = buf.length > maxBytes;
    return { path: p, content: buf.subarray(0, maxBytes).toString("utf8"), truncated };
  }

  async write(siteName: string, remotePath: string, content: string, events: Events = silentEvents()): Promise<{ path: string; bytes: number }> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const p = await this.resolveRemote(site, t, remotePath);
    await t.mkdirp(rdirname(p));
    await t.writeFile(p, content);
    events.log(`Wrote ${p} (${formatBytes(Buffer.byteLength(content))})`, "success");
    return { path: p, bytes: Buffer.byteLength(content) };
  }

  async mkdir(siteName: string, remotePath: string, events: Events = silentEvents()): Promise<string> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const p = await this.resolveRemote(site, t, remotePath);
    await t.mkdirp(p);
    events.log(`Created ${p}`, "success");
    return p;
  }

  async remove(siteName: string, remotePath: string, events: Events = silentEvents()): Promise<string> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const p = await this.resolveRemote(site, t, remotePath);
    if (p === "/" || p === site.remoteRoot) throw new Error("Refusing to delete the site root.");
    const st = await t.stat(p);
    if (!st) throw new Error(`Not found: ${p}`);
    if (st.type === "dir") await t.rmdir(p);
    else await t.remove(p);
    events.log(`Deleted ${p}`, "success");
    return p;
  }

  async rename(siteName: string, from: string, to: string, events: Events = silentEvents()): Promise<{ from: string; to: string }> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const a = await this.resolveRemote(site, t, from);
    const b = await this.resolveRemote(site, t, to);
    await t.rename(a, b);
    events.log(`Renamed ${a} -> ${b}`, "success");
    return { from: a, to: b };
  }

  // ---------- transfers ----------

  private async transfer(
    t: Transport,
    direction: "upload" | "download",
    local: string,
    remote: string,
    size: number,
    events: Events,
  ): Promise<void> {
    const tr: TransferProgress = { id: shortId(), direction, local, remote, size, transferred: 0, status: "queued" };
    events.emit({ type: "transfer", transfer: { ...tr } });
    tr.status = "active";
    tr.startedAt = Date.now();
    events.emit({ type: "transfer", transfer: { ...tr } });
    let lastEmit = 0;
    const onProgress = (done: number, total: number) => {
      tr.transferred = done;
      if (total) tr.size = total;
      const now = Date.now();
      if (now - lastEmit > 100) {
        lastEmit = now;
        events.emit({ type: "transfer", transfer: { ...tr } });
      }
    };
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          if (direction === "upload") await t.upload(local, remote, onProgress);
          else await t.download(remote, local, onProgress);
          break;
        } catch (err) {
          if (attempt >= 3 || !t.isConnected()) throw err;
          events.log(`Retrying ${remote} (attempt ${attempt + 1}/3): ${(err as Error).message}`, "warn");
          await new Promise((r) => setTimeout(r, 400 * attempt));
          tr.transferred = 0;
        }
      }
      tr.transferred = tr.size;
      tr.status = "done";
    } catch (err) {
      tr.status = "error";
      tr.error = String((err as Error)?.message || err);
      events.emit({ type: "transfer", transfer: { ...tr } });
      throw err;
    }
    tr.endedAt = Date.now();
    events.emit({ type: "transfer", transfer: { ...tr } });
  }

  /** Upload a local file or directory to a remote path (directory contents go inside remotePath). */
  async upload(siteName: string, localPath: string, remotePath: string, events: Events = silentEvents()): Promise<{ files: number; bytes: number; remote: string }> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const remote = await this.resolveRemote(site, t, remotePath);
    const abs = path.resolve(localPath);
    if (!fs.existsSync(abs)) throw new Error(`Local path not found: ${abs}`);
    const st = fs.statSync(abs);
    let files = 0;
    let bytes = 0;
    if (st.isFile()) {
      const rst = await t.stat(remote);
      const target = rst?.type === "dir" ? rjoin(remote, path.basename(abs)) : remote;
      await t.mkdirp(rdirname(target));
      await this.transfer(t, "upload", abs, target, st.size, events);
      files = 1;
      bytes = st.size;
    } else {
      const list = walkLocalFiles(abs);
      const dirs = new Set<string>();
      for (const f of list) dirs.add(rdirname(rjoin(remote, f.rel)));
      for (const d of [...dirs].sort((a, b) => a.length - b.length)) await t.mkdirp(d);
      await this.runPool(t.protocol === "sftp" ? 4 : 1, list, async (f) => {
        await this.transfer(t, "upload", f.abs, rjoin(remote, f.rel), f.size, events);
        files++;
        bytes += f.size;
      });
    }
    this.pool.touch(site.name);
    events.log(`Uploaded ${files} file${files === 1 ? "" : "s"} (${formatBytes(bytes)}) to ${remote}`, "success");
    return { files, bytes, remote };
  }

  /** Download a remote file or directory into a local path. */
  async download(siteName: string, remotePath: string, localPath: string, events: Events = silentEvents()): Promise<{ files: number; bytes: number; local: string }> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const remote = await this.resolveRemote(site, t, remotePath);
    const st = await t.stat(remote);
    if (!st) throw new Error(`Remote path not found: ${remote}`);
    let local = path.resolve(localPath);
    let files = 0;
    let bytes = 0;
    if (st.type !== "dir") {
      if (fs.existsSync(local) && fs.statSync(local).isDirectory()) local = path.join(local, st.name);
      await this.transfer(t, "download", local, remote, st.size, events);
      files = 1;
      bytes = st.size;
    } else {
      const all: RemoteEntry[] = [];
      const walk = async (dir: string) => {
        for (const e of await t.list(dir)) {
          if (e.type === "dir") await walk(e.path);
          else if (e.type === "file") all.push(e);
        }
      };
      await walk(remote);
      await this.runPool(t.protocol === "sftp" ? 4 : 1, all, async (e) => {
        const rel = e.path.slice(remote.length).replace(/^\//, "");
        await this.transfer(t, "download", path.join(local, rel), e.path, e.size, events);
        files++;
        bytes += e.size;
      });
    }
    this.pool.touch(site.name);
    events.log(`Downloaded ${files} file${files === 1 ? "" : "s"} (${formatBytes(bytes)}) to ${local}`, "success");
    return { files, bytes, local };
  }

  private async runPool<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    let firstError: unknown;
    const worker = async () => {
      while (i < items.length && !firstError) {
        const item = items[i++];
        try {
          await fn(item);
        } catch (e) {
          firstError = e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    if (firstError) throw firstError;
  }

  // ---------- projects / deploy ----------

  init(dir: string, config: ProjectConfig): string {
    getSite(config.site);
    return writeProjectConfig(dir, config);
  }

  project(cwd: string, siteOverride?: string): ResolvedProject {
    return resolveProject(cwd, siteOverride);
  }

  private remoteRootFor(project: ResolvedProject, site: Site): string {
    return project.config.remoteRoot || site.remoteRoot;
  }

  private async readManifest(t: Transport, remoteRoot: string): Promise<Manifest | null> {
    try {
      const buf = await t.readFile(rjoin(remoteRoot, MANIFEST_DIR, MANIFEST_FILE));
      const m = JSON.parse(buf.toString("utf8")) as Manifest;
      if (m && m.version === 1 && m.files) return m;
      return null;
    } catch {
      return null;
    }
  }

  private async writeManifest(t: Transport, remoteRoot: string, manifest: Manifest): Promise<void> {
    const dir = rjoin(remoteRoot, MANIFEST_DIR);
    await t.mkdirp(dir);
    const ht = rjoin(dir, ".htaccess");
    if (!(await t.stat(ht))) {
      await t.writeFile(ht, "Require all denied\nDeny from all\n").catch(() => undefined);
    }
    await t.writeFile(rjoin(dir, MANIFEST_FILE), JSON.stringify(manifest));
  }

  private async remoteListing(t: Transport, remoteRoot: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const walk = async (dir: string) => {
      let entries: RemoteEntry[];
      try {
        entries = await t.list(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = e.path.slice(remoteRoot.length).replace(/^\//, "");
        if (rel === MANIFEST_DIR || rel.startsWith(MANIFEST_DIR + "/")) continue;
        if (e.type === "dir") await walk(e.path);
        else if (e.type === "file") out[rel] = e.size;
      }
    };
    await walk(remoteRoot);
    return out;
  }

  async diff(cwd: string, opts: { site?: string; force?: boolean } = {}, events: Events = silentEvents()): Promise<DiffResult> {
    return this.diffProject(resolveProject(cwd, opts.site), opts, events);
  }

  private async diffProject(project: ResolvedProject, opts: { force?: boolean }, events: Events): Promise<DiffResult> {
    const site = getSite(project.config.site);
    const t = await this.pool.acquire(site, events);
    const remoteRoot = await this.resolveRemote(site, t, this.remoteRootFor(project, site));

    events.log(`Scanning ${project.localDir}`);
    let count = 0;
    const local = await scanLocal(project.localDir, [...(site.ignore || []), ...(project.config.ignore || [])], (rel) => {
      count++;
      if (count % 50 === 0) events.emit({ type: "scan", count, current: rel });
    });
    events.emit({ type: "scan", count, current: "" });

    const plan: DiffPlan = { add: [], change: [], delete: [], unchanged: 0, bytes: 0, basis: "manifest" };
    const manifest = opts.force ? null : await this.readManifest(t, remoteRoot);

    if (manifest) {
      for (const [rel, f] of Object.entries(local)) {
        const r = manifest.files[rel];
        if (!r) plan.add.push(rel);
        else if (r.hash !== f.hash) plan.change.push(rel);
        else plan.unchanged++;
      }
      for (const rel of Object.keys(manifest.files)) if (!local[rel]) plan.delete.push(rel);
    } else {
      const listing = await this.remoteListing(t, remoteRoot);
      const empty = Object.keys(listing).length === 0;
      plan.basis = empty ? "fresh" : "listing";
      for (const [rel, f] of Object.entries(local)) {
        if (!(rel in listing)) plan.add.push(rel);
        else if (opts.force || listing[rel] !== f.size) plan.change.push(rel);
        else plan.unchanged++;
      }
      if (!empty) for (const rel of Object.keys(listing)) if (!local[rel]) plan.delete.push(rel);
    }
    for (const rel of [...plan.add, ...plan.change]) plan.bytes += local[rel].size;
    plan.add.sort();
    plan.change.sort();
    plan.delete.sort();
    events.emit({ type: "plan", site: site.name, plan });
    this.pool.touch(site.name);
    return { project, site: publicSite(site), remoteRoot, plan, local };
  }

  async deploy(cwd: string, opts: DeployOptions = {}, events: Events = silentEvents()): Promise<DeployResult> {
    return this.deployFrom(resolveProject(cwd, opts.site), opts, events);
  }

  private async deployFrom(project: ResolvedProject, opts: DeployOptions, events: Events, historyRoot = project.root): Promise<DeployResult> {
    const started = Date.now();
    const site = getSite(project.config.site);

    if (project.config.build && !opts.skipBuild) {
      events.log(`Running build: ${project.config.build}`);
      await runShell(project.config.build, project.root, (line) => events.log(line));
    }

    if (opts.commit) {
      const msg = opts.message || `Deploy to ${site.name}`;
      const hash = gitCommitAll(project.root, msg);
      events.log(hash ? `Committed ${hash.slice(0, 7)}: ${msg}` : "Nothing to commit", hash ? "success" : "info");
    }

    const { plan, local, remoteRoot } = await this.diffProject(project, { force: opts.force }, events);
    if (opts.delete && plan.delete.length && plan.basis !== "manifest" && !opts.deleteUntracked) {
      throw new Error(
        `Refusing --delete: the server has no coolFTP manifest yet, so ${plan.delete.length} remote file(s) there were never uploaded by coolFTP ` +
          `(${plan.delete.slice(0, 3).join(", ")}${plan.delete.length > 3 ? ", …" : ""}). ` +
          `Deploy once without --delete to establish the manifest, or pass --delete-untracked if those files really should go.`,
      );
    }
    const total = plan.add.length + plan.change.length + (opts.delete ? plan.delete.length : 0);
    if (opts.dryRun) {
      events.log(`Dry run: ${plan.add.length} to add, ${plan.change.length} to change, ${plan.delete.length} ${opts.delete ? "to delete" : "stale (use --delete)"}.`);
      return { dryRun: true, plan, remoteRoot, site: site.name, urls: this.publicUrls(site, remoteRoot, [...plan.add, ...plan.change]) };
    }

    const t = await this.pool.acquire(site, events);
    const uploads = [...plan.add, ...plan.change];
    if (total === 0) {
      events.log("Nothing to deploy. Remote is up to date.", "success");
    } else {
      events.log(`Deploying ${uploads.length} file${uploads.length === 1 ? "" : "s"} (${formatBytes(plan.bytes)}) to ${site.name}:${remoteRoot}`);
      const dirs = new Set<string>();
      for (const rel of uploads) dirs.add(rdirname(rjoin(remoteRoot, rel)));
      for (const d of [...dirs].sort((a, b) => a.length - b.length)) await t.mkdirp(d);
      const done: string[] = [];
      try {
        await this.runPool(t.protocol === "sftp" ? 4 : 1, uploads, async (rel) => {
          await this.transfer(t, "upload", path.join(project.localDir, rel), rjoin(remoteRoot, rel), local[rel].size, events);
          done.push(rel);
        });
      } catch (err) {
        // Save what did land so the next deploy picks up where this one stopped.
        if (done.length && t.isConnected()) {
          const partial = (await this.readManifest(t, remoteRoot)) ?? { version: 1 as const, updatedAt: "", files: {}, deploys: [] };
          for (const rel of done) partial.files[rel] = local[rel];
          partial.updatedAt = new Date().toISOString();
          await this.writeManifest(t, remoteRoot, partial).catch(() => undefined);
          events.log(`Deploy stopped after ${done.length} of ${uploads.length} files. Progress saved; run deploy again to finish.`, "warn");
        }
        throw err;
      }
      if (opts.delete) {
        for (const rel of plan.delete) {
          const p = rjoin(remoteRoot, rel);
          await t.remove(p).catch(() => undefined);
          events.log(`Deleted ${rel}`, "warn");
        }
      }
    }

    const previous = (await this.readManifest(t, remoteRoot)) ?? { version: 1 as const, updatedAt: "", files: {}, deploys: [] };
    const files: Record<string, ManifestFile> = { ...previous.files };
    if (opts.delete) for (const rel of plan.delete) delete files[rel];
    for (const rel of Object.keys(local)) files[rel] = local[rel];

    const record: DeployRecord = {
      id: shortId(),
      at: new Date().toISOString(),
      site: site.name,
      agent: events.meta.agent,
      message: opts.message,
      git: gitInfo(project.root),
      rollbackOf: opts.rollbackOf,
      added: plan.add.length,
      changed: plan.change.length,
      deleted: opts.delete ? plan.delete.length : 0,
      bytes: plan.bytes,
      durationMs: Date.now() - started,
      files: [...uploads, ...(opts.delete ? plan.delete.map((d) => "-" + d) : [])].slice(0, 500),
    };
    const manifest: Manifest = {
      version: 1,
      updatedAt: record.at,
      files,
      deploys: [record, ...previous.deploys].slice(0, 50),
    };
    await this.writeManifest(t, remoteRoot, manifest);
    this.recordLocalHistory(site.name, record, historyRoot);
    this.pool.touch(site.name);
    events.emit({ type: "deploy", record });
    events.log(
      `Deployed to ${site.name} in ${(record.durationMs / 1000).toFixed(1)}s: +${record.added} ~${record.changed} -${record.deleted}${record.git ? ` (${record.git.short} on ${record.git.branch}${record.git.dirty ? ", dirty" : ""})` : ""}`,
      "success",
    );
    const urls = this.publicUrls(site, remoteRoot, [...uploads, ...(opts.delete ? [] : [])]);
    const verify = site.url && total > 0 ? await this.verify(site, urls, events) : undefined;
    return { dryRun: false, plan, record, remoteRoot, site: site.name, urls, verify };
  }

  /** Public URLs for deployed files, when the site declares where remoteRoot is served. */
  private publicUrls(site: Site, remoteRoot: string, rels: string[]): string[] {
    if (!site.url) return [];
    const base = site.url.replace(/\/+$/, "");
    let prefix = "";
    if (remoteRoot !== site.remoteRoot && remoteRoot.startsWith(site.remoteRoot.replace(/\/+$/, "") + "/")) {
      prefix = remoteRoot.slice(site.remoteRoot.replace(/\/+$/, "").length);
    }
    return rels
      .filter((r) => !r.split("/").some((seg) => seg.startsWith(".")))
      .map((r) => `${base}${prefix}/${r.replace(/(^|\/)index\.html$/, "$1")}`.replace(/\/+$/, "") || base);
  }

  /** GET the homepage and a few changed URLs so an agent can confirm the deploy is actually live. */
  private async verify(site: Site, urls: string[], events: Events): Promise<VerifyResult> {
    const home = site.url!.replace(/\/+$/, "") + "/";
    const targets = [home, ...urls.filter((u) => u !== home && u + "/" !== home).slice(0, 4)];
    const checks: VerifyCheck[] = [];
    for (const url of targets) {
      const started = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "coolftp-verify", "cache-control": "no-cache" } });
        clearTimeout(timer);
        await res.body?.cancel().catch(() => undefined);
        checks.push({ url, status: res.status, ok: res.ok, ms: Date.now() - started });
      } catch (err) {
        checks.push({ url, status: 0, ok: false, ms: Date.now() - started, error: (err as Error).message });
      }
    }
    for (const c of checks) events.log(`${c.status || "ERR"} ${c.url} (${c.ms}ms)${c.error ? `: ${c.error}` : ""}`, c.ok ? "success" : "error");
    const ok = checks.every((c) => c.ok);
    if (!ok) events.log("Verification failed: the site did not answer as expected after the deploy.", "error");
    return { ok, checks };
  }

  /**
   * Put the server back to the tree of an earlier commit. Defaults to the most recent deploy
   * of this project whose commit differs from the one currently live.
   */
  async rollback(
    cwd: string,
    opts: { site?: string; to?: string; build?: boolean; message?: string } = {},
    events: Events = silentEvents(),
  ): Promise<DeployResult & { commit: string }> {
    const project = resolveProject(cwd, opts.site);
    const site = getSite(project.config.site);
    if (!gitInfo(project.root)) throw new Error("Rollback needs a git repository: deploys roll back to the commit that was live.");
    const hist = this.history(site.name, 200).filter((h) => h.project === toPosix(project.root) && h.git?.commit);
    let commit: string | undefined;
    let label: string | undefined;
    if (opts.to) {
      const byId = hist.find((h) => h.id === opts.to);
      commit = byId ? byId.git!.commit : gitRevParse(project.root, opts.to);
      label = byId ? `deploy ${byId.id} (${byId.git!.short})` : opts.to;
      if (!commit) throw new Error(`Cannot resolve "${opts.to}" to a commit or a deploy id. See: coolftp history`);
    } else {
      const live = hist[0]?.git?.commit;
      const prev = hist.find((h) => h.git!.commit !== live);
      if (!prev) throw new Error("No earlier deploy with a different commit in this project's history. Pass --to <commit> to roll back to a specific commit.");
      commit = prev.git!.commit;
      label = `${prev.git!.short} from ${prev.at.slice(0, 16).replace("T", " ")}${prev.message ? ` (${prev.message})` : ""}`;
    }
    if (project.config.build && !opts.build) {
      events.log(`This project has a build step. Rollback deploys the committed files of ${commit.slice(0, 7)} as they are; pass --build to run "${project.config.build}" in the checkout first.`, "warn");
    }
    events.log(`Rolling back ${site.name} to ${label}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coolftp-rollback-"));
    gitWorktreeAdd(project.root, tmp, commit);
    try {
      const snapshot: ResolvedProject = {
        root: tmp,
        localDir: path.join(tmp, path.relative(project.root, project.localDir)),
        configPath: null,
        config: project.config,
      };
      if (!fs.existsSync(snapshot.localDir)) throw new Error(`Commit ${commit.slice(0, 7)} has no "${project.config.localDir}" folder to deploy.`);
      const result = await this.deployFrom(
        snapshot,
        { delete: true, skipBuild: !opts.build, message: opts.message ?? `rollback to ${commit.slice(0, 7)}`, rollbackOf: commit },
        events,
        project.root,
      );
      return { ...result, commit };
    } finally {
      gitWorktreeRemove(project.root, tmp);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---------- host keys ----------

  hostKeys() {
    return listHostKeys();
  }

  /** Forget the recorded SSH host key so the next connection trusts whatever the server presents. */
  trustSite(siteName: string): { site: string; forgot: boolean } {
    const site = getSite(siteName);
    return { site: site.name, forgot: forgetHostKey(site.host, site.port) };
  }

  private historyFile(siteName: string): string {
    return path.join(configDir(), "history", `${siteName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.json`);
  }

  private recordLocalHistory(siteName: string, record: DeployRecord, projectRoot: string): void {
    const file = this.historyFile(siteName);
    const list = readJson<Array<DeployRecord & { project?: string }>>(file, []);
    list.unshift({ ...record, project: toPosix(projectRoot) });
    writeJson(file, list.slice(0, 200));
  }

  history(siteName: string, limit = 20): Array<DeployRecord & { project?: string }> {
    return readJson<Array<DeployRecord & { project?: string }>>(this.historyFile(siteName), []).slice(0, limit);
  }

  async close(): Promise<void> {
    await this.pool.closeAll();
  }
}

function runShell(cmd: string, cwd: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const feed = (chunk: Buffer) => chunk.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Build failed with exit code ${code}`))));
  });
}
