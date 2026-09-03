import type { CoolFtp } from "./commands.js";
import type { Events } from "./events.js";
import type { ProjectConfig, Site } from "./types.js";
import { activateLicense, getLicenseStatus, removeLicense } from "./license.js";

/**
 * A single string-keyed dispatch table so that the CLI (direct mode), the desktop app's
 * local hub, and the MCP server all expose exactly the same operations.
 */
type Handler = (cf: CoolFtp, args: Record<string, any>, events: Events) => Promise<unknown> | unknown;

export const RPC_METHODS: Record<string, Handler> = {
  sites: (cf) => cf.sites(),
  addSite: (cf, a) => cf.addSite(a.site as Site),
  removeSite: (cf, a) => cf.removeSite(a.name),
  test: (cf, a, ev) => cf.test(a.site, ev),
  ls: (cf, a, ev) => cf.ls(a.site, a.path, ev),
  stat: (cf, a) => cf.stat(a.site, a.path),
  read: (cf, a) => cf.read(a.site, a.path, a.maxBytes),
  write: (cf, a, ev) => cf.write(a.site, a.path, a.content, ev),
  mkdir: (cf, a, ev) => cf.mkdir(a.site, a.path, ev),
  remove: (cf, a, ev) => cf.remove(a.site, a.path, ev),
  rename: (cf, a, ev) => cf.rename(a.site, a.from, a.to, ev),
  upload: (cf, a, ev) => cf.upload(a.site, a.local, a.remote, ev),
  download: (cf, a, ev) => cf.download(a.site, a.remote, a.local, ev),
  init: (cf, a) => cf.init(a.cwd, a.config as ProjectConfig),
  project: (cf, a) => cf.project(a.cwd, a.site),
  diff: (cf, a, ev) => cf.diff(a.cwd, { site: a.site, force: a.force }, ev),
  deploy: (cf, a, ev) => cf.deploy(a.cwd, a.options ?? {}, ev),
  history: (cf, a) => cf.history(a.site, a.limit),
  rollback: (cf, a, ev) => cf.rollback(a.cwd, { site: a.site, to: a.to, build: a.build, message: a.message }, ev),
  hostKeys: (cf) => cf.hostKeys(),
  trustSite: (cf, a) => cf.trustSite(a.site),
  license: () => getLicenseStatus(),
  activateLicense: (_cf, a) => activateLicense(String(a.key ?? "")),
  removeLicense: () => ({ removed: removeLicense(), status: getLicenseStatus() }),
  connections: (cf) => cf.pool.status(),
  disconnect: (cf, a) => cf.pool.disconnect(a.site),
};

export type RpcMethod = keyof typeof RPC_METHODS;

export async function dispatch(cf: CoolFtp, method: string, args: Record<string, any>, events: Events): Promise<unknown> {
  const h = RPC_METHODS[method];
  if (!h) throw new Error(`Unknown method: ${method}`);
  return h(cf, args ?? {}, events);
}
