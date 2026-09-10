/*
 * End-to-end tests: spin up local FTP and SFTP servers in temp directories and drive
 * the built coolftp CLI through the full deploy workflow against each, including
 * the first-deploy delete guard, git-based rollback, undo from server-side backups,
 * live verification against a local web server, encrypted passwords, SSH host key
 * pinning, and the MCP server over stdio.
 *   npm run build && npm run e2e
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { execFile, execFileSync, spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "coolftp.js");
const { FtpSrv } = require("ftp-srv");
const { startSftpServer } = require("./lib/sftp-server.cjs");

let failures = 0;
function check(name, cond, extra) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra && !cond ? "  " + extra : ""}`);
  if (!cond) failures++;
}

const GIT_ENV = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@coolftp.local", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@coolftp.local" };
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function makeProject(tmp) {
  const PROJECT = path.join(tmp, "project");
  fs.mkdirSync(path.join(PROJECT, "css"), { recursive: true });
  fs.mkdirSync(path.join(PROJECT, "node_modules", "junk"), { recursive: true });
  fs.mkdirSync(path.join(PROJECT, "empty"), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, "index.html"), "<h1>hello coolFTP</h1>");
  fs.writeFileSync(path.join(PROJECT, "css", "style.css"), "body{color:red}");
  fs.writeFileSync(path.join(PROJECT, "node_modules", "junk", "x.js"), "ignored");
  fs.writeFileSync(path.join(PROJECT, "empty", ".gitkeep"), "");
  fs.writeFileSync(path.join(PROJECT, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(PROJECT, "notes.md"), "private");
  fs.writeFileSync(path.join(PROJECT, ".coolftpignore"), "notes.md\n");
  // A binary file large enough to need several SFTP chunks.
  fs.writeFileSync(path.join(PROJECT, "big.bin"), Buffer.alloc(300 * 1024, 7));
  git(PROJECT, "init", "-q", "-b", "main");
  git(PROJECT, "add", "-A");
  git(PROJECT, "commit", "-q", "-m", "v1");
  return PROJECT;
}

/** A plain static web server over the deployed folder, so verification has something to fetch. */
function serveStatic(root, port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      fs.readFile(path.join(root, p), (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not here");
        } else {
          res.writeHead(200);
          res.end(data);
        }
      });
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

async function suite(label, { protocol, port, webPort, serverRoot, tmp, afterDeploys }) {
  console.log(`\n${label}`);
  const PROJECT = makeProject(tmp);
  const HOME = path.join(tmp, "home");
  const env = { ...process.env, ...GIT_ENV, COOLFTP_HOME: HOME, NO_COLOR: "1", COOLFTP_AGENT: "e2e" };
  const cliFull = (args, opts = {}) =>
    new Promise((resolve) => {
      execFile("node", [CLI, "--direct", ...args], { cwd: opts.cwd || PROJECT, env: { ...env, ...(opts.env || {}) }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
    });
  const cli = async (args, opts) => {
    const r = await cliFull(args, opts);
    if (r.code) throw Object.assign(new Error(`exit ${r.code}`), r);
    return r.stdout;
  };
  const cliJson = async (args, opts) => JSON.parse(await cli(["--json", ...args], opts));
  const cliFails = async (args, opts) => {
    try {
      await cli(args, opts);
      return null;
    } catch (e) {
      return (e.stderr || "") + (e.stdout || "");
    }
  };
  const remote = (...p) => path.join(serverRoot, "public_html", ...p);
  const manifest = () => JSON.parse(fs.readFileSync(remote(".coolftp", "manifest.json"), "utf8"));
  const ctx = { cli, cliJson, cliFails, cliFull, PROJECT, HOME, remote, env };
  let deploys = 0;

  try {
    await cli(["site", "add", "demo", "--host", "127.0.0.1", "--user", "demo", "--password", "secret", "--protocol", protocol, "--port", String(port), "--root", "/public_html"]);
    const sites = await cliJson(["site", "list"]);
    check("site saved without leaking password", sites.length === 1 && sites[0].remoteRoot === "/public_html" && sites[0].hasPassword === true && !("password" in sites[0]));
    const raw = fs.readFileSync(path.join(HOME, "sites.json"), "utf8");
    check("password encrypted at rest (windows)", process.platform !== "win32" || (raw.includes('"password": "dpapi:') && !raw.includes("secret")), raw);

    const test = await cliJson(["site", "test", "demo"]);
    check("site test connects", test.ok === true && test.protocol === protocol, JSON.stringify(test));

    const init = await cliJson(["init", "demo"]);
    check("init writes .coolftp.json", fs.existsSync(path.join(PROJECT, ".coolftp.json")), init.file);
    // Commit the link file so the tree is clean; a deploy should then record dirty === false.
    git(PROJECT, "add", "-A");
    git(PROJECT, "commit", "-q", "-m", "link site");

    // A file that lives on the server but was never uploaded by coolFTP.
    fs.writeFileSync(remote("legacy.txt"), "left here by the old workflow");
    const guard = await cliFails(["deploy", "--delete"]);
    check("first deploy refuses --delete over untracked files", guard !== null && /Refusing --delete/.test(guard) && /legacy\.txt/.test(guard), guard);
    check("legacy file survived the refusal", fs.existsSync(remote("legacy.txt")));

    const dry = await cliJson(["deploy", "--dry-run"]);
    check("dry run basis fresh->listing", dry.dryRun === true && dry.plan.basis === "listing", dry.plan.basis);
    check("dry run plans 3 files", dry.plan.add.length === 3 && dry.plan.add.includes("index.html") && dry.plan.add.includes("css/style.css") && dry.plan.add.includes("big.bin"), JSON.stringify(dry.plan.add));
    check("ignored files excluded", !dry.plan.add.some((f) => f.includes("node_modules") || f === ".env" || f === "notes.md" || f === ".coolftpignore" || f.endsWith(".gitkeep")), JSON.stringify(dry.plan.add));

    const dep1 = await cliJson(["deploy", "-m", "first"]);
    deploys++;
    check("deploy uploads 3", dep1.record && dep1.record.added === 3, JSON.stringify(dep1.record));
    check("deploy records git commit", dep1.record.git && dep1.record.git.branch === "main" && dep1.record.git.dirty === false, JSON.stringify(dep1.record.git));
    check("deploy records where it went", dep1.record.remoteRoot === "/public_html" && dep1.record.connections === 1, JSON.stringify([dep1.record.remoteRoot, dep1.record.connections]));
    check("remote index.html content", fs.readFileSync(remote("index.html"), "utf8") === "<h1>hello coolFTP</h1>");
    check("remote big.bin intact", fs.existsSync(remote("big.bin")) && fs.readFileSync(remote("big.bin")).equals(Buffer.alloc(300 * 1024, 7)));
    check("manifest written", fs.existsSync(remote(".coolftp", "manifest.json")));
    check("manifest htaccess", fs.existsSync(remote(".coolftp", ".htaccess")));
    check("legacy file untouched by normal deploy", fs.existsSync(remote("legacy.txt")));

    const dep2 = await cliJson(["deploy"]);
    deploys++;
    check("second deploy is a no-op", dep2.record.added === 0 && dep2.record.changed === 0 && !dep2.record.backup, JSON.stringify(dep2.record));

    fs.writeFileSync(path.join(PROJECT, "index.html"), "<h1>hello coolFTP v2</h1>");
    fs.writeFileSync(path.join(PROJECT, "app.js"), "console.log(1)");
    fs.unlinkSync(path.join(PROJECT, "css", "style.css"));
    const diff = await cliJson(["diff"]);
    check("diff basis manifest", diff.plan.basis === "manifest", diff.plan.basis);
    check("diff detects change/add/delete", diff.plan.change.includes("index.html") && diff.plan.add.includes("app.js") && diff.plan.delete.includes("css/style.css") && diff.plan.unchanged === 1, JSON.stringify(diff.plan));

    const dep3full = await cliFull(["--json", "deploy", "--delete", "--commit", "-m", "v2"]);
    const dep3 = JSON.parse(dep3full.stdout);
    deploys++;
    check("changed files are reported by their real path, not the temp name", dep3full.code === 0 && dep3full.stderr.includes("↑ /public_html/index.html ") && !dep3full.stderr.includes("coolftp-tmp"), dep3full.stderr);
    check("deploy --commit --delete", dep3.record.added === 1 && dep3.record.changed === 1 && dep3.record.deleted === 1, JSON.stringify(dep3.record));
    check("--commit made a git commit", git(PROJECT, "log", "--oneline").split("\n").length === 3 && git(PROJECT, "log", "-1", "--format=%s") === "v2");
    check("remote css removed", !fs.existsSync(remote("css", "style.css")));
    check("remote index updated", fs.readFileSync(remote("index.html"), "utf8").includes("v2"));
    check("legacy file survives manifest-based --delete", fs.existsSync(remote("legacy.txt")));

    // The deploy set the previous versions aside on the server, so it can be undone without git.
    const b3 = dep3.record.backup;
    check("deploy kept a backup", b3 && "index.html" in b3.changed && "css/style.css" in b3.deleted && b3.added.includes("app.js"), JSON.stringify(b3));
    check("backup holds the previous index.html", fs.existsSync(remote(".coolftp", "backup", dep3.record.id, "index.html")) && fs.readFileSync(remote(".coolftp", "backup", dep3.record.id, "index.html"), "utf8") === "<h1>hello coolFTP</h1>");
    check("backup holds the deleted css", fs.existsSync(remote(".coolftp", "backup", dep3.record.id, "css", "style.css")));
    check("no temp files left beside the live copies", !fs.readdirSync(remote()).some((f) => f.includes(".coolftp-tmp")), fs.readdirSync(remote()).join(","));
    const undoDry = await cliJson(["undo", "--dry-run"]);
    check("undo --dry-run lists the work and changes nothing", undoDry.dryRun === true && undoDry.plan.change.includes("index.html") && undoDry.plan.add.includes("css/style.css") && undoDry.plan.delete.includes("app.js") && fs.readFileSync(remote("index.html"), "utf8").includes("v2"), JSON.stringify(undoDry.plan));
    const undone = await cliJson(["undo"]);
    deploys++;
    check("undo restored index.html", fs.readFileSync(remote("index.html"), "utf8") === "<h1>hello coolFTP</h1>");
    check("undo put back the deleted css", fs.existsSync(remote("css", "style.css")) && fs.readFileSync(remote("css", "style.css"), "utf8") === "body{color:red}");
    check("undo removed the added app.js", !fs.existsSync(remote("app.js")));
    check("undo recorded", undone.record.undoOf === dep3.record.id && undone.record.changed === 1 && undone.record.added === 1 && undone.record.deleted === 1, JSON.stringify(undone.record));
    check("undo consumed the backup folder", !fs.existsSync(remote(".coolftp", "backup", dep3.record.id)));
    const diffAfterUndo = await cliJson(["diff"]);
    check("manifest reflects the undo", diffAfterUndo.plan.change.includes("index.html") && diffAfterUndo.plan.add.includes("app.js") && diffAfterUndo.plan.delete.includes("css/style.css"), JSON.stringify(diffAfterUndo.plan));
    const redone = await cliJson(["undo"]);
    deploys++;
    check("undoing the undo restores v2", redone.record.undoOf === undone.record.id && fs.readFileSync(remote("index.html"), "utf8").includes("v2") && fs.existsSync(remote("app.js")) && !fs.existsSync(remote("css", "style.css")), JSON.stringify(redone.record));
    const diffAfterRedo = await cliJson(["diff"]);
    check("remote up to date after the redo", diffAfterRedo.plan.add.length === 0 && diffAfterRedo.plan.change.length === 0 && diffAfterRedo.plan.delete.length === 0, JSON.stringify(diffAfterRedo.plan));
    const undoOld = await cliFails(["undo", "--to", dep3.record.id]);
    check("an older deploy whose files moved on cannot be undone", undoOld !== null && /cannot be undone|Cannot undo/.test(undoOld), undoOld);

    // Rollback to the previous live commit (v1) restores css and removes app.js.
    const rb = await cliJson(["rollback"]);
    deploys++;
    check("rollback targets v1", rb.commit === git(PROJECT, "rev-parse", "HEAD~1"), rb.commit);
    check("rollback restored index.html", fs.readFileSync(remote("index.html"), "utf8") === "<h1>hello coolFTP</h1>");
    check("rollback restored css", fs.existsSync(remote("css", "style.css")));
    check("rollback removed app.js", !fs.existsSync(remote("app.js")));
    check("working tree untouched by rollback", fs.readFileSync(path.join(PROJECT, "index.html"), "utf8").includes("v2") && fs.existsSync(path.join(PROJECT, "app.js")));
    check("no leftover worktrees", git(PROJECT, "worktree", "list").split("\n").length === 1);
    const histAfterRb = await cliJson(["history"]);
    check("rollback recorded", histAfterRb[0].rollbackOf === rb.commit && histAfterRb[0].git.commit === rb.commit, JSON.stringify(histAfterRb[0]));

    // Roll forward again to a specific deploy id.
    const v2deploy = histAfterRb.find((h) => h.message === "v2");
    const rf = await cliJson(["rollback", "--to", v2deploy.id]);
    deploys++;
    check("rollback --to deploy id", rf.commit === v2deploy.git.commit && fs.readFileSync(remote("index.html"), "utf8").includes("v2") && fs.existsSync(remote("app.js")));

    const ls = await cliJson(["ls"]);
    check("ls lists remote root", ls.path === "/public_html" && ls.entries.some((e) => e.name === "app.js") && ls.entries.find((e) => e.name === "css").type === "dir", JSON.stringify(ls.entries));
    const cat = await cliJson(["cat", "app.js"]);
    check("cat reads file", cat.content === "console.log(1)");
    const st = await cliJson(["stat", "app.js"]);
    check("stat reports the file", st.exists === true && st.type === "file" && st.size === "console.log(1)".length, JSON.stringify(st));
    const missing = await cliFails(["stat", "nope.txt"]);
    check("stat fails for a missing path", missing !== null && /not found/.test(missing), missing);

    fs.writeFileSync(path.join(tmp, "extra.txt"), "extra");
    const pushed = await cliFull(["--json", "push", path.join(tmp, "extra.txt"), "uploads/extra.txt"]);
    const pushRes = JSON.parse(pushed.stdout);
    check("push creates parent dir", pushed.code === 0 && fs.existsSync(remote("uploads", "extra.txt")), pushed.stderr);
    check("push reports the folder it created and warns", pushRes.createdDirs.includes("/public_html/uploads") && /new top-level folder uploads\//.test(pushed.stderr), pushed.stderr);
    check("push size confirmed and recorded in the manifest", pushRes.verified === 1 && pushRes.recorded === 1 && manifest().files["uploads/extra.txt"], JSON.stringify(pushRes));
    // A file pushed inside the project belongs in the manifest, or the next deploy would send it again.
    fs.writeFileSync(path.join(PROJECT, "pushed.txt"), "pushed outside a deploy");
    const pushIn = await cliJson(["push", "pushed.txt", "pushed.txt"]);
    check("push inside the project is recorded in the manifest", pushIn.recorded === 1 && manifest().files["pushed.txt"] && manifest().files["pushed.txt"].size === "pushed outside a deploy".length, JSON.stringify(pushIn));
    const diffAfterPush = await cliJson(["diff"]);
    check("diff does not plan a pushed file again", !diffAfterPush.plan.add.includes("pushed.txt") && !diffAfterPush.plan.change.includes("pushed.txt"), JSON.stringify(diffAfterPush.plan));
    await cliJson(["mv", "uploads/extra.txt", "uploads/renamed.txt"]);
    check("mv renames", fs.existsSync(remote("uploads", "renamed.txt")));
    const pullDir = path.join(tmp, "pulled");
    fs.mkdirSync(pullDir);
    await cliJson(["pull", "uploads", pullDir]);
    check("pull downloads dir", fs.existsSync(path.join(pullDir, "renamed.txt")));
    const pulledBig = path.join(tmp, "big-pulled.bin");
    await cliJson(["pull", "big.bin", pulledBig]);
    check("pull downloads big file intact", fs.existsSync(pulledBig) && fs.readFileSync(pulledBig).equals(Buffer.alloc(300 * 1024, 7)));
    await cliJson(["mkdir", "a/b/c"]);
    check("mkdir -p", fs.existsSync(remote("a", "b", "c")));
    await cliJson(["rm", "uploads"]);
    check("rm removes dir", !fs.existsSync(remote("uploads")));

    // Thirty files at once: FTP opens extra connections, SFTP multiplexes one.
    fs.mkdirSync(path.join(PROJECT, "many"));
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(PROJECT, "many", `f${i}.txt`), `file ${i}`);
    const many = await cliFull(["--json", "deploy", "-m", "many"]);
    deploys++;
    const manyRes = JSON.parse(many.stdout);
    check("30 files deployed", many.code === 0 && manyRes.record.added === 30 && fs.readFileSync(remote("many", "f29.txt"), "utf8") === "file 29", many.stderr);
    check(protocol === "ftp" ? "four FTP connections were used" : "SFTP used one connection", manyRes.record.connections === (protocol === "ftp" ? 4 : 1), String(manyRes.record.connections));
    check("big jobs print progress lines, not one line per file", /files ·/.test(many.stderr) && !/↑ \/public_html\/many\/f5\.txt/.test(many.stderr), many.stderr);

    // Backups are pruned to the configured count.
    await cliJson(["init", "demo", "--keep-backups", "2"]);
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(PROJECT, "index.html"), `<h1>hello coolFTP v2 edit ${i}</h1>`);
      ids.push((await cliJson(["deploy", "-m", `edit ${i}`])).record.id);
      deploys++;
    }
    const backupDirs = fs.readdirSync(remote(".coolftp", "backup"));
    check("old backups are pruned to keepBackups", backupDirs.length === 2 && backupDirs.includes(ids[1]) && backupDirs.includes(ids[2]) && !backupDirs.includes(ids[0]), backupDirs.join(","));
    check("a pruned deploy loses its undo marker", !manifest().deploys.find((d) => d.id === ids[0]).backup && (await cliJson(["history"])).find((d) => d.id === ids[0]).backup === undefined);

    // Live checks against a local web server over the deployed folder.
    const web = await serveStatic(remote(), webPort);
    try {
      await cliJson(["init", "demo", "--url", `http://127.0.0.1:${webPort}`]);
      fs.writeFileSync(path.join(PROJECT, "css", "style.css"), "body{color:blue}");
      const verified = await cliJson(["deploy", "-m", "verified"]);
      deploys++;
      check("deploy verified the live site", verified.verify && verified.verify.ok === true && verified.verify.stale === 0 && verified.verify.checks[0].status === 200, JSON.stringify(verified.verify));
      check("static file content confirmed", verified.verify.checks.some((c) => c.url.endsWith("/css/style.css") && c.content === "match"), JSON.stringify(verified.verify.checks));
      check("verify result stored in history", (await cliJson(["history"]))[0].verify.ok === true);
      // Something between the server and the world still serves the old bytes.
      fs.writeFileSync(remote("css", "style.css"), "body{color:red}");
      const stale = await cliFull(["--json", "verify"]);
      const staleRes = JSON.parse(stale.stdout);
      check("verify flags a stale copy without failing", stale.code === 0 && staleRes.ok === true && staleRes.stale === 1, stale.stdout + stale.stderr);
      check("verify accepts explicit paths", (await cliJson(["verify", "css/style.css"])).checks.some((c) => c.url === `http://127.0.0.1:${webPort}/css/style.css`));
      // Nothing answers at all.
      await cliJson(["init", "demo", "--url", "http://127.0.0.1:1"]);
      const dead = await cliFull(["--json", "verify"]);
      check("verify exits 3 when the site does not answer", dead.code === 3 && JSON.parse(dead.stdout).ok === false, `${dead.code} ${dead.stdout}`);
      fs.writeFileSync(path.join(PROJECT, "index.html"), "<h1>unreachable</h1>");
      const deadDeploy = await cliFull(["--json", "deploy", "-m", "unreachable"]);
      deploys++;
      const deadRes = JSON.parse(deadDeploy.stdout);
      check("deploy exits 3 when verification fails, files still landed", deadDeploy.code === 3 && deadRes.record && deadRes.verify.ok === false && fs.readFileSync(remote("index.html"), "utf8").includes("unreachable"), `${deadDeploy.code}`);
      fs.writeFileSync(path.join(PROJECT, "index.html"), "<h1>quiet</h1>");
      const quiet = await cliFull(["-q", "deploy", "-m", "quiet"]);
      deploys++;
      check("quiet deploy still prints the result and the verdict", quiet.code === 3 && /Deployed to demo/.test(quiet.stderr) && /verification failed: http:\/\/127\.0\.0\.1:1\/ answered/.test(quiet.stdout) && !/↑/.test(quiet.stderr) && !/Scanning/.test(quiet.stderr), quiet.stderr + quiet.stdout);
      await cliJson(["init", "demo"]);
    } finally {
      web.close();
    }

    const hist = await cliJson(["history"]);
    check(`history has ${deploys} deploys`, hist.length === deploys && hist[0].agent === "e2e", JSON.stringify(hist.map((h) => h.message)));

    // A project that deploys into a sub-directory of the site root, served at its own URL.
    // Browsing commands must follow that directory, and URLs must not include the FTP path.
    await cliJson(["init", "demo", "--remote-root", "/public_html/app", "--url", "https://example.test/app/"]);
    const linked = JSON.parse(fs.readFileSync(path.join(PROJECT, ".coolftp.json"), "utf8"));
    check("init stores remoteRoot and url", linked.remoteRoot === "/public_html/app" && linked.url === "https://example.test/app", JSON.stringify(linked));
    const dryApp = await cliJson(["deploy", "--dry-run"]);
    check("dry run urls use the project url", dryApp.urls.length > 0 && dryApp.urls.every((u) => u === "https://example.test/app" || u.startsWith("https://example.test/app/")) && !dryApp.urls.some((u) => u.includes("public_html")), JSON.stringify(dryApp.urls));
    await cliJson(["push", path.join(tmp, "extra.txt"), "js/extra.txt"]);
    check("push lands under the project remoteRoot", fs.existsSync(remote("app", "js", "extra.txt")) && !fs.existsSync(remote("js", "extra.txt")));
    const lsApp = await cliJson(["ls"]);
    check("ls defaults to the project remoteRoot", lsApp.path === "/public_html/app" && lsApp.entries.some((e) => e.name === "js"), JSON.stringify(lsApp));
    const lsAbs = await cliJson(["ls", "/public_html"]);
    check("absolute paths still reach the site root", lsAbs.path === "/public_html" && lsAbs.entries.some((e) => e.name === "app"), JSON.stringify(lsAbs.path));
    const catApp = await cliJson(["cat", "js/extra.txt"]);
    check("cat follows the project remoteRoot", catApp.content === "extra");
    await cliJson(["mv", "js/extra.txt", "js/moved.txt"]);
    check("mv follows the project remoteRoot", fs.existsSync(remote("app", "js", "moved.txt")));
    await cliJson(["rm", "js"]);
    check("rm follows the project remoteRoot", !fs.existsSync(remote("app", "js")));
    const winPath = await cliFails(["ls", "D:/Program Files/Git/public_html"]);
    check("a Windows path is refused as a remote path", winPath !== null && /looks like a Windows path/.test(winPath), winPath);
    const unmangled = await cliJson(["ls", "C:/Program Files/Git/public_html"], { env: { EXEPATH: "C:\\Program Files\\Git" } });
    check("Git Bash path mangling is undone", unmangled.path === "/public_html", unmangled.path);
    await cliJson(["init", "demo"]);

    if (afterDeploys) await afterDeploys(ctx);

    const rm = await cliJson(["site", "remove", "demo"]);
    check("site removed", rm.removed === true);
  } catch (e) {
    failures++;
    console.log("  FAIL  exception:", e.stderr || e.stdout || e.message);
  }
}

/** Drive `coolftp mcp` over stdio the way Claude Code does: initialize, list tools, call a few. */
async function mcpSmoke({ PROJECT, env }) {
  console.log("\nMCP server over stdio");
  const child = spawn("node", [CLI, "--direct", "mcp"], { cwd: PROJECT, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* not json */
      }
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 30000);
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  try {
    const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
    check("mcp initializes", init.result && init.result.serverInfo && init.result.serverInfo.name === "coolftp", JSON.stringify(init));
    notify("notifications/initialized", {});
    const tools = await request("tools/list", {});
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    check("mcp lists the new tools", ["coolftp_undo", "coolftp_verify", "coolftp_stat", "coolftp_deploy"].every((n) => names.includes(n)), names.join(","));
    const status = await request("tools/call", { name: "coolftp_status", arguments: { cwd: PROJECT } });
    const statusText = status.result?.content?.[0]?.text ?? "";
    check("mcp status reports direct mode", /"mode": "direct"/.test(statusText) && /"running": false/.test(statusText), statusText);
    const diff = await request("tools/call", { name: "coolftp_diff", arguments: { cwd: PROJECT } });
    const diffText = diff.result?.content?.[0]?.text ?? "";
    check("mcp diff returns a compact plan", /"counts"/.test(diffText) && /"basis": "manifest"/.test(diffText), diffText.slice(0, 300));
    const stat = await request("tools/call", { name: "coolftp_stat", arguments: { cwd: PROJECT, path: "app.js" } });
    check("mcp stat finds a file", /"exists": true/.test(stat.result?.content?.[0]?.text ?? ""), JSON.stringify(stat));
    const undo = await request("tools/call", { name: "coolftp_undo", arguments: { cwd: PROJECT, dryRun: true } });
    const undoText = undo.result?.content?.[0]?.text ?? "";
    check("mcp undo dry run describes the work", /"dryRun": true/.test(undoText) && /undoOf/.test(undoText), undoText.slice(0, 300));
  } catch (e) {
    failures++;
    console.log("  FAIL  exception:", e.message);
  } finally {
    child.kill();
  }
}

(async () => {
  // FTP
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coolftp-e2e-ftp-"));
    const serverRoot = path.join(tmp, "server");
    fs.mkdirSync(path.join(serverRoot, "public_html"), { recursive: true });
    const noop = () => undefined;
    const log = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => log };
    const ftp = new FtpSrv({ url: "ftp://127.0.0.1:2131", pasv_url: "127.0.0.1", pasv_min: 50200, pasv_max: 50250, anonymous: false, log });
    ftp.on("login", ({ username, password }, resolve, reject) => (username === "demo" && password === "secret" ? resolve({ root: serverRoot }) : reject(new Error("bad credentials"))));
    await ftp.listen();
    await suite("FTP (ftp-srv on 2131)", { protocol: "ftp", port: 2131, webPort: 8131, serverRoot, tmp, afterDeploys: mcpSmoke });
    await ftp.close();
  }
  // SFTP
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coolftp-e2e-sftp-"));
    const serverRoot = path.join(tmp, "server");
    fs.mkdirSync(path.join(serverRoot, "public_html"), { recursive: true });
    let sftp = await startSftpServer({ port: 2232, root: serverRoot });
    await suite("SFTP (ssh2 server on 2232)", {
      protocol: "sftp",
      port: 2232,
      webPort: 8232,
      serverRoot,
      tmp,
      async afterDeploys({ cliJson, cliFails, HOME }) {
        const known = JSON.parse(fs.readFileSync(path.join(HOME, "known_hosts.json"), "utf8"));
        check("host key recorded on first use", known["127.0.0.1:2232"] && known["127.0.0.1:2232"].fingerprint.startsWith("SHA256:"), JSON.stringify(known));
        // Same port, brand new host key: exactly what a MITM or a rebuilt server looks like.
        await sftp.close();
        sftp = await startSftpServer({ port: 2232, root: serverRoot });
        const err = await cliFails(["site", "test", "demo"]);
        check("changed host key is refused", err !== null && /HOST KEY CHANGED/.test(err), err);
        const trust = await cliJson(["site", "trust", "demo"]);
        check("site trust forgets the key", trust.forgot === true);
        const again = await cliJson(["site", "test", "demo"]);
        check("connects after trust", again.ok === true);
      },
    });
    await sftp.close();
  }
  // A shared host drops an idle FTP control connection. The transport must reconnect on the
  // next command rather than fail it, or a deploy plan quietly degrades to "upload everything".
  {
    const esbuild = require("esbuild");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coolftp-e2e-drop-"));
    const coreFile = path.join(tmp, "core.cjs");
    esbuild.buildSync({
      entryPoints: [path.join(REPO, "packages", "core", "src", "index.ts")],
      outfile: coreFile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      external: ["electron", "cpu-features", "*.node"],
      logLevel: "silent",
    });
    const core = require(coreFile);
    const serverRoot = path.join(tmp, "server");
    fs.mkdirSync(path.join(serverRoot, "public_html"), { recursive: true });
    fs.writeFileSync(path.join(serverRoot, "public_html", "a.txt"), "a");
    const noop = () => undefined;
    const log = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => log };
    const ftp = new FtpSrv({ url: "ftp://127.0.0.1:2132", pasv_url: "127.0.0.1", pasv_min: 50260, pasv_max: 50290, anonymous: false, timeout: 800, log });
    ftp.on("login", ({ username, password }, resolve, reject) => (username === "demo" && password === "secret" ? resolve({ root: serverRoot }) : reject(new Error("bad credentials"))));
    await ftp.listen();
    console.log("\nFTP reconnect (server idle timeout 0.8s)");
    const t = new core.FtpTransport({ name: "drop", host: "127.0.0.1", port: 2132, username: "demo", password: "secret", protocol: "ftp", remoteRoot: "/public_html" });
    try {
      await t.connect();
      const first = await t.list("/public_html");
      check("list before the drop", first.some((e) => e.name === "a.txt"));
      await new Promise((r) => setTimeout(r, 1800));
      check("server dropped the idle connection", !t.isConnected());
      let again = null;
      let err = null;
      try {
        again = await t.list("/public_html");
      } catch (e) {
        err = e;
      }
      check("list after the drop reconnects", again !== null && again.some((e) => e.name === "a.txt"), err && err.message);
      const created = await t.mkdirp("/public_html/x/y");
      check("mkdirp reports what it created", created.length === 2 && created[0] === "/public_html/x" && created[1] === "/public_html/x/y" && fs.existsSync(path.join(serverRoot, "public_html", "x", "y")), JSON.stringify(created));
      const createdAgain = await t.mkdirp("/public_html/x/y");
      check("mkdirp creates nothing the second time", createdAgain.length === 0, JSON.stringify(createdAgain));
    } catch (e) {
      failures++;
      console.log("  FAIL  exception:", e.message);
    }
    await t.close();
    await ftp.close();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
