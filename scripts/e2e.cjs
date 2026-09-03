/*
 * End-to-end tests: spin up local FTP and SFTP servers in temp directories and drive
 * the built coolftp CLI through the full deploy workflow against each.
 *   npm run build && npm run e2e
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "coolftp.js");
const { FtpSrv } = require("ftp-srv");
const { startSftpServer } = require("./lib/sftp-server.cjs");

let failures = 0;
function check(name, cond, extra) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra && !cond ? "  " + extra : ""}`);
  if (!cond) failures++;
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
  return PROJECT;
}

async function suite(label, { protocol, port, serverRoot, tmp }) {
  console.log(`\n${label}`);
  const PROJECT = makeProject(tmp);
  const HOME = path.join(tmp, "home");
  const env = { ...process.env, COOLFTP_HOME: HOME, NO_COLOR: "1", COOLFTP_AGENT: "e2e" };
  const cli = (args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile("node", [CLI, "--direct", ...args], { cwd: opts.cwd || PROJECT, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve(stdout);
      });
    });
  const cliJson = async (args, opts) => JSON.parse(await cli(["--json", ...args], opts));
  const remote = (...p) => path.join(serverRoot, "public_html", ...p);

  try {
    await cli(["site", "add", "demo", "--host", "127.0.0.1", "--user", "demo", "--password", "secret", "--protocol", protocol, "--port", String(port), "--root", "/public_html"]);
    const sites = await cliJson(["site", "list"]);
    check("site saved without leaking password", sites.length === 1 && sites[0].remoteRoot === "/public_html" && sites[0].hasPassword === true && !("password" in sites[0]));

    const test = await cliJson(["site", "test", "demo"]);
    check("site test connects", test.ok === true && test.protocol === protocol, JSON.stringify(test));

    const init = await cliJson(["init", "demo"]);
    check("init writes .coolftp.json", fs.existsSync(path.join(PROJECT, ".coolftp.json")), init.file);

    const dry = await cliJson(["deploy", "--dry-run"]);
    check("dry run basis fresh", dry.dryRun === true && dry.plan.basis === "fresh", dry.plan.basis);
    check("dry run plans 3 files", dry.plan.add.length === 3 && dry.plan.add.includes("index.html") && dry.plan.add.includes("css/style.css") && dry.plan.add.includes("big.bin"), JSON.stringify(dry.plan.add));
    check("ignored files excluded", !dry.plan.add.some((f) => f.includes("node_modules") || f === ".env" || f === "notes.md" || f === ".coolftpignore"));

    const dep1 = await cliJson(["deploy", "-m", "first"]);
    check("deploy uploads 3", dep1.record && dep1.record.added === 3, JSON.stringify(dep1.record));
    check("remote index.html content", fs.readFileSync(remote("index.html"), "utf8") === "<h1>hello coolFTP</h1>");
    check("remote big.bin intact", fs.existsSync(remote("big.bin")) && fs.readFileSync(remote("big.bin")).equals(Buffer.alloc(300 * 1024, 7)));
    check("manifest written", fs.existsSync(remote(".coolftp", "manifest.json")));
    check("manifest htaccess", fs.existsSync(remote(".coolftp", ".htaccess")));

    const dep2 = await cliJson(["deploy"]);
    check("second deploy is a no-op", dep2.record.added === 0 && dep2.record.changed === 0, JSON.stringify(dep2.record));

    fs.writeFileSync(path.join(PROJECT, "index.html"), "<h1>hello coolFTP v2</h1>");
    fs.writeFileSync(path.join(PROJECT, "app.js"), "console.log(1)");
    fs.unlinkSync(path.join(PROJECT, "css", "style.css"));
    const diff = await cliJson(["diff"]);
    check("diff basis manifest", diff.plan.basis === "manifest", diff.plan.basis);
    check("diff detects change/add/delete", diff.plan.change.includes("index.html") && diff.plan.add.includes("app.js") && diff.plan.delete.includes("css/style.css") && diff.plan.unchanged === 1, JSON.stringify(diff.plan));

    const dep3 = await cliJson(["deploy", "--delete", "-m", "v2"]);
    check("deploy with delete", dep3.record.added === 1 && dep3.record.changed === 1 && dep3.record.deleted === 1, JSON.stringify(dep3.record));
    check("remote css removed", !fs.existsSync(remote("css", "style.css")));
    check("remote index updated", fs.readFileSync(remote("index.html"), "utf8").includes("v2"));

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
    check("history has 3 deploys", hist.length === 3 && hist[0].message === "v2" && hist[0].agent === "e2e", JSON.stringify(hist.map((h) => h.message)));

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
    const sftp = await startSftpServer({ port: 2232, root: serverRoot });
    await suite("SFTP (ssh2 server on 2232)", { protocol: "sftp", port: 2232, serverRoot, tmp });
    await sftp.close();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
