import fs from "node:fs";
import path from "node:path";
import { Client as FtpClient, FileType } from "basic-ftp";
import type { ProgressFn, RemoteEntry, Site, Transport } from "./types.js";
import { rjoin } from "./paths.js";

/**
 * Plain FTP / FTPS transport. basic-ftp is strictly one-command-at-a-time,
 * so every public call is serialised through a promise chain.
 */
export class FtpTransport implements Transport {
  readonly protocol: "ftp" | "ftps";
  private client = new FtpClient(30000);
  private connected = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private site: Site) {
    this.protocol = site.protocol === "ftps" ? "ftps" : "ftp";
  }

  isConnected(): boolean {
    return this.connected && !this.client.closed;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.client.closed) this.client = new FtpClient(30000);
    if (process.env.COOLFTP_DEBUG) this.client.ftp.verbose = true;
    await this.client.access({
      host: this.site.host,
      port: this.site.port,
      user: this.site.username,
      password: this.site.password,
      secure: this.site.protocol === "ftps" ? true : false,
      secureOptions: this.site.protocol === "ftps" ? { rejectUnauthorized: false } : undefined,
    });
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.client.close();
  }

  realpath(p: string): Promise<string> {
    return this.run(async () => {
      if (p === "." || p === "~" || p === "") return this.client.pwd();
      return p;
    });
  }

  list(dir: string): Promise<RemoteEntry[]> {
    return this.run(async () => {
      const items = await this.client.list(dir);
      return items
        .filter((f) => f.name !== "." && f.name !== "..")
        .map((f) => ({
          name: f.name,
          path: rjoin(dir, f.name),
          type: f.type === FileType.Directory ? "dir" : f.type === FileType.SymbolicLink ? "link" : "file",
          size: f.type === FileType.Directory ? 0 : f.size,
          mtime: f.modifiedAt ? f.modifiedAt.getTime() : parseRawDate(f.rawModifiedAt),
        }));
    });
  }

  stat(p: string): Promise<RemoteEntry | null> {
    return this.run(async () => {
      const dir = path.posix.dirname(p);
      const name = path.posix.basename(p);
      try {
        const items = await this.client.list(dir);
        const f = items.find((x) => x.name === name);
        if (!f) return null;
        return {
          name,
          path: p,
          type: f.type === FileType.Directory ? "dir" : f.type === FileType.SymbolicLink ? "link" : "file",
          size: f.size,
          mtime: f.modifiedAt ? f.modifiedAt.getTime() : parseRawDate(f.rawModifiedAt),
        };
      } catch {
        return null;
      }
    });
  }

  mkdirp(dir: string): Promise<void> {
    return this.run(async () => {
      const cwd = await this.client.pwd();
      try {
        await this.client.ensureDir(dir);
      } finally {
        await this.client.cd(cwd);
      }
    });
  }

  upload(local: string, remote: string, onProgress?: ProgressFn): Promise<void> {
    return this.run(async () => {
      const total = fs.statSync(local).size;
      if (onProgress) this.client.trackProgress((info) => onProgress(info.bytes, total));
      try {
        await this.client.uploadFrom(local, remote);
        onProgress?.(total, total);
      } finally {
        this.client.trackProgress();
      }
    });
  }

  download(remote: string, local: string, onProgress?: ProgressFn): Promise<void> {
    return this.run(async () => {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      let total = 0;
      try {
        total = await this.client.size(remote);
      } catch {
        /* SIZE unsupported */
      }
      if (onProgress) this.client.trackProgress((info) => onProgress(info.bytes, total || info.bytes));
      try {
        await this.client.downloadTo(local, remote);
      } finally {
        this.client.trackProgress();
      }
    });
  }

  readFile(remote: string): Promise<Buffer> {
    return this.run(async () => {
      const chunks: Buffer[] = [];
      const { Writable } = await import("node:stream");
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await this.client.downloadTo(sink, remote);
      return Buffer.concat(chunks);
    });
  }

  writeFile(remote: string, data: Buffer | string): Promise<void> {
    return this.run(async () => {
      const { Readable } = await import("node:stream");
      await this.client.uploadFrom(Readable.from([Buffer.from(data)]), remote);
    });
  }

  remove(remote: string): Promise<void> {
    return this.run(async () => {
      await this.client.remove(remote);
    });
  }

  rmdir(remote: string): Promise<void> {
    return this.run(async () => {
      const cwd = await this.client.pwd();
      try {
        await this.client.removeDir(remote);
      } finally {
        await this.client.cd(cwd).catch(() => undefined);
      }
    });
  }

  rename(from: string, to: string): Promise<void> {
    return this.run(async () => {
      await this.client.rename(from, to);
    });
  }
}

/** Unix-style LIST dates omit the year for recent files ("Sep 3 03:11"); assume this year, or last year if that lands in the future. */
function parseRawDate(raw: string | undefined): number {
  if (!raw) return 0;
  const hasYear = /\b(19|20)\d{2}\b/.test(raw);
  if (hasYear) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? 0 : t;
  }
  const now = new Date();
  let t = Date.parse(`${raw} ${now.getFullYear()}`);
  if (Number.isNaN(t)) return 0;
  if (t > now.getTime() + 86_400_000) t = Date.parse(`${raw} ${now.getFullYear() - 1}`);
  return Number.isNaN(t) ? 0 : t;
}
