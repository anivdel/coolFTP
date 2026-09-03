import fs from "node:fs";
import path from "node:path";
import { CoolFtp, Events, configDir, dispatch, shortId, type CoolEvent, type EventMeta } from "@coolftp/core";

export type OnEvent = (event: CoolEvent, meta: EventMeta) => void;

export interface Runner {
  mode: "hub" | "direct";
  /** Port of the desktop app hub when mode === "hub". */
  hubPort?: number;
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

async function pingHub(info: HubInfo): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700);
    const res = await fetch(`http://127.0.0.1:${info.port}/ping`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Prefer routing through the running desktop app (so the user sees agent activity live,
 * and connections are shared). Fall back to running the core in-process.
 */
export async function createRunner(opts: { agent: string; direct?: boolean }): Promise<Runner> {
  const info = opts.direct ? null : readHubInfo();
  if (info && (await pingHub(info))) return hubRunner(info, opts.agent);
  return directRunner(opts.agent);
}

function directRunner(agent: string): Runner {
  const cf = new CoolFtp();
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

function hubRunner(info: HubInfo, agent: string): Runner {
  return {
    mode: "hub",
    hubPort: info.port,
    async run(method, args, onEvent) {
      const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
        body: JSON.stringify({ method, args, agent }),
      });
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
