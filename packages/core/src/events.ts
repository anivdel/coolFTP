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
  /** Set by the desktop app so a running operation can be paused or cancelled from its progress card. */
  control?: OpControl;

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

/**
 * Lets the desktop app pause, resume or cancel a running operation from its progress card.
 * Operations check it between files (CoolFtp.gate), so the files in flight always finish first.
 */
export class OpControl {
  cancelled = false;
  paused = false;
  /** Whether the latest pause or resume has been logged, so several parallel workers do not repeat it. */
  private noted = false;
  private waiters: Array<() => void> = [];

  pause(): void {
    if (this.cancelled) return;
    this.paused = true;
    this.noted = false;
  }

  resume(): void {
    this.paused = false;
    this.noted = false;
    this.wake();
  }

  cancel(): void {
    this.cancelled = true;
    this.paused = false;
    this.wake();
  }

  /** True for the first worker to notice a state change; the others keep quiet. */
  claimNote(): boolean {
    if (this.noted) return false;
    this.noted = true;
    return true;
  }

  /** Resolves on resume or cancel, or after ms so a waiting worker can keep its connection alive. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      timer = setTimeout(done, ms);
      timer.unref?.();
      this.waiters.push(done);
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

export const CANCELLED_MESSAGE = "Cancelled in the coolFTP app";
