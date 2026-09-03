export type Protocol = "sftp" | "ftp" | "ftps";

export interface Site {
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  /** Stored in plain text in sites.json. Prefer key auth for SFTP. */
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** Remote directory that a project deploys into, e.g. /public_html */
  remoteRoot: string;
  /** Default local project directory for this site (optional). */
  localRoot?: string;
  /** Extra gitignore-style patterns applied on deploy. */
  ignore?: string[];
  color?: string;
  /** Public URL that remoteRoot is served at, e.g. https://coolftp.com. Enables post-deploy verification. */
  url?: string;
}

export interface ProjectConfig {
  site: string;
  /** Overrides the site remoteRoot for this project. */
  remoteRoot?: string;
  /** Sub-directory of the project to deploy (e.g. "dist"). Defaults to project root. */
  localDir?: string;
  ignore?: string[];
  /** Command to run before deploy (e.g. "npm run build"). */
  build?: string;
}

export interface ResolvedProject {
  /** Directory containing .coolftp.json (or cwd when none). */
  root: string;
  /** Directory actually deployed. */
  localDir: string;
  configPath: string | null;
  config: ProjectConfig;
}

export type EntryType = "file" | "dir" | "link";

export interface RemoteEntry {
  name: string;
  path: string;
  type: EntryType;
  size: number;
  /** ms since epoch */
  mtime: number;
  mode?: number;
}

export interface LocalEntry {
  name: string;
  path: string;
  type: EntryType;
  size: number;
  mtime: number;
}

export interface ManifestFile {
  size: number;
  mtime: number;
  hash: string;
}

export interface DeployRecord {
  id: string;
  at: string;
  site: string;
  agent?: string;
  message?: string;
  git?: GitInfo;
  /** Set when this deploy restored the tree of an earlier commit. */
  rollbackOf?: string;
  added: number;
  changed: number;
  deleted: number;
  bytes: number;
  durationMs: number;
  files: string[];
}

export interface Manifest {
  version: 1;
  updatedAt: string;
  files: Record<string, ManifestFile>;
  deploys: DeployRecord[];
}

export interface GitInfo {
  commit: string;
  short: string;
  branch: string;
  subject: string;
  dirty: boolean;
}

export interface DiffPlan {
  add: string[];
  change: string[];
  delete: string[];
  unchanged: number;
  bytes: number;
  /** "manifest" when a remote manifest was used, "listing" when falling back to a remote walk, "fresh" when the remote is empty. */
  basis: "manifest" | "listing" | "fresh";
}

export interface TransferProgress {
  id: string;
  direction: "upload" | "download";
  local: string;
  remote: string;
  size: number;
  transferred: number;
  status: "queued" | "active" | "done" | "error";
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export type ProgressFn = (transferred: number, total: number) => void;

export interface Transport {
  readonly protocol: Protocol;
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  list(dir: string): Promise<RemoteEntry[]>;
  stat(p: string): Promise<RemoteEntry | null>;
  mkdirp(dir: string): Promise<void>;
  upload(local: string, remote: string, onProgress?: ProgressFn): Promise<void>;
  download(remote: string, local: string, onProgress?: ProgressFn): Promise<void>;
  readFile(remote: string): Promise<Buffer>;
  writeFile(remote: string, data: Buffer | string): Promise<void>;
  remove(remote: string): Promise<void>;
  rmdir(remote: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Resolve "~" or "." to an absolute remote path. */
  realpath(p: string): Promise<string>;
}
