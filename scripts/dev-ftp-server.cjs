/*
 * Local FTP server for trying coolFTP without a real host.
 *   node scripts/dev-ftp-server.cjs [port] [root]
 * Login: demo / secret. Root defaults to a temp folder seeded with a few files.
 * Then: coolftp site add local --host 127.0.0.1 --port 2121 --user demo --password secret --protocol ftp --root /public_html
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { FtpSrv } = require("ftp-srv");

const port = Number(process.argv[2]) || 2121;
const root = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "coolftp-dev-"));
const web = path.join(root, "public_html");
if (!fs.existsSync(web)) {
  fs.mkdirSync(path.join(web, "css"), { recursive: true });
  fs.mkdirSync(path.join(web, "img"), { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>hello</title><h1>served by the coolFTP dev server</h1>\n");
  fs.writeFileSync(path.join(web, "css", "site.css"), "body{font-family:system-ui}\n");
  fs.writeFileSync(path.join(web, ".htaccess"), "Options -Indexes\n");
  fs.writeFileSync(path.join(web, "robots.txt"), "User-agent: *\nAllow: /\n");
}

const ftp = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: "127.0.0.1", pasv_min: 50000, pasv_max: 50100, anonymous: false, log: silentLogger() });
ftp.on("login", ({ username, password }, resolve, reject) => {
  if (username === "demo" && password === "secret") resolve({ root });
  else reject(new Error("bad credentials (use demo / secret)"));
});
ftp.listen().then(() => {
  console.log(`coolFTP dev FTP server\n  ftp://demo:secret@127.0.0.1:${port}\n  root ${root}\n  remote root for a site: /public_html\nCtrl+C to stop.`);
});

function silentLogger() {
  const noop = () => undefined;
  const l = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => l };
  return l;
}
