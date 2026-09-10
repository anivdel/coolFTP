import type { DeployRecord, DiffPlan, ProgressInfo, TransferProgress, VerifyResult } from "./types.js";

export type CoolEvent =
  | { type: "log"; level: "info" | "warn" | "error" | "success"; message: string }
  | { type: "transfer"; transfer: TransferProgress }
  | { type: "plan"; site: string; plan: DiffPlan }
  | { type: "deploy"; record: DeployRecord }
  | { type: "scan"; count: number; current: string }
  | { type: "connect"; site: string; status: "connecting" | "connected" | "closed" | "error"; error?: string }
  /** Whole-operation progress, at most about once a second. */
  | { type: "progress"; progress: ProgressInfo }
  /** Live checks finished. */
  | { type: "verify"; site: string; verify: VerifyResult }
  /** Directories an operation had to create on the server. topLevel: those directly under the base it worked in. */
  | { type: "created"; site: string; dirs: string[]; topLevel: string[] };

export type Listener = (event: CoolEvent, meta: EventMeta) => void;

export interface EventMeta {
  /** Who initiated the operation (e.g. "claude-code", "user", "cli"). */
  agent: string;
  /** Operation id grouping all events of a single command. */
  op: string;
}

export class Events {
  private listeners = new Set<Listener>();
  constructor(public meta: EventMeta) {}

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: CoolEvent): void {
    for (const l of this.listeners) {
      try {
        l(event, this.meta);
      } catch {
        /* listener errors must not break operations */
      }
    }
  }

  log(message: string, level: "info" | "warn" | "error" | "success" = "info"): void {
    this.emit({ type: "log", level, message });
  }

  /** New Events sharing listeners but with a different op id / agent. */
  child(meta: Partial<EventMeta>): Events {
    const e = new Events({ ...this.meta, ...meta });
    e.listeners = this.listeners;
    return e;
  }
}

export const silentEvents = (): Events => new Events({ agent: "internal", op: "none" });
