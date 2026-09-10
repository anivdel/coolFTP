import type { Site, Transport } from "./types.js";
import { SftpTransport } from "./sftp.js";
import { FtpTransport } from "./ftp.js";
import type { Events } from "./events.js";

export function createTransport(site: Site, events?: Events): Transport {
  const log = (message: string, level: "info" | "warn" | "error" | "success" = "info") => events?.log(message, level);
  return site.protocol === "sftp" ? new SftpTransport(site, log) : new FtpTransport(site);
}

interface Slot {
  transport: Transport;
  site: Site;
  idle?: NodeJS.Timeout;
  connecting?: Promise<void>;
}

/**
 * Keeps one live connection per site and closes it after a period of inactivity.
 * The desktop app and the CLI both go through this so an agent-driven deploy reuses
 * the connection the user already opened in the UI.
 */
export class ConnectionPool {
  private slots = new Map<string, Slot>();
  constructor(private idleMs = 90_000) {}

  async acquire(site: Site, events?: Events): Promise<Transport> {
    const key = site.name.toLowerCase();
    let slot = this.slots.get(key);
    if (!slot || JSON.stringify(slot.site) !== JSON.stringify(site)) {
      if (slot) await slot.transport.close().catch(() => undefined);
      slot = { transport: createTransport(site, events), site };
      this.slots.set(key, slot);
    }
    if (slot.idle) clearTimeout(slot.idle);
    if (!slot.transport.isConnected()) {
      if (!slot.connecting) {
        events?.emit({ type: "connect", site: site.name, status: "connecting" });
        slot.connecting = slot.transport
          .connect()
          .then(() => events?.emit({ type: "connect", site: site.name, status: "connected" }))
          .catch((err) => {
            events?.emit({ type: "connect", site: site.name, status: "error", error: String(err?.message || err) });
            throw err;
          })
          .finally(() => {
            slot!.connecting = undefined;
          });
      }
      await slot.connecting;
    }
    this.touch(key);
    return slot.transport;
  }

  /**
   * Extra connections to a site for parallel transfers, on top of the pooled one. Servers cap
   * concurrent logins, so a connection that cannot be opened is skipped with a warning instead
   * of failing the operation. Hand them back with releaseExtras when the transfers are done.
   */
  async acquireExtras(site: Site, count: number, events?: Events): Promise<Transport[]> {
    const extras: Transport[] = [];
    for (let i = 0; i < count; i++) {
      const t = createTransport(site, events);
      try {
        await t.connect();
        extras.push(t);
      } catch (err) {
        events?.log(
          `Could not open connection ${extras.length + 2} to ${site.host}: ${String((err as Error)?.message || err)}. Continuing with ${extras.length + 1}.`,
          "warn",
        );
        break;
      }
    }
    return extras;
  }

  async releaseExtras(extras: Transport[]): Promise<void> {
    for (const t of extras) await t.close().catch(() => undefined);
  }

  /** Reset the idle timer; call after each operation. */
  touch(name: string): void {
    const slot = this.slots.get(name.toLowerCase());
    if (!slot) return;
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = setTimeout(() => {
      slot.transport.close().catch(() => undefined);
      this.slots.delete(name.toLowerCase());
    }, this.idleMs);
    slot.idle.unref?.();
  }

  /**
   * Reset the idle timer for whichever site owns this transport. Long commands
   * (a deploy of thousands of files) hold one transport for minutes, so they
   * call this per file; otherwise the timer armed by acquire() fires mid-task
   * and the transfer dies with "User closed client during task".
   */
  touchTransport(t: Transport): void {
    for (const [key, slot] of this.slots) {
      if (slot.transport === t) {
        this.touch(key);
        return;
      }
    }
  }

  status(): Array<{ site: string; connected: boolean; protocol: string }> {
    return [...this.slots.values()].map((s) => ({
      site: s.site.name,
      connected: s.transport.isConnected(),
      protocol: s.transport.protocol,
    }));
  }

  async disconnect(name: string): Promise<void> {
    const slot = this.slots.get(name.toLowerCase());
    if (!slot) return;
    if (slot.idle) clearTimeout(slot.idle);
    await slot.transport.close().catch(() => undefined);
    this.slots.delete(name.toLowerCase());
  }

  async closeAll(): Promise<void> {
    for (const key of [...this.slots.keys()]) await this.disconnect(key);
  }
}
