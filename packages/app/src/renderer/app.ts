/* coolFTP renderer. Vanilla TS, no framework. Talks to main via window.coolftp (see preload.ts). */

type EntryType = "file" | "dir" | "link";
interface Entry { name: string; path: string; type: EntryType; size: number; mtime: number }
interface Site {
  name: string; protocol: "sftp" | "ftp" | "ftps"; host: string; port: number; username: string;
  hasPassword: boolean; privateKeyPath?: string; remoteRoot: string; localRoot?: string; ignore?: string[]; color?: string; url?: string;
}
interface ConfirmRequest { op: string; agent: string; summary: string; detail: string }
interface VerifyResult { ok: boolean; stale?: number; at?: string; checks: Array<{ url: string; status: number; ok: boolean; ms: number; error?: string; content?: string }> }
interface ProgressInfo { op: string; site: string; files: number; totalFiles: number; bytes: number; totalBytes: number; rate: number; etaMs: number; connections: number; done: boolean; error?: string }
/** What one operation (an agent call, or a user action) did, gathered from its events. */
interface OpDetail { files: Array<{ remote: string; size: number; direction: string }>; created: string[]; topLevel: string[]; warnings: string[]; verify?: VerifyResult; record?: DeployRecord }
interface Transfer { id: string; direction: "upload" | "download"; local: string; remote: string; size: number; transferred: number; status: string; error?: string }
interface Plan { add: string[]; change: string[]; delete: string[]; unchanged: number; bytes: number; basis: string }
interface DeployRecord {
  id: string; at: string; site: string; agent?: string; message?: string; git?: { commit: string; short: string; branch: string; subject: string; dirty: boolean };
  rollbackOf?: string; undoOf?: string; added: number; changed: number; deleted: number; bytes: number; durationMs: number; project?: string; remoteRoot?: string; files?: string[];
  verify?: VerifyResult; backup?: { id: string; changed: Record<string, unknown>; deleted: Record<string, unknown>; added: string[]; bytes: number }; createdDirs?: string[]; connections?: number;
}
interface AgentCall { op: string; agent: string; method: string; summary: string; startedAt: number; endedAt?: number; ok?: boolean; error?: string; result?: string; dryRun?: boolean }
interface CoolEvent { type: string; [k: string]: any }
interface EventMeta { agent: string; op: string }

declare global {
  interface Window {
    coolftp: {
      rpc: (method: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;
      local: {
        list: (dir: string) => Promise<{ ok: boolean; path?: string; entries?: Entry[]; error?: string }>;
        home: () => Promise<string>; drives: () => Promise<string[]>; mkdir: (d: string) => Promise<boolean>;
        trash: (p: string) => Promise<boolean>; rename: (a: string, b: string) => Promise<boolean>;
        readText: (p: string) => Promise<{ content: string; truncated: boolean }>; projectFile: (d: string) => Promise<string | null>;
      };
      dialog: { pickFolder: () => Promise<string | null>; pickFiles: () => Promise<string[]>; pickKey: () => Promise<string | null> };
      shell: { open: (p: string) => Promise<string>; external: (u: string) => Promise<void>; showInFolder: (p: string) => Promise<void> };
      hubInfo: () => Promise<{ port: number | null; version: string; cliPath: string; configDir: string; calls: AgentCall[]; platform: string }>;
      version: () => Promise<string>;
      pathFor: (f: File) => string;
      onEvent: (cb: (p: { event: CoolEvent; meta: EventMeta }) => void) => () => void;
      onAgent: (cb: (p: AgentCall) => void) => () => void;
      onConfirm: (cb: (p: ConfirmRequest) => void) => () => void;
      onConfirmExpired: (cb: (p: { op: string }) => void) => () => void;
      replyConfirm: (op: string, ok: boolean) => void;
      control: (op: string, action: "pause" | "resume" | "cancel") => Promise<boolean>;
    };
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtDate = (ms: number) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "");
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const backupCount = (b: DeployRecord["backup"]) => (b ? Object.keys(b.changed).length + Object.keys(b.deleted).length + b.added.length : 0);
/** "restores 3 previous versions kept on the server and removes 2 added files" */
const describeUndo = (b: NonNullable<DeployRecord["backup"]>) => {
  const kept = Object.keys(b.changed).length + Object.keys(b.deleted).length;
  const parts: string[] = [];
  if (kept) parts.push(`restores ${kept} previous version${kept === 1 ? "" : "s"} kept on the server`);
  if (b.added.length) parts.push(`removes ${b.added.length} added file${b.added.length === 1 ? "" : "s"}`);
  return parts.join(" and ") || "available";
};
const verifyBadge = (v?: VerifyResult) => {
  if (!v) return "";
  const title = v.checks.map((k) => `${k.status || "ERR"} ${k.url}${k.content === "stale" ? " (stale)" : ""}${k.error ? ` ${k.error}` : ""}`).join("\n");
  const cls = v.ok ? (v.stale ? "stale" : "live") : "failed";
  const label = v.ok ? (v.stale ? `stale ×${v.stale}` : "live") : "failed";
  return `<span class="vbadge ${cls}" title="${esc(title)}">${label}</span>`;
};
const isWin = navigator.platform.startsWith("Win");
const sep = isWin ? "\\" : "/";
const rjoin = (a: string, b: string) => (a.endsWith("/") ? a + b : a + "/" + b);
const rparent = (p: string) => (p === "/" ? "/" : p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/");
const lparent = (p: string) => {
  const n = p.replace(/[\\/]+$/, "");
  const i = Math.max(n.lastIndexOf("\\"), n.lastIndexOf("/"));
  if (i < 0) return n;
  const parent = n.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent || "/";
};
const ljoin = (a: string, b: string) => (a.endsWith(sep) || a.endsWith("/") ? a + b : a + sep + b);

const state = {
  sites: [] as Site[],
  site: null as Site | null,
  connected: false,
  localPath: "",
  remotePath: "",
  localEntries: [] as Entry[],
  remoteEntries: [] as Entry[],
  selLocal: new Set<string>(),
  selRemote: new Set<string>(),
  transfers: new Map<string, Transfer & { agent: string }>(),
  log: [] as Array<{ t: number; level: string; message: string; agent: string }>,
  calls: [] as AgentCall[],
  history: [] as DeployRecord[],
  plan: null as Plan | null,
  planCtx: null as { cwd: string; site: string; remoteRoot: string } | null,
  hubPort: null as number | null,
  cliPath: "",
  configDir: "",
  tab: "transfers",
  editingSite: null as string | null,
  /** Whole-operation progress per op id: the cards at the top of the Transfers tab. */
  progress: new Map<string, ProgressInfo & { agent: string; at: number }>(),
  /** Per-op detail behind the Agents tab rows. */
  opDetail: new Map<string, OpDetail>(),
  openCalls: new Set<string>(),
  /** Speed samples per op, one per progress event, for the graph on its card. */
  speed: new Map<string, number[]>(),
  paused: new Set<string>(),
  cancelling: new Set<string>(),
};

function opDetail(op: string): OpDetail {
  let d = state.opDetail.get(op);
  if (!d) {
    d = { files: [], created: [], topLevel: [], warnings: [] };
    state.opDetail.set(op, d);
    if (state.opDetail.size > 200) state.opDetail.delete(state.opDetail.keys().next().value as string);
  }
  return d;
}

// ---------------- helpers ----------------

function toast(message: string, kind: "info" | "error" | "success" | "agent" = "info", ms = 3500) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function rpc<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await window.coolftp.rpc(method, args);
  if (!r.ok) throw new Error(r.error || "failed");
  return r.result as T;
}

function guard<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => {
    toast((e as Error).message, "error");
    return undefined;
  });
}

function prompt(title: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = $("promptModal");
    const input = $<HTMLInputElement>("promptInput");
    $("promptTitle").textContent = title;
    input.value = value;
    modal.classList.remove("hidden");
    input.focus();
    input.select();
    const done = (v: string | null) => {
      modal.classList.add("hidden");
      $("promptForm").onsubmit = null;
      $("promptCancel").onclick = null;
      resolve(v);
    };
    $("promptForm").onsubmit = (e) => {
      e.preventDefault();
      done(input.value.trim() || null);
    };
    $("promptCancel").onclick = () => done(null);
  });
}

function confirmDialog(title: string): Promise<boolean> {
  return prompt(`${title}  (type YES)`, "").then((v) => v === "YES");
}

function icon(e: Entry): string {
  if (e.type === "dir") return "📁";
  if (e.type === "link") return "🔗";
  const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
  if (["html", "htm"].includes(ext)) return "🌐";
  if (["js", "ts", "mjs", "cjs", "jsx", "tsx"].includes(ext)) return "🟨";
  if (["css", "scss", "less"].includes(ext)) return "🎨";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return "🖼";
  if (["json", "yml", "yaml", "toml", "xml"].includes(ext)) return "🧾";
  if (["md", "txt"].includes(ext)) return "📝";
  if (["php", "py", "rb", "go", "rs"].includes(ext)) return "⚙";
  if (["zip", "gz", "tar", "7z", "rar"].includes(ext)) return "📦";
  return "📄";
}

// ---------------- sites ----------------

async function loadSites(selectName?: string) {
  state.sites = await rpc<Site[]>("sites");
  const sel = $<HTMLSelectElement>("siteSelect");
  sel.innerHTML = state.sites.length
    ? state.sites.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}  ·  ${esc(s.protocol)}://${esc(s.host)}</option>`).join("")
    : `<option value="">no sites yet, click Sites to add one</option>`;
  const want = selectName ?? state.site?.name ?? localStorage.getItem("lastSite") ?? state.sites[0]?.name;
  if (want && state.sites.some((s) => s.name === want)) sel.value = want;
  state.site = state.sites.find((s) => s.name === sel.value) ?? null;
  $<HTMLSelectElement>("deploySite").innerHTML = state.sites.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("");
}

async function connect() {
  const name = $<HTMLSelectElement>("siteSelect").value;
  if (!name) return openSites();
  state.site = state.sites.find((s) => s.name === name) ?? null;
  if (!state.site) return;
  localStorage.setItem("lastSite", name);
  $("remoteStatus").textContent = "connecting…";
  $("connectBtn").setAttribute("disabled", "true");
  try {
    const r = await rpc<{ path: string; entries: Entry[] }>("ls", { site: name });
    state.connected = true;
    state.remotePath = r.path;
    state.remoteEntries = r.entries;
    state.selRemote.clear();
    renderRemote();
    $("remoteStatus").textContent = `${r.entries.length} items`;
    if (state.site.localRoot && !state.localPath.startsWith(state.site.localRoot)) await loadLocal(state.site.localRoot);
    loadHistory();
    toast(`Connected to ${name}`, "success", 1800);
  } catch (e) {
    state.connected = false;
    $("remoteStatus").textContent = "";
    toast((e as Error).message, "error", 6000);
  } finally {
    $("connectBtn").removeAttribute("disabled");
  }
}

// ---------------- local pane ----------------

async function loadLocal(dir: string) {
  const r = await window.coolftp.local.list(dir);
  if (!r.ok) return toast(r.error || "cannot open folder", "error");
  state.localPath = r.path!;
  state.localEntries = r.entries!;
  state.selLocal.clear();
  localStorage.setItem("lastLocal", state.localPath);
  renderLocal();
  const drive = $<HTMLSelectElement>("driveSelect");
  const d = state.localPath.slice(0, 3);
  if (Array.from(drive.options).some((o) => o.value === d)) drive.value = d;
}

function renderList(el: HTMLElement, entries: Entry[], selected: Set<string>, onOpen: (e: Entry) => void) {
  if (!entries.length) {
    el.innerHTML = `<div class="empty muted">empty</div>`;
    return;
  }
  el.innerHTML = entries
    .map(
      (e) => `<div class="file ${e.type} ${selected.has(e.path) ? "selected" : ""}" data-path="${esc(e.path)}">
        <span class="name"><span class="ico">${icon(e)}</span><span class="txt">${esc(e.name)}</span></span>
        <span class="size">${e.type === "dir" ? "" : fmtBytes(e.size)}</span>
        <span class="date">${fmtDate(e.mtime)}</span></div>`,
    )
    .join("");
  el.querySelectorAll<HTMLElement>(".file").forEach((row) => {
    const entry = entries.find((x) => x.path === row.dataset.path)!;
    row.onclick = (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        selected.has(entry.path) ? selected.delete(entry.path) : selected.add(entry.path);
      } else if (ev.shiftKey && selected.size) {
        const last = [...selected].pop()!;
        const a = Math.max(0, entries.findIndex((x) => x.path === last));
        const b = entries.indexOf(entry);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(entries[i].path);
      } else {
        selected.clear();
        selected.add(entry.path);
      }
      syncSelection(el, selected);
    };
    row.ondblclick = () => onOpen(entry);
  });
}

/** Reflect the selection set in the rows, then say how much is selected in the pane's status line. */
function syncSelection(el: HTMLElement, selected: Set<string>) {
  el.querySelectorAll<HTMLElement>(".file").forEach((r) => r.classList.toggle("selected", selected.has(r.dataset.path!)));
  noteSelection(el);
}

/** "3 files (1.2 MB) + 1 folder selected · 128 items", so a big selection can be checked before Upload. */
function noteSelection(el: HTMLElement) {
  const local = el.id === "localList";
  const selected = local ? state.selLocal : state.selRemote;
  const entries = local ? state.localEntries : state.remoteEntries;
  const status = $(local ? "localStatus" : "remoteStatus");
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  for (const e of entries) {
    if (!selected.has(e.path)) continue;
    if (e.type === "dir") dirs++;
    else {
      files++;
      bytes += e.size;
    }
  }
  const parts: string[] = [];
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"} (${fmtBytes(bytes)})`);
  if (dirs) parts.push(`${dirs} folder${dirs === 1 ? "" : "s"}`);
  status.textContent = parts.length ? `${parts.join(" + ")} selected · ${entries.length} items` : `${entries.length} items`;
}

function selectAll(el: HTMLElement, selected: Set<string>, entries: Entry[]) {
  for (const e of entries) selected.add(e.path);
  syncSelection(el, selected);
}

function renderLocal() {
  $<HTMLInputElement>("localPath").value = state.localPath;
  renderList($("localList"), state.localEntries, state.selLocal, (e) => {
    if (e.type === "dir") loadLocal(e.path);
    else window.coolftp.shell.open(e.path);
  });
  $("localStatus").textContent = `${state.localEntries.length} items`;
}

// ---------------- remote pane ----------------

async function loadRemote(p: string) {
  if (!state.site) return;
  $("remoteStatus").textContent = "loading…";
  try {
    const r = await rpc<{ path: string; entries: Entry[] }>("ls", { site: state.site.name, path: p });
    state.remotePath = r.path;
    state.remoteEntries = r.entries;
    state.selRemote.clear();
    renderRemote();
    $("remoteStatus").textContent = `${r.entries.length} items`;
  } catch (e) {
    $("remoteStatus").textContent = "";
    toast((e as Error).message, "error");
  }
}

function renderRemote() {
  $<HTMLInputElement>("remotePath").value = state.remotePath;
  renderList($("remoteList"), state.remoteEntries, state.selRemote, (e) => {
    if (e.type === "dir" || e.type === "link") loadRemote(e.path);
    else viewRemote(e);
  });
}

async function viewRemote(e: Entry) {
  if (e.size > 2 * 1024 * 1024) return toast("File too large to preview. Download it instead.", "error");
  const r = await guard(rpc<{ content: string; truncated: boolean }>("read", { site: state.site!.name, path: e.path }));
  if (!r) return;
  $("viewerTitle").textContent = e.path + (r.truncated ? " (truncated)" : "");
  $("viewerBody").textContent = r.content;
  $("viewerModal").classList.remove("hidden");
}

// ---------------- list gestures: rubber-band selection, and dragging rows to the other pane ----------------

/** How a list hands rows to the other pane when they are dragged there. */
interface Mover {
  other: HTMLElement;
  verb: "Upload" | "Download";
  entries: () => Entry[];
  /** Where a drop lands: a hovered folder row of the other list, else that pane's directory; null when it cannot take a drop now. */
  dir: (row: HTMLElement | null) => string | null;
  run: (paths: string[], dir: string) => Promise<unknown>;
}

/** The label that follows a dragged selection. One is enough: only one drag happens at a time. */
const ghost = document.createElement("div");
ghost.className = "drag-ghost";
ghost.innerHTML = `<span class="dg-items"></span><span class="dg-hint"></span>`;

/**
 * Two gestures share a press in a list, told apart by where the press starts:
 * - On a row's icon or name, with no modifier: the selection (or that row, selected on the spot) is dragged.
 *   Dropped on the other pane it is uploaded or downloaded; dropped on a folder row there it lands inside
 *   that folder. Escape cancels.
 * - Anywhere else (the blank part of a row, the size and date columns, empty space), or anywhere with Ctrl
 *   or Shift held: a box follows the pointer and every row it touches is selected, the way Explorer and
 *   FileZilla do it. A plain drag replaces the selection, Ctrl toggles the rows in the box against it,
 *   Shift adds them. The list scrolls when the pointer goes past its top or bottom edge.
 * A press that moves less than a few pixels is still a click, handled by the row itself.
 */
function listGestures(el: HTMLElement, selected: Set<string>, mover: Mover) {
  const THRESHOLD = 4;
  interface Row { el: HTMLElement; path: string; top: number; bottom: number }
  interface Drag {
    kind: "box" | "move";
    id: number; px: number; py: number; ax: number; ay: number; cx: number; cy: number;
    mode: "replace" | "add" | "toggle"; onRow: boolean; active: boolean; cancelled: boolean; base: Set<string>;
    rows: Row[]; left: number; right: number; lo: number; hi: number; raf: number;
    paths: string[]; over: HTMLElement | null; target: string | null;
  }
  let drag: Drag | null = null;
  let swallowClick = false;
  const box = document.createElement("div");
  box.className = "marquee";

  /** Row geometry in the list's content coordinates, which do not move when the list scrolls. */
  const measure = () => {
    const rows: Row[] = Array.from(el.querySelectorAll<HTMLElement>(".file")).map((r) => ({ el: r, path: r.dataset.path!, top: r.offsetTop, bottom: r.offsetTop + r.offsetHeight }));
    const first = rows[0]?.el;
    return { rows, left: first?.offsetLeft ?? 0, right: first ? first.offsetLeft + first.offsetWidth : 0 };
  };

  /** Rows are stacked, so the ones overlapping a y range are always one run [lo, hi]; hi < lo means none. */
  const hitRange = (rows: Row[], y1: number, y2: number): [number, number] => {
    let a = 0;
    let b = rows.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (rows[m].bottom > y1) b = m;
      else a = m + 1;
    }
    const lo = a;
    b = rows.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (rows[m].top < y2) a = m + 1;
      else b = m;
    }
    return [lo, a - 1];
  };

  const apply = (d: Drag, row: Row, hit: boolean) => {
    const on = d.mode === "toggle" ? d.base.has(row.path) !== hit : d.base.has(row.path) || hit;
    if (on) selected.add(row.path);
    else selected.delete(row.path);
    row.el.classList.toggle("selected", on);
  };

  const boxUpdate = () => {
    const d = drag;
    if (!d?.active) return;
    if (!d.rows[0]?.el.isConnected) {
      // The list was re-rendered under the drag (a refresh, a finished deploy): start over from the base.
      Object.assign(d, measure());
      for (const r of d.rows) apply(d, r, false);
      d.lo = 0;
      d.hi = -1;
    }
    const rect = el.getBoundingClientRect();
    // Clamp to the content so the box never grows the scroll area (its border alone is 2px tall).
    const x = Math.max(0, Math.min(el.scrollWidth - 2, d.cx - rect.left - el.clientLeft + el.scrollLeft));
    const y = Math.max(0, Math.min(el.scrollHeight - 2, d.cy - rect.top - el.clientTop + el.scrollTop));
    const x1 = Math.min(d.ax, x);
    const x2 = Math.max(d.ax, x);
    const y1 = Math.min(d.ay, y);
    const y2 = Math.max(d.ay, y);
    if (!box.isConnected) el.appendChild(box);
    box.style.left = `${x1}px`;
    box.style.top = `${y1}px`;
    box.style.width = `${x2 - x1}px`;
    box.style.height = `${y2 - y1}px`;
    let [lo, hi]: [number, number] = x2 > d.left && x1 < d.right ? hitRange(d.rows, y1, y2) : [0, -1];
    if (hi < lo) [lo, hi] = [0, -1];
    // Only rows that entered or left the box change.
    for (let i = d.lo; i <= d.hi; i++) if (i < lo || i > hi) apply(d, d.rows[i], false);
    for (let i = lo; i <= hi; i++) if (i < d.lo || i > d.hi) apply(d, d.rows[i], true);
    d.lo = lo;
    d.hi = hi;
  };

  /** Move the label with the pointer and work out where a drop would land. */
  const moveUpdate = () => {
    const d = drag;
    if (!d?.active) return;
    ghost.style.left = `${d.cx + 14}px`;
    ghost.style.top = `${d.cy + 12}px`;
    const other = mover.other;
    const r = other.getBoundingClientRect();
    const inside = d.cx >= r.left && d.cx < r.left + other.clientWidth && d.cy >= r.top && d.cy < r.top + other.clientHeight;
    let row: HTMLElement | null = null;
    if (inside) {
      row = (document.elementFromPoint(d.cx, d.cy) as HTMLElement | null)?.closest<HTMLElement>(".file.dir") ?? null;
      if (row && !other.contains(row)) row = null;
    }
    const dir = inside ? mover.dir(row) : null;
    if (d.over !== row) {
      d.over?.classList.remove("drop-into");
      row?.classList.add("drop-into");
      d.over = row;
    }
    other.classList.toggle("drop", inside && !!dir && !row);
    d.target = dir;
    ghost.querySelector<HTMLElement>(".dg-hint")!.textContent = !inside
      ? `Drop on the ${mover.verb === "Upload" ? "remote" : "local"} pane to ${mover.verb.toLowerCase()}`
      : dir
        ? `${mover.verb} to ${dir}`
        : "Connect to a site first";
    ghost.classList.toggle("ok", !!dir);
    document.body.classList.toggle("drag-ok", !!dir);
  };

  const update = () => (drag?.kind === "move" ? moveUpdate() : boxUpdate());

  /** Keep scrolling while the pointer is held above or below the list, faster the further out it is. */
  const tick = () => {
    const d = drag;
    if (!d?.active || d.kind !== "box") return;
    const rect = el.getBoundingClientRect();
    const top = rect.top + el.clientTop;
    const bottom = top + el.clientHeight;
    const dy = d.cy < top ? d.cy - top : d.cy > bottom ? d.cy - bottom : 0;
    if (dy) {
      const before = el.scrollTop;
      el.scrollTop += Math.sign(dy) * Math.min(32, 3 + Math.abs(dy) / 4);
      if (el.scrollTop !== before) boxUpdate();
    }
    d.raf = requestAnimationFrame(tick);
  };

  const end = () => {
    const d = drag;
    if (!d) return;
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onCancel);
    document.removeEventListener("keydown", onKey, true);
    if (!d.active) {
      // A plain click on empty space clears the selection, as Explorer does.
      if (!d.onRow && d.mode === "replace" && selected.size) {
        selected.clear();
        syncSelection(el, selected);
      }
      return;
    }
    try {
      el.releasePointerCapture(d.id);
    } catch {
      /* already released */
    }
    // The click that follows a drag lands on a row or the list; it must not reset the selection to one row.
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    if (d.kind === "move") {
      ghost.remove();
      ghost.classList.remove("ok");
      d.over?.classList.remove("drop-into");
      mover.other.classList.remove("drop");
      document.body.classList.remove("drag-ok");
      if (!d.cancelled && d.target) {
        if (d.over) toast(`${mover.verb}ing ${d.paths.length} item${d.paths.length === 1 ? "" : "s"} to ${d.target}`);
        void mover.run(d.paths, d.target);
      }
      return;
    }
    cancelAnimationFrame(d.raf);
    box.remove();
    // Nothing that vanished in a re-render mid-drag may linger in the selection.
    const present = new Set(Array.from(el.querySelectorAll<HTMLElement>(".file")).map((r) => r.dataset.path!));
    for (const p of [...selected]) if (!present.has(p)) selected.delete(p);
    noteSelection(el);
  };

  const onMove = (e: PointerEvent) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    d.cx = e.clientX;
    d.cy = e.clientY;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.px, e.clientY - d.py) < THRESHOLD) return;
      d.active = true;
      $("ctxMenu").classList.add("hidden");
      try {
        el.setPointerCapture(d.id); // keep getting moves, and the release, when the pointer leaves the window
      } catch {
        /* the button is already up */
      }
      if (d.kind === "move") {
        d.paths = [...selected];
        const entries = mover.entries();
        const first = entries.find((x) => x.path === d.paths[0]);
        const names = d.paths.slice(0, 3).map((p) => entries.find((x) => x.path === p)?.name ?? p);
        ghost.querySelector<HTMLElement>(".dg-items")!.textContent =
          d.paths.length === 1 && first ? `${icon(first)} ${first.name}` : `${d.paths.length} items · ${names.join(", ")}${d.paths.length > 3 ? ", …" : ""}`;
        document.body.appendChild(ghost);
      } else {
        Object.assign(d, measure());
        if (d.mode === "replace") {
          selected.clear();
          for (const r of d.rows) r.el.classList.remove("selected");
        } else d.base = new Set(selected);
        d.raf = requestAnimationFrame(tick);
      }
    }
    update();
  };

  const onUp = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id) end();
  };
  const onCancel = () => {
    if (!drag) return;
    drag.cancelled = true;
    end();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !drag?.active) return;
    e.stopPropagation();
    onCancel();
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    if (drag) onCancel(); // a release we never saw (focus left the window mid-press)
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left - el.clientLeft;
    const y = e.clientY - rect.top - el.clientTop;
    if (x >= el.clientWidth || y >= el.clientHeight) return; // on a scrollbar
    if (!el.querySelector(".file")) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".file");
    const mode = e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "add" : "replace";
    const kind = row && mode === "replace" && target.closest(".ico, .txt") ? "move" : "box";
    if (kind === "move" && !selected.has(row!.dataset.path!)) {
      // Grabbing a row that was not selected drags just that row, as in Explorer.
      selected.clear();
      selected.add(row!.dataset.path!);
      syncSelection(el, selected);
    }
    drag = {
      kind, id: e.pointerId, px: e.clientX, py: e.clientY, ax: x + el.scrollLeft, ay: y + el.scrollTop, cx: e.clientX, cy: e.clientY,
      mode, onRow: Boolean(row), active: false, cancelled: false, base: new Set(), rows: [], left: 0, right: 0, lo: 0, hi: -1, raf: 0,
      paths: [], over: null, target: null,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    document.addEventListener("keydown", onKey, true);
  });
  el.addEventListener("scroll", () => update());
  el.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}

// ---------------- transfers ----------------

/** Upload local paths (default: the selection) into a remote directory (default: the one shown). */
async function uploadSelected(paths?: string[], dir = state.remotePath) {
  if (!state.site || !state.connected) return toast("Connect to a site first", "error");
  const list = paths ?? [...state.selLocal];
  if (!list.length) return toast("Select something on the left first");
  for (const local of list) {
    const name = local.split(/[\\/]/).pop()!;
    const entry = state.localEntries.find((e) => e.path === local);
    const remote = entry?.type === "dir" ? rjoin(dir, name) : dir;
    await guard(rpc("upload", { site: state.site.name, local, remote }));
  }
  loadRemote(state.remotePath);
}

/** Download remote paths (default: the selection) into a local directory (default: the one shown). */
async function downloadSelected(paths?: string[], dir = state.localPath) {
  if (!state.site || !state.connected) return toast("Connect to a site first", "error");
  const list = paths ?? [...state.selRemote];
  if (!list.length) return toast("Select something on the right first");
  for (const remote of list) {
    const entry = state.remoteEntries.find((e) => e.path === remote);
    const name = remote.split("/").pop()!;
    const local = entry?.type === "dir" ? ljoin(dir, name) : dir;
    await guard(rpc("download", { site: state.site.name, remote, local }));
  }
  loadLocal(state.localPath);
}

/** The speed graph on a card: one point per progress event (about one a second), drawn as a filled line. */
function sparkline(samples: number[]): { line: string; area: string; peak: number } {
  const n = samples.length;
  if (n < 2) return { line: "", area: "", peak: 0 };
  const peak = Math.max(1, ...samples);
  const W = 100;
  const H = 24;
  const pts = samples.map((v, i) => `${((i / (n - 1)) * W).toFixed(2)},${(H - 1 - (v / peak) * (H - 3)).toFixed(2)}`);
  return { line: `M${pts.join(" L")}`, area: `M0,${H} L${pts.join(" L")} L${W},${H} Z`, peak };
}

/** Pause, resume or cancel a running operation from its card. */
async function controlOp(op: string, action: "pause" | "resume" | "cancel") {
  const ok = await window.coolftp.control(op, action);
  if (!ok) {
    toast("That transfer has already finished");
    state.paused.delete(op);
    state.cancelling.delete(op);
  } else if (action === "cancel") {
    state.cancelling.add(op);
    state.paused.delete(op);
  } else if (action === "pause") state.paused.add(op);
  else state.paused.delete(op);
  renderTransfers();
}

const CARD_HTML = `<div class="pc-head"><span class="pc-title"></span><span class="who"></span><span class="spacer"></span><span class="pc-verify"></span><span class="pc-conn"></span><button class="pc-btn pause" title="Let the files in flight finish, then wait">⏸ Pause</button><button class="pc-btn cancel" title="Let the files in flight finish, then stop. A cancelled deploy can be run again to continue.">✕ Cancel</button></div>
  <div class="bar big"><i></i></div>
  <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none"><path class="area"></path><path class="line"></path></svg>
  <div class="pc-foot"><span class="pc-counts"></span><span class="spacer"></span><span class="pc-status muted"></span></div>`;

/**
 * One card per deploy or folder transfer: how far along, how fast (with a graph of it), how it ended,
 * and Pause and Cancel while it runs. Cards are updated in place rather than rebuilt, so a button
 * under the pointer survives the stream of progress events.
 */
function renderProgressCards() {
  const host = $("progressCards");
  const cards = [...state.progress.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 5);
  const keep = new Set(cards.map(([op]) => op));
  for (const el of Array.from(host.children)) if (!keep.has((el as HTMLElement).dataset.op!)) el.remove();
  cards.forEach(([op, p], index) => {
    let card = host.querySelector<HTMLElement>(`.progress-card[data-op="${op}"]`);
    if (!card) {
      card = document.createElement("div");
      card.dataset.op = op;
      card.innerHTML = CARD_HTML;
      card.querySelector<HTMLButtonElement>(".pc-btn.pause")!.onclick = () => controlOp(op, state.paused.has(op) ? "resume" : "pause");
      card.querySelector<HTMLButtonElement>(".pc-btn.cancel")!.onclick = () => controlOp(op, "cancel");
    }
    if (host.children[index] !== card) host.insertBefore(card, host.children[index] ?? null);
    const pct = p.totalBytes ? Math.min(100, Math.round((p.bytes / p.totalBytes) * 100)) : p.totalFiles ? Math.min(100, Math.round((p.files / p.totalFiles) * 100)) : 0;
    const d = state.opDetail.get(op);
    const rec = d?.record;
    const verify = d?.verify ?? rec?.verify;
    const paused = state.paused.has(op);
    const cancelling = state.cancelling.has(op);
    const failed = p.done && Boolean(p.error);
    card.className = `progress-card ${p.done ? (failed ? "failed" : "done") : paused ? "paused" : "active"}`;
    card.querySelector(".pc-title")!.textContent = `${p.op} → ${p.site}`;
    const who = card.querySelector(".who")!;
    who.textContent = p.agent !== "user" ? p.agent : "";
    who.classList.toggle("agent", p.agent !== "user");
    card.querySelector(".pc-verify")!.innerHTML = verifyBadge(verify);
    card.querySelector(".pc-conn")!.textContent = p.connections > 1 ? `${p.connections} connections` : "";
    const pauseBtn = card.querySelector<HTMLButtonElement>(".pc-btn.pause")!;
    pauseBtn.hidden = p.done || cancelling;
    pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
    card.querySelector<HTMLButtonElement>(".pc-btn.cancel")!.hidden = p.done || cancelling;
    card.querySelector<HTMLElement>(".bar.big > i")!.style.width = `${pct}%`;
    const spark = sparkline(state.speed.get(op) ?? []);
    const svg = card.querySelector<SVGElement>(".spark")!;
    svg.querySelector(".line")!.setAttribute("d", spark.line);
    svg.querySelector(".area")!.setAttribute("d", spark.area);
    svg.style.display = spark.line ? "" : "none";
    svg.setAttribute("title", spark.peak ? `speed over time, peak ${fmtBytes(spark.peak)}/s` : "");
    card.querySelector(".pc-counts")!.textContent = `${p.files.toLocaleString()} / ${p.totalFiles.toLocaleString()} files · ${fmtBytes(p.bytes)} of ${fmtBytes(p.totalBytes)} (${pct}%)`;
    const status = p.done
      ? failed
        ? p.error!
        : rec
          ? `+${rec.added} ~${rec.changed} -${rec.deleted} in ${(rec.durationMs / 1000).toFixed(1)}s${rec.git ? ` · ${rec.git.short}${rec.git.dirty ? "*" : ""}` : ""}${rec.backup ? " · undo available" : ""}`
          : "done"
      : cancelling
        ? "cancelling after the files in flight…"
        : paused
          ? "paused"
          : `${fmtBytes(p.rate)}/s${p.etaMs > 0 ? ` · ~${fmtDuration(p.etaMs)} left` : ""}`;
    const st = card.querySelector(".pc-status")!;
    st.textContent = status;
    st.className = `pc-status ${failed ? "bad" : "muted"}`;
  });
}

function renderTransfers() {
  const rows = $("transferRows");
  const list = [...state.transfers.values()].reverse();
  const active = list.filter((t) => t.status === "active" || t.status === "queued").length;
  $("transferBadge").textContent = active ? String(active) : "";
  renderProgressCards();
  if (!list.length) {
    rows.innerHTML = state.progress.size ? "" : `<div class="empty muted">No transfers yet. Upload, download, or deploy.</div>`;
    return;
  }
  rows.innerHTML = list
    .slice(0, 300)
    .map((t) => {
      const pct = t.size ? Math.min(100, Math.round((t.transferred / t.size) * 100)) : t.status === "done" ? 100 : 0;
      const status = t.status === "error" ? esc(t.error) : t.status === "done" ? "done" : t.status === "active" ? `${pct}%` : "queued";
      return `<div class="transfer ${t.status}">
        <span class="arrow ${t.direction === "upload" ? "up" : "down"}">${t.direction === "upload" ? "↑" : "↓"}</span>
        <span class="path" title="${esc(t.local)}">${esc(t.remote)}<span class="who ${t.agent !== "user" ? "agent" : ""}">${t.agent !== "user" ? esc(t.agent) : ""}</span></span>
        <span class="size">${fmtBytes(t.size)}</span>
        <span><div class="bar"><i style="width:${pct}%"></i></div><div class="status">${status}</div></span>
      </div>`;
    })
    .join("");
}

// ---------------- activity / agents / history ----------------

function renderActivity() {
  const el = $("tab-activity");
  el.innerHTML = state.log
    .slice(-400)
    .reverse()
    .map((l) => `<div class="logline ${l.level}"><span class="t">${fmtTime(l.t)}</span>${l.agent !== "user" ? `<span class="who">${esc(l.agent)}</span>` : ""}<span>${esc(l.message)}</span></div>`)
    .join("");
}

function renderAgents() {
  const el = $("tab-agents");
  const active = state.calls.filter((c) => !c.endedAt).length;
  $("agentBadge").textContent = active ? String(active) : "";
  const pill = $("hubPill");
  pill.classList.toggle("busy", active > 0);
  const mcp = state.cliPath ? `claude mcp add coolftp -- node "${state.cliPath}" mcp` : "coolftp mcp";
  const intro = `<div class="agent-intro">
      <div><b>Coding agents drive this app through a local hub${state.hubPort ? ` on port ${state.hubPort}` : ""}.</b><br />
      <span class="muted">Claude Code: <code>${esc(mcp)}</code> &nbsp;·&nbsp; any agent: <code>coolftp deploy</code> in the project.</span><br />
      <span class="muted">Config folder: <code>${esc(state.configDir)}</code></span></div>
      <button class="btn small ghost" id="copyMcp">Copy</button></div>`;
  const rows = state.calls
    .map((c) => {
      const cls = !c.endedAt ? "active" : c.ok ? "ok" : "fail";
      const dur = c.endedAt ? `${((c.endedAt - c.startedAt) / 1000).toFixed(1)}s` : `${((Date.now() - c.startedAt) / 1000).toFixed(0)}s`;
      const open = state.openCalls.has(c.op);
      const result = c.result ? `<span class="res">${esc(c.result)}</span>` : "";
      return `<div class="call ${cls} ${open ? "open" : ""}" data-op="${esc(c.op)}" title="Click for where it went"><span class="agent">${esc(c.agent)}</span><span>${esc(c.summary)}${result}</span><span class="dur">${fmtTime(c.startedAt)} · ${dur}</span><span class="state">${!c.endedAt ? "running" : c.ok ? "ok" : "failed"}</span>${c.error ? `<span class="err">${esc(c.error)}</span>` : ""}${open ? renderCallDetail(c) : ""}</div>`;
    })
    .join("");
  el.innerHTML = intro + (rows || `<div class="empty muted">No agent activity yet. Run <code>coolftp deploy</code> from Claude Code and watch it appear here.</div>`);
  $("copyMcp").onclick = () => {
    navigator.clipboard.writeText(mcp);
    toast("Copied", "success", 1200);
  };
  el.querySelectorAll<HTMLElement>(".call").forEach((row) => {
    row.onclick = (ev) => {
      if ((ev.target as HTMLElement).closest(".call-detail")) return;
      const op = row.dataset.op!;
      if (state.openCalls.has(op)) state.openCalls.delete(op);
      else state.openCalls.add(op);
      renderAgents();
    };
  });
}

/** Where an agent call went: the remote directory, every file it touched, folders it created, and the live checks. */
function renderCallDetail(c: AgentCall): string {
  const d = state.opDetail.get(c.op);
  const rec = d?.record;
  const verify = d?.verify ?? rec?.verify;
  const parts: string[] = [];
  if (rec?.remoteRoot) parts.push(`<div><b>remote directory</b>${esc(rec.remoteRoot)}</div>`);
  if (d?.topLevel.length) parts.push(`<div class="warn">⚠ created new top-level folder${d.topLevel.length > 1 ? "s" : ""}: ${d.topLevel.map(esc).join(", ")}</div>`);
  else if (d?.created.length) parts.push(`<div><b>created</b>${d.created.slice(0, 8).map(esc).join(", ")}${d.created.length > 8 ? ` … ${d.created.length - 8} more` : ""}</div>`);
  for (const w of d?.warnings.slice(-8) ?? []) parts.push(`<div class="warn">${esc(w)}</div>`);
  if (verify) {
    parts.push(
      `<div><b>live checks</b><span class="checks">${verify.checks
        .map((k) => `<span class="${k.ok ? (k.content === "stale" ? "stale" : "ok") : "bad"}">${k.status || "ERR"} ${esc(k.url)}${k.content === "stale" ? " (stale copy served)" : k.content === "match" ? " (content matches)" : ""}${k.error ? ` ${esc(k.error)}` : ""}</span>`)
        .join("")}</span></div>`,
    );
  }
  if (rec?.backup) parts.push(`<div><b>undo</b>${esc(describeUndo(rec.backup))}</div>`);
  const files = d?.files ?? [];
  if (files.length) {
    parts.push(
      `<div><b>files</b>${files.length}${files.length >= 300 ? "+" : ""}<div class="files">${files
        .slice(0, 200)
        .map((f) => `<span>${f.direction === "upload" ? "↑" : "↓"} ${esc(f.remote)}<i>${fmtBytes(f.size)}</i></span>`)
        .join("")}${files.length > 200 ? `<span>… ${files.length - 200} more</span>` : ""}</div></div>`,
    );
  }
  if (!parts.length) parts.push(`<div class="muted">${c.endedAt ? "No files were transferred by this call." : "Running…"}</div>`);
  return `<div class="call-detail">${parts.join("")}</div>`;
}

async function loadHistory() {
  if (!state.site) return;
  state.history = (await guard(rpc<DeployRecord[]>("history", { site: state.site.name, limit: 50 }))) ?? [];
  renderHistory();
}

function renderHistory() {
  const el = $("tab-history");
  if (!state.history.length) {
    el.innerHTML = `<div class="empty muted">No deploys recorded for ${esc(state.site?.name ?? "this site")} yet.</div>`;
    return;
  }
  const latest = state.history[0];
  const canRollback = state.history.some((d) => d.git?.commit && d.git.commit !== latest.git?.commit);
  const canUndo = Boolean(latest.backup && latest.project);
  const undoTitle = canUndo ? `Undo ${describeUndo(latest.backup!)}` : "The last deploy kept no previous versions to restore";
  el.innerHTML =
    `<div class="agent-intro"><div><b>Live:</b> ${latest.git ? esc(latest.git.short) : "unknown commit"} ${esc(latest.message ?? latest.git?.subject ?? "")} <span class="muted">· ${esc(latest.at.slice(0, 16).replace("T", " "))}</span> ${verifyBadge(latest.verify)}</div>
      <span class="spacer"></span>
      <button class="btn small ghost" id="recheck" ${latest.project ? "" : "disabled"} title="Fetch the site and the last deploy's files again without deploying">⟳ Re-check</button>
      <button class="btn small ghost" id="undoLast" ${canUndo ? "" : "disabled"} title="${esc(undoTitle)}">↶ Undo last deploy</button>
      <button class="btn small ghost" id="rollbackPrev" ${canRollback ? "" : "disabled"} title="Restore the previous commit that was live">↺ Roll back to previous</button></div>` +
    state.history
      .map(
        (d) => `<div class="deploy-row"><span class="muted">${esc(d.at.slice(0, 16).replace("T", " "))}</span>
      <span class="counts"><b>+${d.added}</b> <i>~${d.changed}</i> <s>-${d.deleted}</s></span>
      <span class="git">${d.git ? esc(d.git.short + (d.git.dirty ? "*" : "")) : ""}</span>
      <span>${d.undoOf ? `<span style="color:var(--yellow)" title="undo of ${esc(d.undoOf)}">↶</span> ` : d.rollbackOf ? `<span style="color:var(--yellow)">↺</span> ` : ""}${d.agent && d.agent !== "user" ? `<span class="who" style="color:var(--sky)">${esc(d.agent)}</span> ` : ""}${esc(d.message ?? d.git?.subject ?? "")} <span class="muted">${fmtBytes(d.bytes)} · ${(d.durationMs / 1000).toFixed(1)}s${d.connections && d.connections > 1 ? ` · ${d.connections} conn` : ""}</span>${verifyBadge(d.verify)}${d.backup ? `<span class="vbadge" title="undo ${esc(describeUndo(d.backup))}">↶ undoable</span>` : ""}
      ${d.git?.commit && d.project && d !== latest ? `<button class="btn small ghost restore" data-id="${esc(d.id)}" data-project="${esc(d.project)}" title="Restore this deploy's commit">restore</button>` : ""}</span></div>`,
      )
      .join("");
  const run = async (to: string | undefined, project: string) => {
    if (!(await confirmDialog(to ? `Restore deploy ${to}?` : "Roll back to the previous live commit?"))) return;
    switchTab("transfers");
    const r = await guard(rpc<{ record?: DeployRecord; commit: string }>("rollback", { cwd: project, site: state.site!.name, to }));
    if (r?.record) {
      toast(`Rolled back to ${r.commit.slice(0, 7)}: +${r.record.added} ~${r.record.changed} -${r.record.deleted}`, "success", 5000);
      if (state.connected) loadRemote(state.remotePath);
      loadHistory();
    }
  };
  const prev = $("rollbackPrev") as HTMLButtonElement | null;
  if (prev && latest.project) prev.onclick = () => run(undefined, latest.project!);
  el.querySelectorAll<HTMLButtonElement>(".restore").forEach((b) => (b.onclick = () => run(b.dataset.id, b.dataset.project!)));
  const undoBtn = $("undoLast") as HTMLButtonElement | null;
  if (undoBtn && canUndo) {
    undoBtn.onclick = async () => {
      if (!(await confirmDialog(`Undo the last deploy (${latest.message ?? latest.id})?`))) return;
      switchTab("transfers");
      const r = await guard(rpc<{ record?: DeployRecord; verify?: VerifyResult }>("undo", { cwd: latest.project, site: state.site!.name }));
      if (r?.record) {
        toast(`Undone: restored ${r.record.changed}, put back ${r.record.added}, removed ${r.record.deleted}`, "success", 5000);
        if (state.connected) loadRemote(state.remotePath);
        loadHistory();
      }
    };
  }
  const recheck = $("recheck") as HTMLButtonElement | null;
  if (recheck && latest.project) {
    recheck.onclick = async () => {
      recheck.disabled = true;
      const r = await guard(rpc<VerifyResult>("verify", { cwd: latest.project, site: state.site!.name }));
      if (r) toast(r.ok ? (r.stale ? `Live, but ${r.stale} file(s) still served from an old copy` : "Verified live") : `Not live: ${r.checks.find((k) => !k.ok)?.url} answered ${r.checks.find((k) => !k.ok)?.status || "nothing"}`, r.ok ? (r.stale ? "info" : "success") : "error", 6000);
      loadHistory();
    };
  }
}

// ---------------- deploy modal ----------------

async function openDeploy() {
  await loadSites();
  const modal = $("deployModal");
  const dir = $<HTMLInputElement>("deployDir");
  if (!dir.value) dir.value = state.site?.localRoot || state.localPath;
  const siteSel = $<HTMLSelectElement>("deploySite");
  if (state.site) siteSel.value = state.site.name;
  const pf = await window.coolftp.local.projectFile(dir.value);
  if (pf) {
    try {
      const cfg = (await rpc("project", { cwd: dir.value })) as { config: { site: string; remoteRoot?: string } };
      siteSel.value = cfg.config.site;
      $<HTMLInputElement>("deployRemoteRoot").value = cfg.config.remoteRoot ?? "";
    } catch {
      /* ignore */
    }
  }
  state.plan = null;
  $("planBox").innerHTML = `<div class="empty muted">${pf ? `Linked via ${esc(pf)}.` : "Not linked yet."} Click <b>Preview</b>.</div>`;
  $("planSummary").textContent = "";
  $<HTMLButtonElement>("planDeployBtn").disabled = true;
  modal.classList.remove("hidden");
}

function deployArgs() {
  const cwd = $<HTMLInputElement>("deployDir").value.trim();
  const site = $<HTMLSelectElement>("deploySite").value;
  const remoteRoot = $<HTMLInputElement>("deployRemoteRoot").value.trim();
  return { cwd, site, remoteRoot };
}

async function previewPlan() {
  const { cwd, site } = deployArgs();
  if (!cwd || !site) return toast("Pick a folder and a site", "error");
  $("planBox").innerHTML = `<div class="empty muted">Scanning…</div>`;
  const force = $<HTMLInputElement>("deployForce").checked;
  const r = await guard(rpc<{ plan: Plan; remoteRoot: string; site: Site }>("diff", { cwd, site, force }));
  if (!r) {
    $("planBox").innerHTML = `<div class="empty muted">Preview failed. See Activity.</div>`;
    return;
  }
  state.plan = r.plan;
  state.planCtx = { cwd, site, remoteRoot: r.remoteRoot };
  renderPlan();
}

function renderPlan() {
  const p = state.plan!;
  const del = $<HTMLInputElement>("deployDelete").checked;
  const group = (title: string, items: string[], cls: string) =>
    items.length ? `<div class="group">${title} (${items.length})</div>` + items.map((f) => `<div class="p ${cls}">${cls === "add" ? "+" : cls === "change" ? "~" : "−"} ${esc(f)}</div>`).join("") : "";
  const total = p.add.length + p.change.length;
  $("planBox").innerHTML =
    total || p.delete.length
      ? group("New", p.add, "add") + group("Changed", p.change, "change") + group(del ? "Will delete" : "Stale on server (kept)", p.delete, del ? "delete" : "delete kept")
      : `<div class="empty">Remote is up to date. Nothing to upload.</div>`;
  $("planSummary").textContent = `${state.planCtx!.site}:${state.planCtx!.remoteRoot} · ${p.add.length} new, ${p.change.length} changed, ${p.delete.length} stale, ${p.unchanged} unchanged · ${fmtBytes(p.bytes)} · basis: ${p.basis}`;
  $<HTMLButtonElement>("planDeployBtn").disabled = !(total || (del && p.delete.length));
}

async function runDeploy() {
  const { cwd, site } = deployArgs();
  const options = {
    site,
    message: $<HTMLInputElement>("deployMessage").value.trim() || undefined,
    delete: $<HTMLInputElement>("deployDelete").checked,
    force: $<HTMLInputElement>("deployForce").checked,
    commit: $<HTMLInputElement>("deployCommit").checked,
  };
  $("deployModal").classList.add("hidden");
  switchTab("transfers");
  const r = await guard(rpc<{ record?: DeployRecord; verify?: VerifyResult; urls?: string[] }>("deploy", { cwd, options }));
  if (r?.record) {
    toast(`Deployed: +${r.record.added} ~${r.record.changed} -${r.record.deleted}`, "success");
    if (r.verify) toast(r.verify.ok ? `Verified live: ${r.verify.checks[0]?.url}` : `Verification failed: ${r.verify.checks.find((c) => !c.ok)?.url} answered ${r.verify.checks.find((c) => !c.ok)?.status || "nothing"}`, r.verify.ok ? "success" : "error", 6000);
    if (state.connected) loadRemote(state.remotePath);
    loadHistory();
  }
}

async function linkFolder() {
  const { cwd, site, remoteRoot } = deployArgs();
  if (!cwd || !site) return toast("Pick a folder and a site", "error");
  const config: Record<string, unknown> = { site };
  if (remoteRoot) config.remoteRoot = remoteRoot;
  const file = await guard(rpc<string>("init", { cwd, config }));
  if (file) toast(`Wrote ${file}. Agents can now just run coolftp deploy here.`, "success", 5000);
}

// ---------------- sites modal ----------------

function openSites(editName?: string) {
  $("sitesModal").classList.remove("hidden");
  state.editingSite = editName ?? state.site?.name ?? null;
  renderSitesList();
  fillSiteForm(state.sites.find((s) => s.name === state.editingSite) ?? null);
}

function renderSitesList() {
  const el = $("sitesList");
  el.innerHTML =
    `<div class="site-item new ${state.editingSite === null ? "selected" : ""}" data-name="">+ New site</div>` +
    state.sites
      .map((s) => `<div class="site-item ${s.name === state.editingSite ? "selected" : ""}" data-name="${esc(s.name)}" style="border-left-color:${esc(s.color || "transparent")}">${esc(s.name)}<div class="h">${esc(s.protocol)}://${esc(s.username)}@${esc(s.host)}</div></div>`)
      .join("");
  el.querySelectorAll<HTMLElement>(".site-item").forEach((item) => {
    item.onclick = () => {
      state.editingSite = item.dataset.name || null;
      renderSitesList();
      fillSiteForm(state.sites.find((s) => s.name === state.editingSite) ?? null);
    };
  });
}

function fillSiteForm(site: Site | null) {
  const f = $<HTMLFormElement>("siteForm");
  f.reset();
  const set = (n: string, v: unknown) => ((f.elements.namedItem(n) as HTMLInputElement).value = v == null ? "" : String(v));
  if (site) {
    set("name", site.name);
    set("host", site.host);
    set("port", site.port);
    set("username", site.username);
    set("protocol", site.protocol);
    set("privateKeyPath", site.privateKeyPath ?? "");
    set("remoteRoot", site.remoteRoot);
    set("url", site.url ?? "");
    set("localRoot", site.localRoot ?? "");
    set("ignore", (site.ignore ?? []).join(", "));
    set("color", site.color ?? "#38bdf8");
    (f.elements.namedItem("password") as HTMLInputElement).placeholder = site.hasPassword ? "•••••••• (unchanged)" : "leave blank to use a key or the ssh agent";
  } else {
    set("protocol", "sftp");
    set("remoteRoot", "/");
    set("color", "#38bdf8");
  }
  $("siteDelete").classList.toggle("hidden", !site);
}

function readSiteForm(): Record<string, unknown> {
  const f = $<HTMLFormElement>("siteForm");
  const g = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
  const existing = state.sites.find((s) => s.name === state.editingSite);
  const site: Record<string, unknown> = {
    name: g("name"),
    host: g("host"),
    port: Number(g("port")) || undefined,
    username: g("username"),
    protocol: g("protocol"),
    privateKeyPath: g("privateKeyPath") || undefined,
    remoteRoot: g("remoteRoot") || "/",
    url: g("url") || undefined,
    localRoot: g("localRoot") || undefined,
    ignore: g("ignore") ? g("ignore").split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    color: g("color"),
  };
  const pw = g("password");
  if (pw) site.password = pw;
  else if (existing?.hasPassword) site.keepPassword = true;
  return site;
}

async function saveSite(): Promise<Site | undefined> {
  const form = readSiteForm();
  if (form.keepPassword) {
    // Preserve the stored password without ever sending it to the renderer.
    delete form.keepPassword;
    form.password = "__KEEP__";
  }
  const saved = await guard(rpc<Site>("addSite", { site: form }));
  if (!saved) return;
  if (state.editingSite && state.editingSite !== saved.name) await rpc("removeSite", { name: state.editingSite });
  state.editingSite = saved.name;
  await loadSites(saved.name);
  renderSitesList();
  fillSiteForm(state.sites.find((s) => s.name === saved.name) ?? null);
  toast(`Saved ${saved.name}`, "success", 1500);
  return saved;
}

// ---------------- tabs / events ----------------

function switchTab(tab: string) {
  state.tab = tab;
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  for (const t of ["transfers", "agents", "activity", "history"]) $(`tab-${t}`).classList.toggle("hidden", t !== tab);
}

let renderTimer: number | null = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderTransfers();
    if (state.tab === "activity") renderActivity();
    if (state.tab === "agents") renderAgents();
  }, 60);
}

function handleEvent({ event, meta }: { event: CoolEvent; meta: EventMeta }) {
  switch (event.type) {
    case "log":
      state.log.push({ t: Date.now(), level: event.level, message: event.message, agent: meta.agent });
      if (state.log.length > 2000) state.log.splice(0, 500);
      if (event.level === "error" && meta.agent !== "user") toast(`${meta.agent}: ${event.message}`, "error", 5000);
      if (event.level === "warn" || event.level === "error") {
        const d = opDetail(meta.op);
        d.warnings.push(event.message);
        if (d.warnings.length > 50) d.warnings.splice(0, 10);
      }
      break;
    case "transfer":
      state.transfers.set(event.transfer.id, { ...event.transfer, agent: meta.agent });
      if (state.transfers.size > 1000) {
        const first = state.transfers.keys().next().value as string;
        state.transfers.delete(first);
      }
      if (event.transfer.status === "done") {
        const d = opDetail(meta.op);
        if (d.files.length < 300) d.files.push({ remote: event.transfer.remote, size: event.transfer.size, direction: event.transfer.direction });
      }
      break;
    case "progress": {
      const p = event.progress as ProgressInfo;
      state.progress.set(meta.op, { ...p, agent: meta.agent, at: state.progress.get(meta.op)?.at ?? Date.now() });
      if (state.progress.size > 20) state.progress.delete(state.progress.keys().next().value as string);
      const samples = state.speed.get(meta.op) ?? [];
      if (!p.done) samples.push(p.rate);
      if (samples.length > 120) samples.splice(0, samples.length - 120);
      state.speed.set(meta.op, samples);
      if (p.done) {
        state.paused.delete(meta.op);
        state.cancelling.delete(meta.op);
      }
      break;
    }
    case "created": {
      const d = opDetail(meta.op);
      d.created.push(...(event.dirs as string[]));
      d.topLevel.push(...(event.topLevel as string[]));
      if (event.topLevel.length && meta.agent !== "user") toast(`${meta.agent} created a new top-level folder: ${(event.topLevel as string[]).join(", ")}`, "error", 8000);
      break;
    }
    case "verify":
      opDetail(meta.op).verify = event.verify as VerifyResult;
      break;
    case "deploy": {
      const rec = event.record as DeployRecord;
      opDetail(meta.op).record = rec;
      if (meta.agent !== "user") toast(`${meta.agent} ${rec.undoOf ? "undid a deploy on" : rec.rollbackOf ? "rolled back" : "deployed to"} ${rec.site}: +${rec.added} ~${rec.changed} -${rec.deleted}`, "agent", 6000);
      if (state.connected && state.site?.name === rec.site) loadRemote(state.remotePath);
      loadHistory();
      break;
    }
    case "connect":
      if (event.status === "error") state.log.push({ t: Date.now(), level: "error", message: `${event.site}: ${event.error}`, agent: meta.agent });
      break;
    default:
      break;
  }
  scheduleRender();
}

function handleAgentCall(call: AgentCall) {
  const i = state.calls.findIndex((c) => c.op === call.op);
  if (i >= 0) state.calls[i] = call;
  else {
    state.calls.unshift(call);
    toast(`${call.agent}: ${call.summary}`, "agent", 3000);
  }
  renderAgents();
}

// ---------------- context menus ----------------

function showMenu(x: number, y: number, items: Array<{ label: string; danger?: boolean; sep?: boolean; fn?: () => void }>) {
  const menu = $("ctxMenu");
  menu.innerHTML = items.map((it) => (it.sep ? "<hr />" : `<button class="${it.danger ? "danger" : ""}">${esc(it.label)}</button>`)).join("");
  const buttons = menu.querySelectorAll("button");
  let bi = 0;
  for (const it of items) {
    if (it.sep) continue;
    const b = buttons[bi++];
    b.onclick = () => {
      menu.classList.add("hidden");
      it.fn?.();
    };
  }
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - items.length * 30)}px`;
  menu.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("#ctxMenu")) $("ctxMenu").classList.add("hidden");
});

// ---------------- remote actions ----------------

async function remoteNewFolder() {
  if (!state.connected) return;
  const name = await prompt("New remote folder name");
  if (!name) return;
  await guard(rpc("mkdir", { site: state.site!.name, path: rjoin(state.remotePath, name) }));
  loadRemote(state.remotePath);
}

async function remoteRename() {
  const [p] = [...state.selRemote];
  if (!p) return toast("Select one item");
  const name = await prompt("Rename to", p.split("/").pop());
  if (!name) return;
  await guard(rpc("rename", { site: state.site!.name, from: p, to: rjoin(rparent(p), name) }));
  loadRemote(state.remotePath);
}

async function remoteDelete() {
  const list = [...state.selRemote];
  if (!list.length) return toast("Select something first");
  if (!(await confirmDialog(`Delete ${list.length} remote item${list.length > 1 ? "s" : ""}?`))) return;
  for (const p of list) await guard(rpc("remove", { site: state.site!.name, path: p }));
  loadRemote(state.remotePath);
}

async function localNewFolder() {
  const name = await prompt("New local folder name");
  if (!name) return;
  await window.coolftp.local.mkdir(ljoin(state.localPath, name));
  loadLocal(state.localPath);
}

async function localRename() {
  const [p] = [...state.selLocal];
  if (!p) return toast("Select one item");
  const name = await prompt("Rename to", p.split(/[\\/]/).pop());
  if (!name) return;
  await window.coolftp.local.rename(p, ljoin(lparent(p), name));
  loadLocal(state.localPath);
}

async function localTrash() {
  const list = [...state.selLocal];
  if (!list.length) return;
  if (!(await confirmDialog(`Move ${list.length} item${list.length > 1 ? "s" : ""} to the Recycle Bin?`))) return;
  for (const p of list) await window.coolftp.local.trash(p).catch((e) => toast(e.message, "error"));
  loadLocal(state.localPath);
}

// ---------------- wiring ----------------

async function main() {
  const info = await window.coolftp.hubInfo();
  state.hubPort = info.port;
  state.cliPath = info.cliPath;
  state.configDir = info.configDir;
  state.calls = info.calls ?? [];
  $("version").textContent = `v${info.version}`;
  const pill = $("hubPill");
  pill.classList.toggle("on", Boolean(info.port));
  $("hubText").textContent = info.port ? `hub :${info.port}` : "hub off";
  pill.onclick = () => switchTab("agents");

  const drives = await window.coolftp.local.drives();
  const driveSel = $<HTMLSelectElement>("driveSelect");
  driveSel.innerHTML = drives.map((d) => `<option value="${esc(d)}">${esc(d.replace(/\\$/, ""))}</option>`).join("");
  driveSel.classList.toggle("hidden", drives.length < 2);
  driveSel.onchange = () => loadLocal(driveSel.value);

  await loadSites();
  await loadLocal(localStorage.getItem("lastLocal") || state.site?.localRoot || (await window.coolftp.local.home()));
  renderTransfers();
  renderAgents();
  renderHistory();

  window.coolftp.onEvent(handleEvent);
  window.coolftp.onAgent(handleAgentCall);

  // Agents must get a human click for deletes, --delete deploys, and rollbacks.
  const confirmQueue: ConfirmRequest[] = [];
  let confirmCurrent: ConfirmRequest | null = null;
  let confirmAuto = false;
  let confirmTick: number | null = null;
  const showNextConfirm = () => {
    if (confirmCurrent || !confirmQueue.length) return;
    confirmCurrent = confirmQueue.shift()!;
    if (confirmAuto) {
      window.coolftp.replyConfirm(confirmCurrent.op, true);
      toast(`Auto-approved ${confirmCurrent.agent}: ${confirmCurrent.summary}`, "agent", 4000);
      confirmCurrent = null;
      showNextConfirm();
      return;
    }
    $("confirmWho").textContent = `${confirmCurrent.agent} · ${confirmCurrent.summary}`;
    $("confirmText").textContent = confirmCurrent.detail;
    $("confirmModal").classList.remove("hidden");
    const deadline = Date.now() + 120_000;
    const tick = () => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      $("confirmTimer").textContent = `auto-deny in ${left}s`;
    };
    tick();
    confirmTick = window.setInterval(tick, 1000);
    $("confirmDeny").focus();
  };
  const answerConfirm = (ok: boolean) => {
    if (!confirmCurrent) return;
    if (confirmTick) window.clearInterval(confirmTick);
    confirmTick = null;
    if (ok && $<HTMLInputElement>("confirmAuto").checked) confirmAuto = true;
    window.coolftp.replyConfirm(confirmCurrent.op, ok);
    $("confirmModal").classList.add("hidden");
    confirmCurrent = null;
    showNextConfirm();
  };
  window.coolftp.onConfirm((req) => {
    confirmQueue.push(req);
    showNextConfirm();
  });
  window.coolftp.onConfirmExpired(({ op }) => {
    if (confirmCurrent?.op === op) {
      if (confirmTick) window.clearInterval(confirmTick);
      confirmTick = null;
      $("confirmModal").classList.add("hidden");
      confirmCurrent = null;
      toast("Agent request expired without an answer and was denied.", "error");
      showNextConfirm();
    }
  });
  $("confirmAllow").onclick = () => answerConfirm(true);
  $("confirmDeny").onclick = () => answerConfirm(false);

  // Reconnect to the site used last time so the app is useful the moment it opens.
  if (state.site && (localStorage.getItem("lastSite") === state.site.name || state.sites.length === 1)) connect();
  setInterval(() => {
    if (state.tab === "agents" && state.calls.some((c) => !c.endedAt)) renderAgents();
  }, 1000);

  // top bar
  $("connectBtn").onclick = connect;
  $<HTMLSelectElement>("siteSelect").onchange = () => {
    state.site = state.sites.find((s) => s.name === $<HTMLSelectElement>("siteSelect").value) ?? null;
    state.connected = false;
    state.remoteEntries = [];
    $("remoteList").innerHTML = `<div class="empty">Hit <b>Connect</b>.</div>`;
    $<HTMLInputElement>("remotePath").value = "";
  };
  $("sitesBtn").onclick = () => openSites();
  $("deployBtn").onclick = openDeploy;
  $("diffBtn").onclick = async () => {
    await openDeploy();
    previewPlan();
  };

  // local pane
  $("localUp").onclick = () => loadLocal(lparent(state.localPath));
  $("localRefresh").onclick = () => loadLocal(state.localPath);
  $("localBrowse").onclick = async () => {
    const d = await window.coolftp.dialog.pickFolder();
    if (d) loadLocal(d);
  };
  $<HTMLInputElement>("localPath").onkeydown = (e) => {
    if (e.key === "Enter") loadLocal($<HTMLInputElement>("localPath").value);
  };
  $("uploadBtn").onclick = () => uploadSelected();
  $("localNewFolder").onclick = localNewFolder;
  $("localOpen").onclick = () => window.coolftp.shell.open(state.localPath);
  $("localList").oncontextmenu = (e) => {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>(".file");
    if (row && !state.selLocal.has(row.dataset.path!)) {
      state.selLocal.clear();
      state.selLocal.add(row.dataset.path!);
      renderLocal();
    }
    showMenu(e.clientX, e.clientY, [
      { label: "Upload to remote folder", fn: () => uploadSelected() },
      { label: "Open", fn: () => row && window.coolftp.shell.open(row.dataset.path!) },
      { label: "Show in Explorer", fn: () => row && window.coolftp.shell.showInFolder(row.dataset.path!) },
      { sep: true, label: "" },
      { label: "New folder", fn: localNewFolder },
      { label: "Rename", fn: localRename },
      { label: "Move to Recycle Bin", danger: true, fn: localTrash },
    ]);
  };
  $("localList").onkeydown = (e) => {
    if (e.key === "Delete") localTrash();
    if (e.key === "F2") localRename();
    if (e.key === "Enter") {
      const [p] = [...state.selLocal];
      const en = state.localEntries.find((x) => x.path === p);
      if (en) en.type === "dir" ? loadLocal(en.path) : window.coolftp.shell.open(en.path);
    }
    if (e.key === "Backspace") loadLocal(lparent(state.localPath));
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll($("localList"), state.selLocal, state.localEntries);
    }
  };

  // remote pane
  $("remoteUp").onclick = () => state.connected && loadRemote(rparent(state.remotePath));
  $("remoteRoot").onclick = () => state.connected && loadRemote(state.site!.remoteRoot);
  $("remoteRefresh").onclick = () => state.connected && loadRemote(state.remotePath);
  $<HTMLInputElement>("remotePath").onkeydown = (e) => {
    if (e.key === "Enter" && state.connected) loadRemote($<HTMLInputElement>("remotePath").value);
  };
  $("downloadBtn").onclick = () => downloadSelected();
  $("remoteNewFolder").onclick = remoteNewFolder;
  $("remoteRename").onclick = remoteRename;
  $("remoteDelete").onclick = remoteDelete;
  $("remoteList").oncontextmenu = (e) => {
    if (!state.connected) return;
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>(".file");
    if (row && !state.selRemote.has(row.dataset.path!)) {
      state.selRemote.clear();
      state.selRemote.add(row.dataset.path!);
      renderRemote();
    }
    const entry = row ? state.remoteEntries.find((x) => x.path === row.dataset.path) : undefined;
    showMenu(e.clientX, e.clientY, [
      { label: "Download to local folder", fn: () => downloadSelected() },
      { label: "View", fn: () => entry && entry.type === "file" && viewRemote(entry) },
      { label: "Copy path", fn: () => entry && navigator.clipboard.writeText(entry.path) },
      { sep: true, label: "" },
      { label: "New folder", fn: remoteNewFolder },
      { label: "Rename", fn: remoteRename },
      { label: "Delete", danger: true, fn: remoteDelete },
    ]);
  };
  $("remoteList").onkeydown = (e) => {
    if (e.key === "Delete") remoteDelete();
    if (e.key === "F2") remoteRename();
    if (e.key === "Enter") {
      const [p] = [...state.selRemote];
      const en = state.remoteEntries.find((x) => x.path === p);
      if (en) en.type === "dir" ? loadRemote(en.path) : viewRemote(en);
    }
    if (e.key === "Backspace") loadRemote(rparent(state.remotePath));
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll($("remoteList"), state.selRemote, state.remoteEntries);
    }
  };

  // Drag a box over either list to select rows; grab a row by its name to drag the selection to the other pane.
  listGestures($("localList"), state.selLocal, {
    other: $("remoteList"),
    verb: "Upload",
    entries: () => state.localEntries,
    dir: (row) => (row ? row.dataset.path! : state.connected ? state.remotePath : null),
    run: (paths, dir) => uploadSelected(paths, dir),
  });
  listGestures($("remoteList"), state.selRemote, {
    other: $("localList"),
    verb: "Download",
    entries: () => state.remoteEntries,
    dir: (row) => (row ? row.dataset.path! : state.localPath),
    run: (paths, dir) => downloadSelected(paths, dir),
  });

  // drag & drop from the OS onto the remote pane
  const remoteList = $("remoteList");
  remoteList.ondragover = (e) => {
    e.preventDefault();
    remoteList.classList.add("drop");
  };
  remoteList.ondragleave = () => remoteList.classList.remove("drop");
  remoteList.ondrop = async (e) => {
    e.preventDefault();
    remoteList.classList.remove("drop");
    if (!state.connected) return toast("Connect first", "error");
    const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => window.coolftp.pathFor(f)).filter(Boolean);
    if (!paths.length) return;
    for (const local of paths) {
      const name = local.split(/[\\/]/).pop()!;
      // We cannot stat from the renderer; ask main by listing the parent.
      const parent = await window.coolftp.local.list(lparent(local));
      const entry = parent.entries?.find((x) => x.path === local);
      const remote = entry?.type === "dir" ? rjoin(state.remotePath, name) : state.remotePath;
      await guard(rpc("upload", { site: state.site!.name, local, remote }));
    }
    loadRemote(state.remotePath);
  };

  // bottom tabs
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => (t.onclick = () => {
    switchTab(t.dataset.tab!);
    if (t.dataset.tab === "activity") renderActivity();
    if (t.dataset.tab === "agents") renderAgents();
    if (t.dataset.tab === "history") renderHistory();
  }));
  $("clearBtn").onclick = () => {
    if (state.tab === "transfers") {
      for (const [k, t] of state.transfers) if (t.status === "done" || t.status === "error") state.transfers.delete(k);
      for (const [k, p] of state.progress) {
        if (!p.done) continue;
        state.progress.delete(k);
        state.speed.delete(k);
      }
    }
    if (state.tab === "activity") state.log = [];
    if (state.tab === "agents") state.calls = state.calls.filter((c) => !c.endedAt);
    renderTransfers();
    renderActivity();
    renderAgents();
  };

  // Pro license
  interface LicenseStatus { installed: boolean; valid: boolean; pro: boolean; reason?: string; license?: { email: string; updatesUntil: string; seats: number }; buildDate: string; buyUrl: string }
  const renderLicense = (s: LicenseStatus) => {
    $("proBtn").textContent = s.pro ? "Pro ✔" : "Pro";
    $("proBtn").classList.toggle("primary", s.pro);
    $("proStatus").innerHTML = s.pro && s.license
      ? `<b style="color:var(--green)">Pro is active.</b> Licensed to ${esc(s.license.email)}, updates until ${esc(s.license.updatesUntil)}, up to ${s.license.seats} machines. This build: ${esc(s.buildDate)}.`
      : s.installed && s.valid
        ? `<b style="color:var(--yellow)">Updates ended.</b> ${esc(s.reason ?? "")}`
        : `<b>coolFTP Free</b>, for personal projects. Using it for client or commercial work? A Pro license is $49 once, per person, and funds the project. Paste your key below.`;
    ($("proBuy") as HTMLAnchorElement).onclick = (e) => {
      e.preventDefault();
      window.coolftp.shell.external(s.buyUrl);
    };
    $("proRemove").classList.toggle("hidden", !s.installed);
  };
  const refreshLicense = async () => {
    const s = await guard(rpc<LicenseStatus>("license"));
    if (s) renderLicense(s);
    return s;
  };
  refreshLicense();
  $("proBtn").onclick = async () => {
    await refreshLicense();
    $<HTMLTextAreaElement>("proKey").value = "";
    $("proModal").classList.remove("hidden");
    $("proKey").focus();
  };
  $("proActivate").onclick = async () => {
    const key = $<HTMLTextAreaElement>("proKey").value.trim();
    if (!key) return toast("Paste the key from your license email", "error");
    const s = await guard(rpc<LicenseStatus>("activateLicense", { key }));
    if (!s) return;
    renderLicense(s);
    toast(s.pro ? "Pro activated. Thank you!" : "Key accepted, but this build is newer than your updates period.", s.pro ? "success" : "error", 5000);
    if (s.pro) $("proModal").classList.add("hidden");
  };
  $("proRemove").onclick = async () => {
    if (!(await confirmDialog("Remove the license from this machine?"))) return;
    await guard(rpc("removeLicense"));
    await refreshLicense();
    toast("License removed", "info");
  };

  // modals
  document.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = () => $(b.dataset.close!).classList.add("hidden")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
    if (e.key === "F5") {
      e.preventDefault();
      loadLocal(state.localPath);
      if (state.connected) loadRemote(state.remotePath);
    }
    if (e.ctrlKey && e.key === "Enter") connect();
  });

  // sites modal
  $<HTMLFormElement>("siteForm").onsubmit = async (e) => {
    e.preventDefault();
    await saveSite();
  };
  $("siteTest").onclick = async () => {
    const saved = await saveSite();
    if (!saved) return;
    toast("Testing…", "info", 1500);
    const r = await guard(rpc<{ cwd: string; entries: number; protocol: string }>("test", { site: saved.name }));
    if (r) toast(`OK via ${r.protocol}: ${r.cwd} (${r.entries} entries)`, "success", 5000);
  };
  $("siteDelete").onclick = async () => {
    if (!state.editingSite) return;
    if (!(await confirmDialog(`Delete site ${state.editingSite}?`))) return;
    await rpc("removeSite", { name: state.editingSite });
    state.editingSite = null;
    await loadSites();
    renderSitesList();
    fillSiteForm(null);
  };
  $("pickKey").onclick = async () => {
    const k = await window.coolftp.dialog.pickKey();
    if (k) ($<HTMLFormElement>("siteForm").elements.namedItem("privateKeyPath") as HTMLInputElement).value = k;
  };
  $("pickLocalRoot").onclick = async () => {
    const d = await window.coolftp.dialog.pickFolder();
    if (d) ($<HTMLFormElement>("siteForm").elements.namedItem("localRoot") as HTMLInputElement).value = d;
  };

  // deploy modal
  $("deployPick").onclick = async () => {
    const d = await window.coolftp.dialog.pickFolder();
    if (d) {
      $<HTMLInputElement>("deployDir").value = d;
      state.plan = null;
      $<HTMLButtonElement>("planDeployBtn").disabled = true;
    }
  };
  $("planBtn").onclick = previewPlan;
  $("planDeployBtn").onclick = runDeploy;
  $("planSaveLink").onclick = linkFolder;
  $<HTMLInputElement>("deployDelete").onchange = () => state.plan && renderPlan();
  $<HTMLInputElement>("deployForce").onchange = () => {
    state.plan = null;
    $<HTMLButtonElement>("planDeployBtn").disabled = true;
    $("planBox").innerHTML = `<div class="empty muted">Click <b>Preview</b> again.</div>`;
  };
}

main().catch((e) => toast(e.message, "error", 8000));

export {};
