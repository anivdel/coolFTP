/* coolFTP renderer. Vanilla TS, no framework. Talks to main via window.coolftp (see preload.ts). */

type EntryType = "file" | "dir" | "link";
interface Entry { name: string; path: string; type: EntryType; size: number; mtime: number }
interface Site {
  name: string; protocol: "sftp" | "ftp" | "ftps"; host: string; port: number; username: string;
  hasPassword: boolean; privateKeyPath?: string; remoteRoot: string; localRoot?: string; ignore?: string[]; color?: string;
}
interface Transfer { id: string; direction: "upload" | "download"; local: string; remote: string; size: number; transferred: number; status: string; error?: string }
interface Plan { add: string[]; change: string[]; delete: string[]; unchanged: number; bytes: number; basis: string }
interface DeployRecord { id: string; at: string; site: string; agent?: string; message?: string; git?: { short: string; branch: string; subject: string; dirty: boolean }; added: number; changed: number; deleted: number; bytes: number; durationMs: number }
interface AgentCall { op: string; agent: string; method: string; summary: string; startedAt: number; endedAt?: number; ok?: boolean; error?: string }
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
      hubInfo: () => Promise<{ port: number | null; version: string; cliPath: string; calls: AgentCall[]; platform: string }>;
      version: () => Promise<string>;
      pathFor: (f: File) => string;
      onEvent: (cb: (p: { event: CoolEvent; meta: EventMeta }) => void) => () => void;
      onAgent: (cb: (p: AgentCall) => void) => () => void;
    };
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtDate = (ms: number) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "");
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
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
  tab: "transfers",
  editingSite: null as string | null,
};

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
        <span class="name"><span class="ico">${icon(e)}</span>${esc(e.name)}</span>
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
        const a = entries.findIndex((x) => x.path === last);
        const b = entries.indexOf(entry);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(entries[i].path);
      } else {
        selected.clear();
        selected.add(entry.path);
      }
      el.querySelectorAll(".file").forEach((r) => r.classList.toggle("selected", selected.has((r as HTMLElement).dataset.path!)));
    };
    row.ondblclick = () => onOpen(entry);
  });
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

// ---------------- transfers ----------------

async function uploadSelected(paths?: string[]) {
  if (!state.site || !state.connected) return toast("Connect to a site first", "error");
  const list = paths ?? [...state.selLocal];
  if (!list.length) return toast("Select something on the left first");
  for (const local of list) {
    const name = local.split(/[\\/]/).pop()!;
    const entry = state.localEntries.find((e) => e.path === local);
    const remote = entry?.type === "dir" ? rjoin(state.remotePath, name) : state.remotePath;
    await guard(rpc("upload", { site: state.site.name, local, remote }));
  }
  loadRemote(state.remotePath);
}

async function downloadSelected() {
  if (!state.site || !state.connected) return toast("Connect to a site first", "error");
  const list = [...state.selRemote];
  if (!list.length) return toast("Select something on the right first");
  for (const remote of list) {
    const entry = state.remoteEntries.find((e) => e.path === remote)!;
    const local = entry.type === "dir" ? ljoin(state.localPath, entry.name) : state.localPath;
    await guard(rpc("download", { site: state.site.name, remote, local }));
  }
  loadLocal(state.localPath);
}

function renderTransfers() {
  const el = $("tab-transfers");
  const list = [...state.transfers.values()].reverse();
  const active = list.filter((t) => t.status === "active" || t.status === "queued").length;
  $("transferBadge").textContent = active ? String(active) : "";
  if (!list.length) {
    el.innerHTML = `<div class="empty muted">No transfers yet. Upload, download, or deploy.</div>`;
    return;
  }
  el.innerHTML = list
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
      <span class="muted">Claude Code: <code>${esc(mcp)}</code> &nbsp;·&nbsp; any agent: <code>coolftp deploy</code> in the project.</span></div>
      <button class="btn small ghost" id="copyMcp">Copy</button></div>`;
  const rows = state.calls
    .map((c) => {
      const cls = !c.endedAt ? "active" : c.ok ? "ok" : "fail";
      const dur = c.endedAt ? `${((c.endedAt - c.startedAt) / 1000).toFixed(1)}s` : `${((Date.now() - c.startedAt) / 1000).toFixed(0)}s`;
      return `<div class="call ${cls}"><span class="agent">${esc(c.agent)}</span><span>${esc(c.summary)}</span><span class="dur">${fmtTime(c.startedAt)} · ${dur}</span><span class="state">${!c.endedAt ? "running" : c.ok ? "ok" : "failed"}</span>${c.error ? `<span class="err">${esc(c.error)}</span>` : ""}</div>`;
    })
    .join("");
  el.innerHTML = intro + (rows || `<div class="empty muted">No agent activity yet. Run <code>coolftp deploy</code> from Claude Code and watch it appear here.</div>`);
  $("copyMcp").onclick = () => {
    navigator.clipboard.writeText(mcp);
    toast("Copied", "success", 1200);
  };
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
  el.innerHTML = state.history
    .map(
      (d) => `<div class="deploy-row"><span class="muted">${esc(d.at.slice(0, 16).replace("T", " "))}</span>
      <span class="counts"><b>+${d.added}</b> <i>~${d.changed}</i> <s>-${d.deleted}</s></span>
      <span class="git">${d.git ? esc(d.git.short + (d.git.dirty ? "*" : "")) : ""}</span>
      <span>${d.agent && d.agent !== "user" ? `<span class="who" style="color:var(--sky)">${esc(d.agent)}</span> ` : ""}${esc(d.message ?? d.git?.subject ?? "")} <span class="muted">${fmtBytes(d.bytes)} · ${(d.durationMs / 1000).toFixed(1)}s</span></span></div>`,
    )
    .join("");
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
  const r = await guard(rpc<{ record?: DeployRecord }>("deploy", { cwd, options }));
  if (r?.record) {
    toast(`Deployed: +${r.record.added} ~${r.record.changed} -${r.record.deleted}`, "success");
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
      break;
    case "transfer":
      state.transfers.set(event.transfer.id, { ...event.transfer, agent: meta.agent });
      if (state.transfers.size > 1000) {
        const first = state.transfers.keys().next().value as string;
        state.transfers.delete(first);
      }
      break;
    case "deploy":
      if (meta.agent !== "user") toast(`${meta.agent} deployed to ${event.record.site}: +${event.record.added} ~${event.record.changed} -${event.record.deleted}`, "agent", 6000);
      if (state.connected && state.site?.name === event.record.site) loadRemote(state.remotePath);
      loadHistory();
      break;
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
  };

  // remote pane
  $("remoteUp").onclick = () => state.connected && loadRemote(rparent(state.remotePath));
  $("remoteRoot").onclick = () => state.connected && loadRemote(state.site!.remoteRoot);
  $("remoteRefresh").onclick = () => state.connected && loadRemote(state.remotePath);
  $<HTMLInputElement>("remotePath").onkeydown = (e) => {
    if (e.key === "Enter" && state.connected) loadRemote($<HTMLInputElement>("remotePath").value);
  };
  $("downloadBtn").onclick = downloadSelected;
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
      { label: "Download to local folder", fn: downloadSelected },
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
  };

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
    if (state.tab === "transfers") for (const [k, t] of state.transfers) if (t.status === "done" || t.status === "error") state.transfers.delete(k);
    if (state.tab === "activity") state.log = [];
    if (state.tab === "agents") state.calls = state.calls.filter((c) => !c.endedAt);
    renderTransfers();
    renderActivity();
    renderAgents();
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
