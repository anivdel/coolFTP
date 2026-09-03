import fs from "node:fs";
import path from "node:path";
import { Client, type SFTPWrapper, type ConnectConfig } from "ssh2";
import type { ProgressFn, RemoteEntry, Site, Transport } from "./types.js";
import { defaultPrivateKey } from "./sites.js";
import { rjoin } from "./paths.js";

export class SftpTransport implements Transport {
  readonly protocol = "sftp" as const;
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;

  constructor(private site: Site) {}

  isConnected(): boolean {
    return this.sftp !== null;
  }

  private buildConfig(): ConnectConfig {
    const s = this.site;
    const cfg: ConnectConfig = {
      host: s.host,
      port: s.port,
      username: s.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
    };
    const keyPath = s.privateKeyPath || (!s.password ? defaultPrivateKey() : undefined);
    if (keyPath && fs.existsSync(keyPath)) {
      cfg.privateKey = fs.readFileSync(keyPath);
      if (s.passphrase) cfg.passphrase = s.passphrase;
    }
    if (s.password) cfg.password = s.password;
    const agent =
      process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);
    if (agent) cfg.agent = agent;
    if (!cfg.privateKey && !cfg.password && !cfg.agent) {
      throw new Error(`Site "${s.name}" has no password or private key configured.`);
    }
    return cfg;
  }

  connect(): Promise<void> {
    if (this.sftp) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const client = new Client();
      const cfg = this.buildConfig();
      client
        .on("ready", () => {
          client.sftp((err, sftp) => {
            if (err) {
              client.end();
              return reject(err);
            }
            this.client = client;
            this.sftp = sftp;
            resolve();
          });
        })
        .on("error", (err) => {
          if (!this.sftp) reject(err);
          else {
            this.sftp = null;
            this.client = null;
          }
        })
        .on("close", () => {
          this.sftp = null;
          this.client = null;
        })
        .connect(cfg);
    });
  }

  async close(): Promise<void> {
    this.client?.end();
    this.client = null;
    this.sftp = null;
  }

  private s(): SFTPWrapper {
    if (!this.sftp) throw new Error("Not connected");
    return this.sftp;
  }

  realpath(p: string): Promise<string> {
    return new Promise((resolve, reject) =>
      this.s().realpath(p, (err, abs) => (err ? reject(err) : resolve(abs))),
    );
  }

  list(dir: string): Promise<RemoteEntry[]> {
    return new Promise((resolve, reject) => {
      this.s().readdir(dir, (err, entries) => {
        if (err) return reject(err);
        resolve(
          entries.map((e) => {
            const attrs = e.attrs;
            const isDir = attrs.isDirectory();
            const isLink = attrs.isSymbolicLink();
            return {
              name: e.filename,
              path: rjoin(dir, e.filename),
              type: isDir ? "dir" : isLink ? "link" : "file",
              size: isDir ? 0 : attrs.size,
              mtime: (attrs.mtime || 0) * 1000,
              mode: attrs.mode,
            } as RemoteEntry;
          }),
        );
      });
    });
  }

  stat(p: string): Promise<RemoteEntry | null> {
    return new Promise((resolve, reject) => {
      this.s().stat(p, (err, attrs) => {
        if (err) {
          if ((err as NodeJS.ErrnoException & { code?: number }).code === 2) return resolve(null);
          return reject(err);
        }
        resolve({
          name: path.posix.basename(p),
          path: p,
          type: attrs.isDirectory() ? "dir" : attrs.isSymbolicLink() ? "link" : "file",
          size: attrs.size,
          mtime: (attrs.mtime || 0) * 1000,
          mode: attrs.mode,
        });
      });
    });
  }

  async mkdirp(dir: string): Promise<void> {
    const parts = dir.split("/").filter(Boolean);
    let cur = dir.startsWith("/") ? "/" : "";
    for (const part of parts) {
      cur = cur ? rjoin(cur, part) : part;
      const st = await this.stat(cur);
      if (st) continue;
      await new Promise<void>((resolve, reject) =>
        this.s().mkdir(cur, (err) => {
          // Race: another op may have created it.
          if (err && (err as { code?: number }).code !== 4) return reject(err);
          resolve();
        }),
      );
    }
  }

  upload(local: string, remote: string, onProgress?: ProgressFn): Promise<void> {
    return new Promise((resolve, reject) => {
      this.s().fastPut(
        local,
        remote,
        {
          concurrency: 16,
          chunkSize: 32768,
          step: (transferred, _chunk, total) => onProgress?.(transferred, total),
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  download(remote: string, local: string, onProgress?: ProgressFn): Promise<void> {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    return new Promise((resolve, reject) => {
      this.s().fastGet(
        remote,
        local,
        {
          concurrency: 16,
          chunkSize: 32768,
          step: (transferred, _chunk, total) => onProgress?.(transferred, total),
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  readFile(remote: string): Promise<Buffer> {
    return new Promise((resolve, reject) =>
      this.s().readFile(remote, (err, data) => (err ? reject(err) : resolve(data))),
    );
  }

  writeFile(remote: string, data: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) =>
      this.s().writeFile(remote, data, (err) => (err ? reject(err) : resolve())),
    );
  }

  remove(remote: string): Promise<void> {
    return new Promise((resolve, reject) => this.s().unlink(remote, (err) => (err ? reject(err) : resolve())));
  }

  async rmdir(remote: string): Promise<void> {
    const entries = await this.list(remote);
    for (const e of entries) {
      if (e.type === "dir") await this.rmdir(e.path);
      else await this.remove(e.path);
    }
    await new Promise<void>((resolve, reject) => this.s().rmdir(remote, (err) => (err ? reject(err) : resolve())));
  }

  rename(from: string, to: string): Promise<void> {
    return new Promise((resolve, reject) => this.s().rename(from, to, (err) => (err ? reject(err) : resolve())));
  }
}
