import fs from "node:fs";
import path from "node:path";
import { CoolFtp, Events, configDir, dispatch, shortId, type CoolEvent, type EventMeta } from "@coolftp/core";

export type OnEvent = (event: CoolEvent, meta: EventMeta) => void;

export interface Runner {
  mode: "hub" | "direct";
  /** Port of the desktop app hub when mode === "hub". */
  hubPort?: number;
  /** Version the desktop app reported when mode === "hub". */
  appVersion?: string;
  run<T = any>(method: string, args: Record<string, unknown>, onEvent?: OnEvent): Promise<T>;
  close(): Promise<void>;
}

export interface HubInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export function hubFile(): string {
  return path.join(configDir(), "hub.json");
}

export function readHubInfo(): HubInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(hubFile(), "utf8")) as HubInfo;
    if (!info.port || !info.token) return null;
    return info;
  } catch {
    return null;
  }
}

async function pingHub(info: HubInfo): Promise<{ version?: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700);
    const res = await fetch(`http://127.0.0.1:${info.port}/ping`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { version?: string };
    return { version: body.version };
  } catch {
    return null;
  }
}

/**
 * Prefer routing through the running desktop app (so the user sees agent activity live,
 * and connections are shared). Fall back to running the core in-process.
 */
export async function createRunner(opts: { agent: string; direct?: boolean; direct_cf?: CoolFtp }): Promise<Runner> {
  const info = opts.direct ? null : readHubInfo();
  if (info) {
    const pong = await pingHub(info);
    if (pong) return hubRunner(info, opts.agent, pong.version);
  }
  return directRunner(opts.agent, opts.direct_cf);
}

/**
 * Long-lived callers (the MCP server) must not decide hub-or-direct once at startup: the app
 * gets opened and closed while a session runs. This re-checks the hub on every call, with a
 * short cache so a burst of calls does not ping it repeatedly, and keeps one in-process core
 * for direct mode so its connections are reused.
 */
export function runnerFactory(opts: { agent: string; direct?: boolean }): { get(): Promise<Runner>; close(): Promise<void> } {
  const cf = new CoolFtp();
  let cached: { runner: Runner; at: number } | null = null;
  return {
    async get() {
      const now = Date.now();
      if (cached && now - cached.at < 3000) return cached.runner;
      const runner = await createRunner({ agent: opts.agent, direct: opts.direct, direct_cf: cf });
      cached = { runner, at: now };
      return runner;
    },
    close: () => cf.close(),
  };
}

function directRunner(agent: string, cf = new CoolFtp()): Runner {
  return {
    mode: "direct",
    async run(method, args, onEvent) {
      const events = new Events({ agent, op: shortId() });
      if (onEvent) events.on(onEvent);
      return dispatch(cf, method, args, events) as Promise<any>;
    },
    close: () => cf.close(),
  };
}

function hubRunner(info: HubInfo, agent: string, appVersion?: string): Runner {
  return {
    mode: "hub",
    hubPort: info.port,
    appVersion,
    async run(method, args, onEvent) {
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
          body: JSON.stringify({ method, args, agent }),
        });
      } catch (err) {
        throw new Error(`The coolFTP app stopped answering on port ${info.port} (${(err as Error)?.message || String(err)}). Run the command again; it will fall back to a direct connection if the app is closed.`);
      }
      if (!res.ok || !res.body) throw new Error(`coolFTP app returned HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: unknown;
      let error: string | undefined;
      let finished = false;
      const handle = (line: string) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.event && onEvent) onEvent(msg.event, msg.meta);
        if ("result" in msg) {
          result = msg.result;
          finished = true;
        }
        if (msg.error) {
          error = msg.error;
          finished = true;
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      }
      if (buffer.trim()) handle(buffer);
      if (error) throw new Error(error);
      if (!finished) throw new Error("coolFTP app closed the connection before finishing");
      return result as any;
    },
    close: async () => undefined,
  };
}

/** Best-effort detection of which coding agent is driving us. */
export function detectAgent(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.COOLFTP_AGENT) return process.env.COOLFTP_AGENT;
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT) return "cursor";
  if (process.env.CODEX_SANDBOX || process.env.OPENAI_CODEX) return "codex";
  if (process.env.GEMINI_CLI) return "gemini-cli";
  if (process.env.AIDER_MODEL) return "aider";
  if (process.env.TERM_PROGRAM === "vscode" && process.env.GITHUB_COPILOT_AGENT) return "copilot";
  return "cli";
}

/**
 * Inside a packaged app's sandbox (the Claude desktop app is one), Windows redirects writes to
 * %APPDATA% into the package's own LocalCache folder, and reads follow. A coolFTP config that
 * exists there is frozen at whatever was written from inside the sandbox: sites saved in the
 * desktop app since then are invisible here until the app is open and commands route through it.
 */
export function sandboxNote(): string | undefined {
  if (process.platform !== "win32" || process.env.COOLFTP_HOME) return undefined;
  const packages = path.join(process.env.LOCALAPPDATA || "", "Packages");
  try {
    for (const name of fs.readdirSync(packages)) {
      const shadow = path.join(packages, name, "LocalCache", "Roaming", "coolftp", "sites.json");
      if (fs.existsSync(shadow)) {
        return `A sandboxed copy of the coolFTP config exists at ${path.dirname(shadow)}. If sites saved in the desktop app are missing here, open the app so commands route through it.`;
      }
    }
  } catch {
    /* no Packages folder */
  }
  return undefined;
}
