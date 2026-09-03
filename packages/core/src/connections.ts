import type { Site, Transport } from "./types.js";
import { SftpTransport } from "./sftp.js";
import { FtpTransport } from "./ftp.js";
import type { Events } from "./events.js";

export function createTransport(site: Site): Transport {
  return site.protocol === "sftp" ? new SftpTransport(site) : new FtpTransport(site);
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
      slot = { transport: createTransport(site), site };
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
