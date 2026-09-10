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
  /** Parallel connections opened for large transfers (FTP/FTPS only; SFTP multiplexes one). Default 4. */
  connections?: number;
}

export interface ProjectConfig {
  site: string;
  /** Overrides the site remoteRoot for this project. */
  remoteRoot?: string;
  /** Public URL this project's remote directory is served at. Overrides the site url for changed-file URLs and verification. */
  url?: string;
  /** Sub-directory of the project to deploy (e.g. "dist"). Defaults to project root. */
  localDir?: string;
  ignore?: string[];
  /** Command to run before deploy (e.g. "npm run build"). */
  build?: string;
  /** How many deploys keep their previous versions on the server for `coolftp undo`. Default 5, 0 disables. */
  keepBackups?: number;
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

export interface VerifyCheck {
  url: string;
  status: number;
  ok: boolean;
  ms: number;
  error?: string;
  /** For static files: whether the bytes the public URL serves match the local file. */
  content?: "match" | "stale";
}

export interface VerifyResult {
  /** Every checked URL answered with a success status. */
  ok: boolean;
  checks: VerifyCheck[];
  /** Files whose live copy differs from the local one. Usually a cache in front of the server. */
  stale: number;
  at: string;
}

/** Previous versions a deploy set aside on the server so it can be undone. */
export interface BackupInfo {
  /** Folder name under <remoteRoot>/.coolftp/backup. */
  id: string;
  /** Files the deploy overwrote, with their previous manifest entries. */
  changed: Record<string, ManifestFile>;
  /** Files the deploy removed, with their previous manifest entries. */
  deleted: Record<string, ManifestFile>;
  /** Files the deploy added; undo removes them. */
  added: string[];
  /** Set when the deploy added more files than are listed in `added`. */
  addedTruncated?: boolean;
  /** Size of the previous versions, from the manifest. */
  bytes: number;
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
  /** Set when this deploy reverted an earlier deploy from its backup. */
  undoOf?: string;
  added: number;
  changed: number;
  deleted: number;
  bytes: number;
  durationMs: number;
  files: string[];
  /** Remote directory the deploy wrote to. */
  remoteRoot?: string;
  /** Live checks run after the deploy (kept in the local history). */
  verify?: VerifyResult;
  /** Previous versions kept on the server for `coolftp undo`. */
  backup?: BackupInfo;
  /** Directories the deploy created on the server. */
  createdDirs?: string[];
  /** Connections used for the transfers. */
  connections?: number;
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

/** Whole-operation progress for deploys and folder transfers. */
export interface ProgressInfo {
  op: "deploy" | "upload" | "download";
  site: string;
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  /** Bytes per second over the last few seconds. */
  rate: number;
  etaMs: number;
  connections: number;
  done: boolean;
  /** Why the operation stopped early, when it did: a failure, or a cancel from the app. */
  error?: string;
}

export type ProgressFn = (transferred: number, total: number) => void;

export interface Transport {
  readonly protocol: Protocol;
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  list(dir: string): Promise<RemoteEntry[]>;
  stat(p: string): Promise<RemoteEntry | null>;
  /** Size of a remote file in bytes, or null when the server cannot say. */
  size(p: string): Promise<number | null>;
  /** Create a directory and any missing parents. Returns the directories it had to create. */
  mkdirp(dir: string): Promise<string[]>;
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
