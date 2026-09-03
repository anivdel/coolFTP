/*
 * End-to-end tests: spin up local FTP and SFTP servers in temp directories and drive
 * the built coolftp CLI through the full deploy workflow against each, including
 * the first-deploy delete guard, git-based rollback, encrypted passwords, and
 * SSH host key pinning.
 *   npm run build && npm run e2e
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile, execFileSync } = require("node:child_process");

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
  fs.writeFileSync(path.join(PROJECT, "index.html"), "<h1>hello coolFTP</h1>");
  fs.writeFileSync(path.join(PROJECT, "css", "style.css"), "body{color:red}");
  fs.writeFileSync(path.join(PROJECT, "node_modules", "junk", "x.js"), "ignored");
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

async function suite(label, { protocol, port, serverRoot, tmp, afterDeploys }) {
  console.log(`\n${label}`);
  const PROJECT = makeProject(tmp);
  const HOME = path.join(tmp, "home");
  const env = { ...process.env, ...GIT_ENV, COOLFTP_HOME: HOME, NO_COLOR: "1", COOLFTP_AGENT: "e2e" };
  const cli = (args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile("node", [CLI, "--direct", ...args], { cwd: opts.cwd || PROJECT, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve(stdout);
      });
    });
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
  const ctx = { cli, cliJson, cliFails, PROJECT, HOME, remote };

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
    check("ignored files excluded", !dry.plan.add.some((f) => f.includes("node_modules") || f === ".env" || f === "notes.md" || f === ".coolftpignore"));

    const dep1 = await cliJson(["deploy", "-m", "first"]);
    check("deploy uploads 3", dep1.record && dep1.record.added === 3, JSON.stringify(dep1.record));
    check("deploy records git commit", dep1.record.git && dep1.record.git.branch === "main" && dep1.record.git.dirty === false, JSON.stringify(dep1.record.git));
    check("remote index.html content", fs.readFileSync(remote("index.html"), "utf8") === "<h1>hello coolFTP</h1>");
    check("remote big.bin intact", fs.existsSync(remote("big.bin")) && fs.readFileSync(remote("big.bin")).equals(Buffer.alloc(300 * 1024, 7)));
    check("manifest written", fs.existsSync(remote(".coolftp", "manifest.json")));
    check("manifest htaccess", fs.existsSync(remote(".coolftp", ".htaccess")));
    check("legacy file untouched by normal deploy", fs.existsSync(remote("legacy.txt")));

    const dep2 = await cliJson(["deploy"]);
    check("second deploy is a no-op", dep2.record.added === 0 && dep2.record.changed === 0, JSON.stringify(dep2.record));

    fs.writeFileSync(path.join(PROJECT, "index.html"), "<h1>hello coolFTP v2</h1>");
    fs.writeFileSync(path.join(PROJECT, "app.js"), "console.log(1)");
    fs.unlinkSync(path.join(PROJECT, "css", "style.css"));
    const diff = await cliJson(["diff"]);
    check("diff basis manifest", diff.plan.basis === "manifest", diff.plan.basis);
    check("diff detects change/add/delete", diff.plan.change.includes("index.html") && diff.plan.add.includes("app.js") && diff.plan.delete.includes("css/style.css") && diff.plan.unchanged === 1, JSON.stringify(diff.plan));

    const dep3 = await cliJson(["deploy", "--delete", "--commit", "-m", "v2"]);
    check("deploy --commit --delete", dep3.record.added === 1 && dep3.record.changed === 1 && dep3.record.deleted === 1, JSON.stringify(dep3.record));
    check("--commit made a git commit", git(PROJECT, "log", "--oneline").split("\n").length === 3 && git(PROJECT, "log", "-1", "--format=%s") === "v2");
    check("remote css removed", !fs.existsSync(remote("css", "style.css")));
    check("remote index updated", fs.readFileSync(remote("index.html"), "utf8").includes("v2"));
    check("legacy file survives manifest-based --delete", fs.existsSync(remote("legacy.txt")));

    // Rollback to the previous live commit (v1) restores css and removes app.js.
    const rb = await cliJson(["rollback"]);
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
    check("rollback --to deploy id", rf.commit === v2deploy.git.commit && fs.readFileSync(remote("index.html"), "utf8").includes("v2") && fs.existsSync(remote("app.js")));

    const ls = await cliJson(["ls"]);
    check("ls lists remote root", ls.path === "/public_html" && ls.entries.some((e) => e.name === "app.js") && ls.entries.find((e) => e.name === "css").type === "dir", JSON.stringify(ls.entries));
    const cat = await cliJson(["cat", "app.js"]);
    check("cat reads file", cat.content === "console.log(1)");

    fs.writeFileSync(path.join(tmp, "extra.txt"), "extra");
    await cliJson(["push", path.join(tmp, "extra.txt"), "uploads/extra.txt"]);
    check("push creates parent dir", fs.existsSync(remote("uploads", "extra.txt")));
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

    const hist = await cliJson(["history"]);
    check("history has 5 deploys", hist.length === 5 && hist[0].agent === "e2e", JSON.stringify(hist.map((h) => h.message)));

    if (afterDeploys) await afterDeploys(ctx);

    const rm = await cliJson(["site", "remove", "demo"]);
    check("site removed", rm.removed === true);
  } catch (e) {
    failures++;
    console.log("  FAIL  exception:", e.stderr || e.stdout || e.message);
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
    await suite("FTP (ftp-srv on 2131)", { protocol: "ftp", port: 2131, serverRoot, tmp });
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
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
