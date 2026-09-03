import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CoolFtp, Events, configDir, dispatch, shortId, type CoolEvent, type EventMeta } from "@coolftp/core";

export interface AgentCall {
  op: string;
  agent: string;
  method: string;
  summary: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  error?: string;
}

export interface HubHandlers {
  onCall(call: AgentCall): void;
  /** Ask the user to approve a destructive agent action. Resolves false on deny or timeout. */
  confirm(call: AgentCall, detail: string): Promise<boolean>;
}

/** Which agent calls need a human click before they run. */
function destructiveDetail(method: string, args: Record<string, any> = {}): string | null {
  switch (method) {
    case "remove":
      return `Delete ${args.site}:${args.path}`;
    case "rollback":
      return `Roll back ${args.site ?? "the project site"}${args.to ? ` to ${args.to}` : " to the previous deploy"}. Files not in that commit will be deleted from the server.`;
    case "deploy": {
      const o = args.options ?? {};
      if (o.delete) return `Deploy with --delete${o.deleteUntracked ? " --delete-untracked" : ""}: stale files will be removed from the server.`;
      return null;
    }
    default:
      return null;
  }
}

/**
 * Loopback HTTP server that lets the CLI and MCP server run operations *inside* the
 * desktop app. Every event they produce is mirrored into the UI.
 */
export function startHub(cf: CoolFtp, events: Events, handlers: HubHandlers, version: string): Promise<{ port: number; token: string; close: () => void }> {
  const token = crypto.randomBytes(24).toString("hex");
  const file = path.join(configDir(), "hub.json");

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (req.method === "GET" && req.url === "/ping") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, pid: process.pid, version }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;
    let payload: { method: string; args: Record<string, unknown>; agent?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    const op = shortId();
    const agent = payload.agent || "agent";
    const call: AgentCall = { op, agent, method: payload.method, summary: summarise(payload.method, payload.args), startedAt: Date.now() };
    handlers.onCall(call);

    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
    const write = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");
    const child = events.child({ agent, op });
    const off = child.on((event: CoolEvent, meta: EventMeta) => {
      if (meta.op === op) write({ event, meta });
    });
    try {
      const detail = destructiveDetail(payload.method, payload.args);
      if (detail) {
        child.log(`Waiting for approval in the coolFTP app: ${detail}`, "warn");
        const approved = await handlers.confirm(call, detail);
        if (!approved) throw new Error(`Denied in the coolFTP app: ${detail}`);
        child.log("Approved by the user", "success");
      }
      const result = await dispatch(cf, payload.method, payload.args ?? {}, child);
      write({ result: result ?? null });
      handlers.onCall({ ...call, endedAt: Date.now(), ok: true });
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      write({ error: message });
      off();
      // Log for the app's Activity panel only; the CLI prints the error itself.
      child.log(message, "error");
      handlers.onCall({ ...call, endedAt: Date.now(), ok: false, error: message });
    } finally {
      off();
      res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      fs.writeFileSync(file, JSON.stringify({ port, token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
      const close = () => {
        try {
          const cur = JSON.parse(fs.readFileSync(file, "utf8"));
          if (cur.pid === process.pid) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
        server.close();
      };
      resolve({ port, token, close });
    });
  });
}

function summarise(method: string, args: Record<string, unknown> = {}): string {
  const a = args as Record<string, any>;
  switch (method) {
    case "deploy": {
      const o = a.options ?? {};
      const flags = [o.dryRun && "dry-run", o.delete && "delete", o.force && "force", o.commit && "commit"].filter(Boolean).join(", ");
      return `deploy ${shortPath(a.cwd)}${o.site ? ` → ${o.site}` : ""}${flags ? ` (${flags})` : ""}${o.message ? `: ${o.message}` : ""}`;
    }
    case "diff":
      return `diff ${shortPath(a.cwd)}${a.site ? ` → ${a.site}` : ""}`;
    case "upload":
      return `upload ${shortPath(a.local)} → ${a.site}:${a.remote || "/"}`;
    case "download":
      return `download ${a.site}:${a.remote} → ${shortPath(a.local)}`;
    case "ls":
      return `ls ${a.site}:${a.path || "/"}`;
    case "read":
      return `read ${a.site}:${a.path}`;
    case "write":
      return `write ${a.site}:${a.path}`;
    case "remove":
      return `delete ${a.site}:${a.path}`;
    case "mkdir":
      return `mkdir ${a.site}:${a.path}`;
    case "rename":
      return `rename ${a.site}:${a.from} → ${a.to}`;
    case "history":
      return `history ${a.site}`;
    case "test":
      return `test ${a.site}`;
    case "init":
      return `init ${shortPath(a.cwd)} → ${a.config?.site}`;
    case "addSite":
      return `save site ${a.site?.name}`;
    default:
      return method;
  }
}

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
}
