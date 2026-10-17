/*
 * Config folder tests (Windows): the built CLI keeps its config in %USERPROFILE%\.coolftp and
 * moves an existing %APPDATA%\coolftp there on first run, including sites that only exist in a
 * packaged app's sandboxed copy (the Claude desktop app is an MSIX package). Runs against fake
 * USERPROFILE, APPDATA and LOCALAPPDATA folders, never the real ones.
 *   node scripts/config/test.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

if (process.platform !== "win32") {
  console.log("config: skipped (Windows only)");
  process.exit(0);
}

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "packages", "cli", "dist", "coolftp.js");

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra && !cond ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
};
const site = (name) => ({ name, protocol: "sftp", host: `${name.toLowerCase()}.example.com`, port: 22, username: "u", remoteRoot: "/" });

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coolftp-cfg-"));
  const dirs = {
    root,
    home: path.join(root, "home"),
    appdata: path.join(root, "home", "AppData", "Roaming"),
    local: path.join(root, "home", "AppData", "Local"),
  };
  dirs.legacy = path.join(dirs.appdata, "coolftp");
  dirs.shadow = path.join(dirs.local, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "coolftp");
  dirs.config = path.join(dirs.home, ".coolftp");
  for (const d of [dirs.home, dirs.appdata, dirs.local]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, USERPROFILE: dirs.home, HOME: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.local, NO_COLOR: "1" };
  delete env.COOLFTP_HOME;
  dirs.cli = (args, extraEnv = {}) =>
    JSON.parse(execFileSync("node", [CLI, "--direct", "--json", ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", cwd: root }));
  return dirs;
}
const names = (sites) => sites.map((s) => s.name).sort().join(",");

console.log("config: migration from %APPDATA% with a stale sandboxed copy");
{
  const t = sandbox();
  write(path.join(t.legacy, "sites.json"), { sites: [site("coolFTP"), site("Blog")] });
  write(path.join(t.legacy, "history", "coolftp.json"), [{ id: "real" }]);
  write(path.join(t.legacy, "hub.json"), { port: 1, token: "x", pid: 1 });
  // The sandboxed copy is stale: it predates "Blog" and has its own older history.
  write(path.join(t.shadow, "sites.json"), { sites: [site("coolFTP"), site("SandboxOnly")] });
  write(path.join(t.shadow, "history", "coolftp.json"), [{ id: "stale" }]);
  write(path.join(t.shadow, "history", "sandboxonly.json"), [{ id: "sbx" }]);

  const sites = t.cli(["site", "list"]);
  check("real sites plus sandbox-only sites are listed", names(sites) === "Blog,SandboxOnly,coolFTP", names(sites));
  check("config lives in %USERPROFILE%\\.coolftp", fs.existsSync(path.join(t.config, "sites.json")));
  const hist = JSON.parse(fs.readFileSync(path.join(t.config, "history", "coolftp.json"), "utf8"));
  check("history comes from the real folder, not the stale copy", hist[0]?.id === "real", JSON.stringify(hist));
  check("history only in the sandboxed copy is kept", fs.existsSync(path.join(t.config, "history", "sandboxonly.json")));
  check("hub.json is not copied", !fs.existsSync(path.join(t.config, "hub.json")));
  check("legacy folder is left in place", fs.existsSync(path.join(t.legacy, "sites.json")));
  const pkgCache = path.dirname(t.shadow);
  const baks = fs.readdirSync(pkgCache).filter((n) => n.startsWith("coolftp.sandbox-bak-"));
  check("sandboxed copy is moved aside", !fs.existsSync(t.shadow) && baks.length === 1, fs.readdirSync(pkgCache).join(","));
  check("migration marker is written", fs.existsSync(path.join(t.config, "migrated.json")));

  // A later change to the old folder (an old app still writing there) does not re-run migration.
  write(path.join(t.legacy, "sites.json"), { sites: [site("coolFTP"), site("Blog"), site("Later")] });
  check("migration runs once", names(t.cli(["site", "list"])) === "Blog,SandboxOnly,coolFTP");

  const status = t.cli(["status"]);
  check("status reports the new config folder", status.configDir === t.config, status.configDir);
  check("status has no sandbox note once migrated", !status.note, status.note);

  // An older coolFTP inside the package writes a fresh sandboxed copy after migration.
  write(path.join(t.shadow, "sites.json"), { sites: [site("Stale")] });
  const again = t.cli(["status"]);
  check("a new sandboxed copy gets a note", typeof again.note === "string" && again.note.includes(t.config), again.note);
  check("the note does not send the user to the app", !/open the app/i.test(again.note || ""), again.note);
  check("the new sandboxed copy is not read", names(t.cli(["site", "list"])) === "Blog,SandboxOnly,coolFTP");
}

console.log("config: sandbox-only user (no real %APPDATA% config)");
{
  const t = sandbox();
  write(path.join(t.shadow, "sites.json"), { sites: [site("OnlyHere")] });
  check("sites from the sandboxed copy are migrated", names(t.cli(["site", "list"])) === "OnlyHere");
}

console.log("config: fresh install");
{
  const t = sandbox();
  check("no sites", t.cli(["site", "list"]).length === 0);
  check("config folder created", fs.existsSync(t.config));
}

console.log("config: COOLFTP_HOME overrides everything");
{
  const t = sandbox();
  write(path.join(t.legacy, "sites.json"), { sites: [site("Legacy")] });
  const custom = path.join(t.root, "custom");
  check("no migration into COOLFTP_HOME", t.cli(["site", "list"], { COOLFTP_HOME: custom }).length === 0);
  check("home folder untouched", !fs.existsSync(t.config));
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
