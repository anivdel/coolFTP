import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ConnectionPool } from "./connections.js";
import { Events, silentEvents } from "./events.js";
import { configDir, formatBytes, rdirname, readJson, rjoin, shortId, writeJson, toPosix } from "./paths.js";
import { findProjectFile, resolveProject, writeProjectConfig } from "./project.js";
import { hashFile, scanLocal, walkLocalFiles } from "./scan.js";
import { getSite, loadSites, publicSite, removeSite, upsertSite, type PublicSite } from "./sites.js";
import { gitCommitAll, gitInfo, gitRevParse, gitWorktreeAdd, gitWorktreeRemove } from "./git.js";
import { forgetHostKey, listHostKeys } from "./knownhosts.js";
import type {
  BackupInfo,
  DeployRecord,
  DiffPlan,
  Manifest,
  ManifestFile,
  ProgressInfo,
  ProjectConfig,
  RemoteEntry,
  ResolvedProject,
  Site,
  Transport,
  TransferProgress,
  VerifyCheck,
  VerifyResult,
} from "./types.js";

export const MANIFEST_DIR = ".coolftp";
export const MANIFEST_FILE = "manifest.json";
export const BACKUP_DIR = "backup";
/** Deploys whose previous versions stay on the server for `coolftp undo`, unless .coolftp.json says otherwise. */
export const DEFAULT_KEEP_BACKUPS = 5;
/** Parallel FTP connections for transfers, unless the site says otherwise. */
export const DEFAULT_CONNECTIONS = 4;
/** Operations with at most this many files get every upload size-checked on the server afterwards. */
const VERIFY_SIZE_MAX_FILES = 50;
/** Extra connections are only worth opening for this many files or more. */
const PARALLEL_MIN_FILES = 8;
/** A changed file is uploaded under this suffix and swapped into place, so the live copy is never half-written. */
const TMP_SUFFIX = ".coolftp-tmp";
/** How many added files a backup record lists, so undo can remove them. */
const BACKUP_ADDED_MAX = 500;

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

export interface UndoOptions {
  site?: string;
  /** Deploy id to revert. Defaults to the most recent deploy on the server. */
  to?: string;
  message?: string;
  /** Report what would be restored and removed without touching the server. */
  dryRun?: boolean;
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
  /** Directories created on the server. */
  createdDirs: string[];
}

export interface UploadResult {
  files: number;
  bytes: number;
  remote: string;
  createdDirs: string[];
  /** Uploads whose size the server confirmed afterwards. */
  verified: number;
  /** Files recorded in the project's deploy manifest, so the next deploy skips them. */
  recorded: number;
}

/** Aggregates per-file transfer progress into one "N of M files, X of Y bytes, ETA" event stream. */
class Progress {
  private info: ProgressInfo;
  private inflight = new Map<string, number>();
  private doneBytes = 0;
  private samples: Array<[number, number]> = [];
  private lastEmit = 0;

  constructor(
    private events: Events,
    op: ProgressInfo["op"],
    site: string,
    totalFiles: number,
    totalBytes: number,
  ) {
    this.info = { op, site, files: 0, totalFiles, bytes: 0, totalBytes, rate: 0, etaMs: 0, connections: 1, done: false };
  }

  start(connections: number): void {
    this.info.connections = connections;
    this.emit(true);
  }

  update(id: string, transferred: number): void {
    this.inflight.set(id, transferred);
    this.emit(false);
  }

  complete(id: string, size: number): void {
    this.inflight.delete(id);
    this.doneBytes += size;
    this.info.files++;
    this.emit(false);
  }

  finish(): void {
    this.info.done = true;
    this.emit(true);
  }

  private emit(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 1000) return;
    this.lastEmit = now;
    let bytes = this.doneBytes;
    for (const v of this.inflight.values()) bytes += v;
    this.info.bytes = Math.min(bytes, Math.max(this.info.totalBytes, bytes));
    this.samples.push([now, bytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 10_000) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const dt = (now - t0) / 1000;
    this.info.rate = dt >= 0.5 ? Math.max(0, (bytes - b0) / dt) : 0;
    this.info.etaMs = this.info.rate > 0 ? Math.round(((this.info.totalBytes - bytes) / this.info.rate) * 1000) : 0;
    this.events.emit({ type: "progress", progress: { ...this.info } });
  }
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
    opts: { progress?: Progress; verifySize?: boolean; as?: string } = {},
  ): Promise<{ verified: boolean }> {
    // A changed file travels under a temporary name and is swapped in afterwards; report it by its real path.
    const tr: TransferProgress = { id: shortId(), direction, local, remote: opts.as ?? remote, size, transferred: 0, status: "queued" };
    events.emit({ type: "transfer", transfer: { ...tr } });
    tr.status = "active";
    tr.startedAt = Date.now();
    events.emit({ type: "transfer", transfer: { ...tr } });
    let lastEmit = 0;
    const onProgress = (done: number, total: number) => {
      tr.transferred = done;
      if (total) tr.size = total;
      opts.progress?.update(tr.id, done);
      const now = Date.now();
      if (now - lastEmit > 100) {
        lastEmit = now;
        events.emit({ type: "transfer", transfer: { ...tr } });
        this.pool.touchTransport(t);
      }
    };
    let verified = false;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          this.pool.touchTransport(t);
          if (direction === "upload") {
            await t.upload(local, remote, onProgress);
            if (opts.verifySize) {
              const want = fs.statSync(local).size;
              const got = await t.size(remote);
              if (got !== null && got !== want) throw new Error(`size check failed: the server has ${got} bytes, the local file has ${want}`);
              verified = got !== null;
            }
          } else await t.download(remote, local, onProgress);
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
    opts.progress?.complete(tr.id, tr.size);
    return { verified };
  }

  /**
   * Run fn over items with several connections. SFTP multiplexes one connection; FTP opens
   * extra logins for larger jobs. Returns the number of connections used.
   */
  private async withWorkers<T>(
    site: Site,
    primary: Transport,
    items: T[],
    events: Events,
    fn: (t: Transport, item: T) => Promise<void>,
  ): Promise<number> {
    const wanted = Math.max(1, Math.min(site.connections ?? DEFAULT_CONNECTIONS, items.length));
    const sftp = primary.protocol === "sftp";
    const extras = !sftp && wanted > 1 && items.length >= PARALLEL_MIN_FILES ? await this.pool.acquireExtras(site, wanted - 1, events) : [];
    const workers = sftp ? Array.from({ length: Math.min(4, Math.max(1, items.length)) }, () => primary) : [primary, ...extras];
    try {
      let i = 0;
      let firstError: unknown;
      await Promise.all(
        workers.map(async (t) => {
          while (i < items.length && !firstError) {
            const item = items[i++];
            try {
              await fn(t, item);
            } catch (e) {
              firstError = e;
            }
          }
        }),
      );
      if (firstError) throw firstError;
    } finally {
      await this.pool.releaseExtras(extras);
    }
    return extras.length + 1;
  }

  /** The project's resolved remote directory when cwd lies inside a project linked to this site. */
  private async projectRootFor(cwd: string | undefined, site: Site, t: Transport): Promise<string | undefined> {
    if (!cwd) return undefined;
    const file = findProjectFile(cwd);
    if (!file) return undefined;
    const cfg = readJson<ProjectConfig>(file, { site: "" });
    if (!cfg.site || cfg.site.toLowerCase() !== site.name.toLowerCase()) return undefined;
    return this.resolveRemote(site, t, cfg.remoteRoot || site.remoteRoot);
  }

  /** Upload a local file or directory to a remote path (directory contents go inside remotePath). */
  async upload(
    siteName: string,
    localPath: string,
    remotePath: string,
    events: Events = silentEvents(),
    opts: { cwd?: string } = {},
  ): Promise<UploadResult> {
    const site = getSite(siteName);
    const t = await this.pool.acquire(site, events);
    const remote = await this.resolveRemote(site, t, remotePath);
    const abs = path.resolve(localPath);
    if (!fs.existsSync(abs)) throw new Error(`Local path not found: ${abs}`);
    const st = fs.statSync(abs);
    const projectRoot = await this.projectRootFor(opts.cwd, site, t);
    const base = projectRoot ?? (await this.resolveRemote(site, t, site.remoteRoot));
    const createdDirs: string[] = [];
    const uploaded: Array<{ abs: string; remote: string }> = [];
    let files = 0;
    let bytes = 0;
    let verified = 0;
    if (st.isFile()) {
      const rst = await t.stat(remote);
      const target = rst?.type === "dir" ? rjoin(remote, path.basename(abs)) : remote;
      createdDirs.push(...(await t.mkdirp(rdirname(target))));
      const r = await this.transfer(t, "upload", abs, target, st.size, events, { verifySize: true });
      if (r.verified) verified++;
      uploaded.push({ abs, remote: target });
      files = 1;
      bytes = st.size;
    } else {
      const list = walkLocalFiles(abs);
      const dirs = new Set<string>();
      for (const f of list) dirs.add(rdirname(rjoin(remote, f.rel)));
      for (const d of [...dirs].sort((a, b) => a.length - b.length)) createdDirs.push(...(await t.mkdirp(d)));
      const progress = new Progress(events, "upload", site.name, list.length, list.reduce((n, f) => n + f.size, 0));
      const verifySize = list.length <= VERIFY_SIZE_MAX_FILES;
      let started = false;
      await this.withWorkers(site, t, list, events, async (w, f) => {
        if (!started) {
          started = true;
          progress.start(1);
        }
        const target = rjoin(remote, f.rel);
        const r = await this.transfer(w, "upload", f.abs, target, f.size, events, { progress, verifySize });
        if (r.verified) verified++;
        uploaded.push({ abs: f.abs, remote: target });
        files++;
        bytes += f.size;
      });
      progress.finish();
    }
    this.reportCreated(events, site.name, createdDirs, base, st.isFile());
    let recorded = 0;
    if (projectRoot) recorded = await this.recordInManifest(t, projectRoot, uploaded, events);
    this.pool.touch(site.name);
    events.log(
      `Uploaded ${files} file${files === 1 ? "" : "s"} (${formatBytes(bytes)}) to ${files === 1 && uploaded[0] ? uploaded[0].remote : remote}${verified === files && files ? ", size confirmed by the server" : ""}`,
      "success",
    );
    return { files, bytes, remote, createdDirs, verified, recorded };
  }

  /** Files pushed outside a deploy still belong in the manifest, or the next deploy uploads them again. */
  private async recordInManifest(t: Transport, projectRoot: string, uploaded: Array<{ abs: string; remote: string }>, events: Events): Promise<number> {
    const inside = uploaded.filter((u) => u.remote.startsWith(projectRoot.replace(/\/+$/, "") + "/"));
    if (!inside.length) return 0;
    const manifest = await this.readManifest(t, projectRoot).catch(() => null);
    if (!manifest) return 0;
    for (const u of inside) {
      const rel = u.remote.slice(projectRoot.replace(/\/+$/, "").length + 1);
      const st = fs.statSync(u.abs);
      manifest.files[rel] = { size: st.size, mtime: Math.floor(st.mtimeMs), hash: await hashFile(u.abs) };
    }
    manifest.updatedAt = new Date().toISOString();
    await this.writeManifest(t, projectRoot, manifest);
    events.log(`Recorded ${inside.length} file${inside.length === 1 ? "" : "s"} in the deploy manifest, so the next deploy will not send ${inside.length === 1 ? "it" : "them"} again.`);
    return inside.length;
  }

  /** Tell the caller which directories had to be created; a single file that opens a new top-level folder is usually a typo in the remote path. */
  private reportCreated(events: Events, site: string, createdDirs: string[], base: string, singleFile: boolean): void {
    const visible = createdDirs.filter((d) => !d.includes(`/${MANIFEST_DIR}/`) && !d.endsWith(`/${MANIFEST_DIR}`));
    if (!visible.length) return;
    const root = base.replace(/\/+$/, "");
    const topLevel = visible.filter((d) => rdirname(d) === root || (root === "" && rdirname(d) === "/"));
    events.emit({ type: "created", site, dirs: visible, topLevel });
    if (singleFile && topLevel.length) {
      const names = topLevel.map((d) => d.slice(root.length + 1) + "/").join(", ");
      events.log(`Created a new top-level folder ${names} under ${root || "/"}. If that was not intended, drop that prefix from the remote path.`, "warn");
    }
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
      const progress = new Progress(events, "download", site.name, all.length, all.reduce((n, e) => n + e.size, 0));
      let started = false;
      await this.withWorkers(site, t, all, events, async (w, e) => {
        if (!started) {
          started = true;
          progress.start(1);
        }
        const rel = e.path.slice(remote.length).replace(/^\//, "");
        await this.transfer(w, "download", path.join(local, rel), e.path, e.size, events, { progress });
        files++;
        bytes += e.size;
      });
      progress.finish();
    }
    this.pool.touch(site.name);
    events.log(`Downloaded ${files} file${files === 1 ? "" : "s"} (${formatBytes(bytes)}) to ${local}`, "success");
    return { files, bytes, local };
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
    const file = rjoin(remoteRoot, MANIFEST_DIR, MANIFEST_FILE);
    let buf: Buffer;
    try {
      buf = await t.readFile(file);
    } catch (err) {
      // Only a missing file means "no manifest yet". Anything else (the server dropped the
      // connection, a permission problem) must surface, or the plan silently degrades to
      // "upload everything" and a --delete could act on a partial picture of the server.
      if (isNotFound(err)) return null;
      throw new Error(`Could not read the deploy manifest at ${file}: ${(err as Error)?.message || String(err)}`);
    }
    try {
      const m = JSON.parse(buf.toString("utf8")) as Manifest;
      if (m && m.version === 1 && m.files) return m;
    } catch {
      /* unreadable JSON: treat as absent and rebuild it from a listing */
    }
    return null;
  }

  /** Written under a temporary name and swapped in, so a dropped connection never leaves a half manifest behind. */
  private async writeManifest(t: Transport, remoteRoot: string, manifest: Manifest): Promise<void> {
    const dir = rjoin(remoteRoot, MANIFEST_DIR);
    await t.mkdirp(dir);
    const ht = rjoin(dir, ".htaccess");
    if (!(await t.stat(ht))) {
      await t.writeFile(ht, "Require all denied\nDeny from all\n").catch(() => undefined);
    }
    const file = rjoin(dir, MANIFEST_FILE);
    const tmp = file + TMP_SUFFIX;
    await t.writeFile(tmp, JSON.stringify(manifest));
    await swapIn(t, tmp, file);
  }

  private async remoteListing(t: Transport, remoteRoot: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const walk = async (dir: string) => {
      let entries: RemoteEntry[];
      try {
        entries = await t.list(dir);
      } catch (err) {
        // A directory that is not there yet is an empty listing; a failed connection is not.
        if (isNotFound(err)) return;
        throw new Error(`Could not list ${dir}: ${(err as Error)?.message || String(err)}`);
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
    const { manifest: _m, ...rest } = await this.diffProject(resolveProject(cwd, opts.site), opts, events);
    return rest;
  }

  private async diffProject(project: ResolvedProject, opts: { force?: boolean }, events: Events): Promise<DiffResult & { manifest: Manifest | null }> {
    const site = getSite(project.config.site);

    // Scan before touching the server. Hashing a large project can outlast the server's idle
    // limit, and a control connection that sat idle through the scan came back dead.
    events.log(`Scanning ${project.localDir}`);
    let count = 0;
    const local = await scanLocal(project.localDir, [...(site.ignore || []), ...(project.config.ignore || [])], (rel) => {
      count++;
      if (count % 50 === 0) events.emit({ type: "scan", count, current: rel });
    });
    events.emit({ type: "scan", count, current: "" });

    const t = await this.pool.acquire(site, events);
    const remoteRoot = await this.resolveRemote(site, t, this.remoteRootFor(project, site));

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
    return { project, site: publicSite(site), remoteRoot, plan, local, manifest };
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

    const { plan, local, remoteRoot, manifest: scanned } = await this.diffProject(project, { force: opts.force }, events);
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
      return { dryRun: true, plan, remoteRoot, site: site.name, urls: this.publicUrls(site, project, remoteRoot, [...plan.add, ...plan.change]), createdDirs: [] };
    }

    const t = await this.pool.acquire(site, events);
    const uploads = [...plan.add, ...plan.change];
    const changeSet = new Set(plan.change);
    const id = shortId();
    const keep = Math.max(0, project.config.keepBackups ?? DEFAULT_KEEP_BACKUPS);
    const previous: Manifest = scanned ?? (await this.readManifest(t, remoteRoot)) ?? { version: 1, updatedAt: "", files: {}, deploys: [] };
    const prevFiles = previous.files;
    let backup: BackupInfo | undefined = keep > 0 && total > 0 ? { id, changed: {}, deleted: {}, added: [], bytes: 0 } : undefined;
    const backupBase = rjoin(remoteRoot, MANIFEST_DIR, BACKUP_DIR, id);
    const createdDirs: string[] = [];
    let connections = 1;

    if (total === 0) {
      events.log("Nothing to deploy. Remote is up to date.", "success");
    } else {
      events.log(`Deploying ${uploads.length} file${uploads.length === 1 ? "" : "s"} (${formatBytes(plan.bytes)}) to ${site.name}:${remoteRoot}`);
      const dirs = new Set<string>();
      for (const rel of uploads) dirs.add(rdirname(rjoin(remoteRoot, rel)));
      if (backup) {
        for (const rel of plan.change) dirs.add(rdirname(rjoin(backupBase, rel)));
        if (opts.delete) for (const rel of plan.delete) dirs.add(rdirname(rjoin(backupBase, rel)));
      }
      for (const d of [...dirs].sort((a, b) => a.length - b.length)) createdDirs.push(...(await t.mkdirp(d)));
      this.reportCreated(events, site.name, createdDirs, remoteRoot, false);

      const progress = new Progress(events, "deploy", site.name, uploads.length, plan.bytes);
      const verifySize = uploads.length <= VERIFY_SIZE_MAX_FILES;
      const done: string[] = [];
      let backupWarned = false;
      let started = false;
      try {
        connections = await this.withWorkers(site, t, uploads, events, async (w, rel) => {
          if (!started) {
            started = true;
            progress.start(1);
          }
          const live = rjoin(remoteRoot, rel);
          const localFile = path.join(project.localDir, rel);
          if (backup && changeSet.has(rel)) {
            // Upload beside the live file, move the live file into the backup, then swap the new one in.
            const tmp = live + TMP_SUFFIX;
            await this.transfer(w, "upload", localFile, tmp, local[rel].size, events, { progress, verifySize, as: live });
            try {
              await w.rename(live, rjoin(backupBase, rel));
              const prev = prevFiles[rel] ?? { size: 0, mtime: 0, hash: "" };
              backup.changed[rel] = prev;
              backup.bytes += prev.size;
            } catch (err) {
              if (!backupWarned) {
                backupWarned = true;
                events.log(`Could not set aside the previous ${rel}: ${(err as Error)?.message || String(err)}. Overwriting in place; undo will not cover such files.`, "warn");
              }
              await w.remove(live).catch(() => undefined);
            }
            await w.rename(tmp, live);
          } else {
            await this.transfer(w, "upload", localFile, live, local[rel].size, events, { progress, verifySize });
          }
          done.push(rel);
        });
      } catch (err) {
        // Save what did land so the next deploy picks up where this one stopped.
        if (done.length && t.isConnected()) {
          const partial = (await this.readManifest(t, remoteRoot).catch(() => null)) ?? { version: 1 as const, updatedAt: "", files: {}, deploys: [] };
          for (const rel of done) partial.files[rel] = local[rel];
          partial.updatedAt = new Date().toISOString();
          await this.writeManifest(t, remoteRoot, partial).catch(() => undefined);
          events.log(`Deploy stopped after ${done.length} of ${uploads.length} files. Progress saved; run deploy again to finish.`, "warn");
        }
        throw err;
      }
      progress.finish();
      if (opts.delete) {
        for (const rel of plan.delete) {
          const p = rjoin(remoteRoot, rel);
          if (backup) {
            try {
              await t.rename(p, rjoin(backupBase, rel));
              const prev = prevFiles[rel] ?? { size: 0, mtime: 0, hash: "" };
              backup.deleted[rel] = prev;
              backup.bytes += prev.size;
              events.log(`Deleted ${rel} (kept in the backup)`, "warn");
              continue;
            } catch {
              /* fall back to a plain delete */
            }
          }
          await t.remove(p).catch(() => undefined);
          events.log(`Deleted ${rel}`, "warn");
        }
      }
    }

    if (backup) {
      backup.added = plan.add.slice(0, BACKUP_ADDED_MAX);
      if (plan.add.length > BACKUP_ADDED_MAX) backup.addedTruncated = true;
      if (!Object.keys(backup.changed).length && !Object.keys(backup.deleted).length && !backup.added.length) backup = undefined;
    }

    const files: Record<string, ManifestFile> = { ...prevFiles };
    if (opts.delete) for (const rel of plan.delete) delete files[rel];
    for (const rel of Object.keys(local)) files[rel] = local[rel];

    const record: DeployRecord = {
      id,
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
      remoteRoot,
      backup,
      createdDirs: createdDirs.filter((d) => !d.includes(`/${MANIFEST_DIR}`)),
      connections,
    };
    const deploys = await this.pruneBackups(t, site.name, remoteRoot, previous.deploys, keep, backup ? [id] : []);
    await this.writeManifest(t, remoteRoot, { version: 1, updatedAt: record.at, files, deploys: [record, ...deploys].slice(0, 50) });
    this.pool.touch(site.name);
    events.log(
      `Deployed to ${site.name} in ${(record.durationMs / 1000).toFixed(1)}s: +${record.added} ~${record.changed} -${record.deleted}${record.git ? ` (${record.git.short} on ${record.git.branch}${record.git.dirty ? ", dirty" : ""})` : ""}${backup ? " · undo available" : ""}`,
      "success",
    );
    const urls = this.publicUrls(site, project, remoteRoot, uploads);
    const publicBase = project.config.url || site.url;
    const verify = publicBase && total > 0 ? await this.verifyUrls(publicBase, this.verifyTargets(site, project, remoteRoot, uploads), events) : undefined;
    if (verify) record.verify = verify;
    this.recordLocalHistory(site.name, record, historyRoot);
    events.emit({ type: "deploy", record });
    if (verify) events.emit({ type: "verify", site: site.name, verify });
    return { dryRun: false, plan, record, remoteRoot, site: site.name, urls, verify, createdDirs: record.createdDirs ?? [] };
  }

  /**
   * Keep the newest `keep` backups (including the ids in `fresh`), delete the rest from the
   * server, and strip their record of the backup pointer. Returns the updated records.
   */
  private async pruneBackups(t: Transport, siteName: string, remoteRoot: string, deploys: DeployRecord[], keep: number, fresh: string[]): Promise<DeployRecord[]> {
    const backupRoot = rjoin(remoteRoot, MANIFEST_DIR, BACKUP_DIR);
    const keepIds = new Set<string>(fresh);
    const out = deploys.map((d) => ({ ...d }));
    for (const d of out) {
      if (!d.backup) continue;
      if (keepIds.size < keep) keepIds.add(d.backup.id);
      else {
        await t.rmdir(rjoin(backupRoot, d.backup.id)).catch(() => undefined);
        delete d.backup;
        this.updateHistory(siteName, d.id, (r) => {
          const { backup: _b, ...rest } = r;
          return rest;
        });
      }
    }
    // Backups left behind by interrupted deploys or older undos.
    const entries = await t.list(backupRoot).catch(() => [] as RemoteEntry[]);
    for (const e of entries) if (e.type === "dir" && !keepIds.has(e.name)) await t.rmdir(e.path).catch(() => undefined);
    return out;
  }

  /**
   * Put back the previous versions a deploy set aside. Defaults to the most recent deploy on the
   * server; an older one can be undone as long as no later deploy touched the same files.
   */
  async undo(cwd: string, opts: UndoOptions = {}, events: Events = silentEvents()): Promise<DeployResult & { undoOf: string }> {
    const started = Date.now();
    const project = resolveProject(cwd, opts.site);
    const site = getSite(project.config.site);
    const t = await this.pool.acquire(site, events);
    const remoteRoot = await this.resolveRemote(site, t, this.remoteRootFor(project, site));
    const manifest = await this.readManifest(t, remoteRoot);
    if (!manifest) throw new Error(`No coolFTP manifest at ${site.name}:${remoteRoot}, so there is nothing to undo.`);
    const deploys = manifest.deploys;
    const index = opts.to ? deploys.findIndex((d) => d.id === opts.to) : 0;
    if (index < 0) throw new Error(`No deploy ${opts.to} in the server's history for ${remoteRoot}. See: coolftp history`);
    const target = deploys[index];
    if (!target) throw new Error("No deploys recorded on the server yet.");
    if (!target.backup) {
      const why = target.undoOf || target.rollbackOf ? "it changed nothing that was kept" : "its backup was pruned or backups are off for this project";
      throw new Error(`Deploy ${target.id}${target.message ? ` (${target.message})` : ""} cannot be undone: ${why}. Older deploys can be restored with coolftp rollback.`);
    }
    const b = target.backup;
    const touched = new Set([...Object.keys(b.changed), ...Object.keys(b.deleted), ...b.added]);
    for (const later of deploys.slice(0, index)) {
      if (later.files.length >= 500) throw new Error(`Deploy ${later.id} came after ${target.id} and touched too many files to check for conflicts. Undo the most recent deploy first.`);
      const conflict = later.files.map((f) => f.replace(/^-/, "")).find((f) => touched.has(f));
      if (conflict) throw new Error(`Cannot undo ${target.id}: a later deploy (${later.id}, ${later.at.slice(0, 16).replace("T", " ")}) changed ${conflict}. Undo that one first, or use coolftp rollback.`);
    }
    const changed = Object.keys(b.changed).sort();
    const deleted = Object.keys(b.deleted).sort();
    const added = [...b.added].sort();
    const plan: DiffPlan = { add: deleted, change: changed, delete: added, unchanged: 0, bytes: b.bytes, basis: "manifest" };
    const label = `${target.id}${target.message ? ` (${target.message})` : ""}`;
    if (opts.dryRun) {
      events.log(`Undo of ${label} would restore ${changed.length}, put back ${deleted.length} and remove ${added.length} file(s)${b.addedTruncated ? "; some added files are not listed and would stay" : ""}.`);
      return { dryRun: true, plan, remoteRoot, site: site.name, urls: this.publicUrls(site, project, remoteRoot, [...changed, ...deleted]), createdDirs: [], undoOf: target.id };
    }
    events.log(`Undoing ${label}: restore ${changed.length}, put back ${deleted.length}, remove ${added.length} file(s)`);

    const keep = Math.max(0, project.config.keepBackups ?? DEFAULT_KEEP_BACKUPS);
    const id = shortId();
    const backupBase = rjoin(remoteRoot, MANIFEST_DIR, BACKUP_DIR, b.id);
    const newBase = rjoin(remoteRoot, MANIFEST_DIR, BACKUP_DIR, id);
    const newBackup: BackupInfo = { id, changed: {}, deleted: {}, added: [], bytes: 0 };
    const files = { ...manifest.files };
    const dirs = new Set<string>();
    if (keep > 0) for (const rel of [...changed, ...added]) dirs.add(rdirname(rjoin(newBase, rel)));
    for (const rel of deleted) dirs.add(rdirname(rjoin(remoteRoot, rel)));
    for (const d of [...dirs].sort((a, c) => a.length - c.length)) await t.mkdirp(d);

    const restored: string[] = [];
    const removed: string[] = [];
    const putBack: string[] = [];
    // Set the current version aside (so the undo itself can be undone), then move the old one back.
    const setAside = async (rel: string, live: string, into: Record<string, ManifestFile>) => {
      if (keep > 0) {
        try {
          await t.rename(live, rjoin(newBase, rel));
          const cur = files[rel] ?? { size: 0, mtime: 0, hash: "" };
          into[rel] = cur;
          newBackup.bytes += cur.size;
          return;
        } catch {
          /* fall through to a plain delete */
        }
      }
      await t.remove(live).catch(() => undefined);
    };
    for (const rel of changed) {
      const live = rjoin(remoteRoot, rel);
      const aside = rjoin(backupBase, rel);
      await setAside(rel, live, newBackup.changed);
      try {
        await t.rename(aside, live);
      } catch (err) {
        events.log(`The backup copy of ${rel} is missing (${(err as Error)?.message || String(err)}); it stays as deployed.`, "warn");
        continue;
      }
      files[rel] = b.changed[rel];
      restored.push(rel);
      events.log(`Restored ${rel}`);
    }
    for (const rel of added) {
      await setAside(rel, rjoin(remoteRoot, rel), newBackup.deleted);
      delete files[rel];
      removed.push(rel);
      events.log(`Removed ${rel}`, "warn");
    }
    for (const rel of deleted) {
      try {
        await t.rename(rjoin(backupBase, rel), rjoin(remoteRoot, rel));
      } catch (err) {
        events.log(`The backup copy of ${rel} is missing (${(err as Error)?.message || String(err)}); it stays deleted.`, "warn");
        continue;
      }
      files[rel] = b.deleted[rel];
      putBack.push(rel);
      newBackup.added.push(rel);
      events.log(`Put back ${rel}`);
    }
    await t.rmdir(backupBase).catch(() => undefined);

    const hasBackup = keep > 0 && (Object.keys(newBackup.changed).length || Object.keys(newBackup.deleted).length || newBackup.added.length);
    const record: DeployRecord = {
      id,
      at: new Date().toISOString(),
      site: site.name,
      agent: events.meta.agent,
      message: opts.message ?? `undo ${target.id}${target.message ? `: ${target.message}` : ""}`,
      git: gitInfo(project.root),
      undoOf: target.id,
      added: putBack.length,
      changed: restored.length,
      deleted: removed.length,
      bytes: b.bytes,
      durationMs: Date.now() - started,
      files: [...restored, ...putBack, ...removed.map((r) => "-" + r)].slice(0, 500),
      remoteRoot,
      backup: hasBackup ? newBackup : undefined,
      connections: 1,
    };
    const rest = deploys.map((d) => (d.id === target.id ? { ...d, backup: undefined } : d));
    const pruned = await this.pruneBackups(t, site.name, remoteRoot, rest, keep, hasBackup ? [id] : []);
    await this.writeManifest(t, remoteRoot, { version: 1, updatedAt: record.at, files, deploys: [record, ...pruned].slice(0, 50) });
    this.pool.touch(site.name);
    events.log(`Undid ${label} in ${(record.durationMs / 1000).toFixed(1)}s: restored ${restored.length}, put back ${putBack.length}, removed ${removed.length}${hasBackup ? " · undo available (redo)" : ""}`, "success");
    const urls = this.publicUrls(site, project, remoteRoot, [...restored, ...putBack]);
    const publicBase = project.config.url || site.url;
    const verify = publicBase && restored.length + putBack.length + removed.length > 0 ? await this.verifyUrls(publicBase, this.verifyTargets(site, project, remoteRoot, [...restored, ...putBack]), events) : undefined;
    if (verify) record.verify = verify;
    this.recordLocalHistory(site.name, record, project.root);
    events.emit({ type: "deploy", record });
    if (verify) events.emit({ type: "verify", site: site.name, verify });
    return { dryRun: false, plan, record, remoteRoot, site: site.name, urls, verify, createdDirs: [], undoOf: target.id };
  }

  /**
   * Public URL of a deployed file. A project url in .coolftp.json says where this project's
   * remote directory is served; otherwise the site url covers the site root, and a project
   * deploying into a sub-directory of it gets that sub-path appended.
   */
  private publicUrlFor(site: Site, project: ResolvedProject, remoteRoot: string, rel: string): string | undefined {
    const configured = project.config.url || site.url;
    if (!configured) return undefined;
    if (rel.split("/").some((seg) => seg.startsWith("."))) return undefined;
    const base = configured.replace(/\/+$/, "");
    let prefix = "";
    if (!project.config.url && remoteRoot !== site.remoteRoot && remoteRoot.startsWith(site.remoteRoot.replace(/\/+$/, "") + "/")) {
      prefix = remoteRoot.slice(site.remoteRoot.replace(/\/+$/, "").length);
    }
    return `${base}${prefix}/${rel.replace(/(^|\/)index\.html$/, "$1")}`.replace(/\/+$/, "") || base;
  }

  private publicUrls(site: Site, project: ResolvedProject, remoteRoot: string, rels: string[]): string[] {
    const out: string[] = [];
    for (const rel of rels) {
      const u = this.publicUrlFor(site, project, remoteRoot, rel);
      if (u) out.push(u);
    }
    return out;
  }

  private verifyTargets(site: Site, project: ResolvedProject, remoteRoot: string, rels: string[]): VerifyTarget[] {
    const out: VerifyTarget[] = [];
    for (const rel of rels) {
      const url = this.publicUrlFor(site, project, remoteRoot, rel);
      if (!url) continue;
      const local = path.join(project.localDir, rel);
      out.push({ url, rel, local: fs.existsSync(local) ? local : undefined });
    }
    return out;
  }

  /**
   * GET the homepage and a few changed URLs so an agent can confirm the deploy is actually live.
   * Static files are also compared byte for byte with the local copy: a mismatch means something
   * between the server and the world (a CDN, a cache) is still serving the old version.
   */
  private async verifyUrls(publicBase: string, targets: VerifyTarget[], events: Events): Promise<VerifyResult> {
    const home = publicBase.replace(/\/+$/, "") + "/";
    const notHome = targets.filter((x) => x.url !== home && x.url + "/" !== home);
    const pages = notHome.filter((x) => isPage(x.url) && !isStaticAsset(x.url)).slice(0, 4);
    const assets = notHome.filter((x) => isStaticAsset(x.url)).slice(0, 4);
    const list: VerifyTarget[] = [{ url: home }, ...pages, ...assets];
    const checks: VerifyCheck[] = [];
    for (const target of list) {
      const started = Date.now();
      const compare = Boolean(target.local && isStaticAsset(target.url));
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(target.url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "coolftp-verify", "cache-control": "no-cache", pragma: "no-cache" } });
        const check: VerifyCheck = { url: target.url, status: res.status, ok: res.ok, ms: 0 };
        if (compare && res.ok) {
          const body = Buffer.from(await res.arrayBuffer());
          const live = crypto.createHash("sha256").update(body).digest("hex");
          check.content = live === (await hashFile(target.local!)) ? "match" : "stale";
        } else await res.body?.cancel().catch(() => undefined);
        clearTimeout(timer);
        check.ms = Date.now() - started;
        checks.push(check);
      } catch (err) {
        checks.push({ url: target.url, status: 0, ok: false, ms: Date.now() - started, error: (err as Error).message });
      }
    }
    for (const c of checks) {
      const content = c.content === "match" ? " · content matches" : c.content === "stale" ? " · STALE: the live bytes differ from the local file" : "";
      events.log(`${c.status || "ERR"} ${c.url} (${c.ms}ms)${c.error ? `: ${c.error}` : ""}${content}`, c.ok ? (c.content === "stale" ? "warn" : "success") : "error");
    }
    const ok = checks.every((c) => c.ok);
    const stale = checks.filter((c) => c.content === "stale").length;
    if (!ok) events.log("Verification failed: the site did not answer as expected after the deploy.", "error");
    else if (stale) events.log(`${stale} file${stale === 1 ? " is" : "s are"} still served from an old copy. The upload is complete; a cache or CDN in front of the server has not picked it up yet.`, "warn");
    return { ok, checks, stale, at: new Date().toISOString() };
  }

  /**
   * Re-run the live checks for a project without deploying: the homepage plus the given paths,
   * or the files of the last deploy when none are given.
   */
  async verify(cwd: string, opts: { site?: string; paths?: string[] } = {}, events: Events = silentEvents()): Promise<VerifyResult & { urls: string[] }> {
    const project = resolveProject(cwd, opts.site);
    const site = getSite(project.config.site);
    const remoteRoot = this.remoteRootFor(project, site);
    const publicBase = project.config.url || site.url;
    if (!publicBase) throw new Error(`No public URL for ${site.name}. Set one with "coolftp init ${site.name} --url https://example.com" or on the site.`);
    const last = this.history(site.name, 200).find((h) => h.project === toPosix(project.root));
    const rels = opts.paths?.length
      ? opts.paths.map((p) => toPosix(p).replace(/^\.?\//, ""))
      : (last?.files ?? []).filter((f) => !f.startsWith("-"));
    const targets = this.verifyTargets(site, project, remoteRoot, rels);
    events.log(`Checking ${publicBase}${targets.length ? ` and ${targets.length} file${targets.length === 1 ? "" : "s"}` : ""}`);
    const result = await this.verifyUrls(publicBase, targets, events);
    events.emit({ type: "verify", site: site.name, verify: result });
    if (!opts.paths?.length && last) this.updateHistory(site.name, last.id, (r) => ({ ...r, verify: result }));
    return { ...result, urls: targets.map((x) => x.url) };
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
    if (!gitInfo(project.root)) throw new Error("Rollback needs a git repository: deploys roll back to the commit that was live. To revert the last deploy without git, use coolftp undo.");
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
      if (!prev) throw new Error("No earlier deploy with a different commit in this project's history. Pass --to <commit> to roll back to a specific commit, or use coolftp undo to revert the last deploy.");
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

  private updateHistory(siteName: string, id: string, fn: (r: DeployRecord & { project?: string }) => DeployRecord & { project?: string }): void {
    const file = this.historyFile(siteName);
    const list = readJson<Array<DeployRecord & { project?: string }>>(file, []);
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return;
    list[i] = fn(list[i]);
    writeJson(file, list);
  }

  history(siteName: string, limit = 20): Array<DeployRecord & { project?: string }> {
    return readJson<Array<DeployRecord & { project?: string }>>(this.historyFile(siteName), []).slice(0, limit);
  }

  async close(): Promise<void> {
    await this.pool.closeAll();
  }
}

interface VerifyTarget {
  url: string;
  rel?: string;
  local?: string;
}

/** Server-side scripts and config files are not pages: a 403 or 405 there is usually the intended answer. */
function isPage(u: string): boolean {
  return !/\.(php|phtml|cgi|pl|py|rb|asp|aspx|jsp|env|ini|htaccess)$/i.test(u) && !/\/(api|cgi-bin|includes?|config)\//i.test(u);
}

/** Files a server hands out as they are, so the live bytes can be compared with the local file. */
function isStaticAsset(u: string): boolean {
  return /\.(js|mjs|css|map|json|txt|xml|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|wasm|pdf)$/i.test(u.split("?")[0]);
}

/** Rename tmp over file, removing an existing target first when the server refuses to overwrite. */
async function swapIn(t: Transport, tmp: string, file: string): Promise<void> {
  try {
    await t.rename(tmp, file);
  } catch {
    await t.remove(file).catch(() => undefined);
    await t.rename(tmp, file);
  }
}

/** FTP 550, SFTP status 2, or an ENOENT-style message: the path does not exist. */
function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string } | undefined;
  if (!e) return false;
  if (e.code === 550 || e.code === 2 || e.code === "ENOENT") return true;
  return /no such file|not found|does not exist|550/i.test(String(e.message || ""));
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
