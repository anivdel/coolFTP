/*
 * Minimal SFTP server on top of ssh2, backed by a directory on disk.
 * Used by the end-to-end tests and by `npm run dev:sftp` so coolFTP can be tried
 * over SFTP without a real host. Not hardened; loopback use only.
 */
const fs = require("node:fs");
const path = require("node:path");
const { Server, utils } = require("ssh2");

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

function startSftpServer({ port = 2222, host = "127.0.0.1", root, username = "demo", password = "secret", hostKey } = {}) {
  if (!root) throw new Error("root is required");
  root = path.resolve(root);
  const key = hostKey || utils.generateKeyPairSync("ed25519").private;

  const toLocal = (p) => {
    const rel = (p || "/").replace(/\\/g, "/").replace(/^\/+/, "");
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root)) throw new Error("path escapes root");
    return abs;
  };
  const toRemote = (abs) => "/" + path.relative(root, abs).replace(/\\/g, "/");

  const attrsOf = (st) => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });

  const server = new Server({ hostKeys: [key] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === username && ctx.password === password) return ctx.accept();
      if (ctx.method === "none") return ctx.reject(["password"]);
      ctx.reject(["password"]);
    });
    client.on("error", () => undefined);
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (accept) => {
          const sftp = accept();
          let nextHandle = 1;
          const handles = new Map(); // id -> { type: 'dir', entries, sent } | { type: 'file', fd, path }
          const newHandle = (obj) => {
            const id = nextHandle++;
            handles.set(id, obj);
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(id, 0);
            return buf;
          };
          const get = (h) => handles.get(h.readUInt32BE(0));
          const ok = (reqid) => sftp.status(reqid, STATUS_CODE.OK);
          const fail = (reqid, err) => {
            const code = err && (err.code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : err.code === "EACCES" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE);
            sftp.status(reqid, code, err ? String(err.message || err) : undefined);
          };

          sftp.on("REALPATH", (reqid, p) => {
            try {
              const abs = toLocal(p === "." || p === "" ? "/" : p);
              const remote = toRemote(abs) || "/";
              const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
              sftp.name(reqid, [{ filename: remote, longname: remote, attrs: st ? attrsOf(st) : undefined }]);
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("OPENDIR", (reqid, p) => {
            try {
              const abs = toLocal(p);
              const names = fs.readdirSync(abs);
              const entries = names.map((n) => {
                const st = fs.lstatSync(path.join(abs, n));
                const a = attrsOf(st);
                const long = `${st.isDirectory() ? "d" : "-"}rw-r--r--   1 demo demo ${String(st.size).padStart(8)} Jan  1 00:00 ${n}`;
                return { filename: n, longname: long, attrs: a };
              });
              sftp.handle(reqid, newHandle({ type: "dir", entries, sent: false }));
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("READDIR", (reqid, h) => {
            const d = get(h);
            if (!d || d.type !== "dir") return fail(reqid);
            if (d.sent) return sftp.status(reqid, STATUS_CODE.EOF);
            d.sent = true;
            sftp.name(reqid, d.entries);
          });
          sftp.on("CLOSE", (reqid, h) => {
            const o = get(h);
            if (o && o.type === "file") {
              try {
                fs.closeSync(o.fd);
              } catch {
                /* ignore */
              }
            }
            handles.delete(h.readUInt32BE(0));
            ok(reqid);
          });
          const stat = (reqid, p, lstat) => {
            try {
              const st = (lstat ? fs.lstatSync : fs.statSync)(toLocal(p));
              sftp.attrs(reqid, attrsOf(st));
            } catch (e) {
              fail(reqid, e);
            }
          };
          sftp.on("STAT", (reqid, p) => stat(reqid, p, false));
          sftp.on("LSTAT", (reqid, p) => stat(reqid, p, true));
          sftp.on("FSTAT", (reqid, h) => {
            const o = get(h);
            if (!o || o.type !== "file") return fail(reqid);
            try {
              sftp.attrs(reqid, attrsOf(fs.fstatSync(o.fd)));
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("MKDIR", (reqid, p) => {
            try {
              fs.mkdirSync(toLocal(p));
              ok(reqid);
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("OPEN", (reqid, p, flags) => {
            try {
              let f;
              const read = flags & OPEN_MODE.READ;
              const write = flags & OPEN_MODE.WRITE;
              if (write) {
                const trunc = flags & OPEN_MODE.TRUNC;
                const creat = flags & OPEN_MODE.CREAT;
                const append = flags & OPEN_MODE.APPEND;
                if (append) f = read ? "a+" : "a";
                else if (trunc || creat) f = read ? "w+" : "w";
                else f = "r+";
                if (flags & OPEN_MODE.EXCL) f = f.replace("w", "wx");
              } else f = "r";
              const abs = toLocal(p);
              const fd = fs.openSync(abs, f);
              sftp.handle(reqid, newHandle({ type: "file", fd, path: abs }));
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("READ", (reqid, h, offset, length) => {
            const o = get(h);
            if (!o || o.type !== "file") return fail(reqid);
            try {
              const buf = Buffer.alloc(length);
              const n = fs.readSync(o.fd, buf, 0, length, Number(offset));
              if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, buf.subarray(0, n));
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("WRITE", (reqid, h, offset, data) => {
            const o = get(h);
            if (!o || o.type !== "file") return fail(reqid);
            try {
              fs.writeSync(o.fd, data, 0, data.length, Number(offset));
              ok(reqid);
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("REMOVE", (reqid, p) => {
            try {
              fs.unlinkSync(toLocal(p));
              ok(reqid);
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("RMDIR", (reqid, p) => {
            try {
              fs.rmdirSync(toLocal(p));
              ok(reqid);
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("RENAME", (reqid, from, to) => {
            try {
              fs.renameSync(toLocal(from), toLocal(to));
              ok(reqid);
            } catch (e) {
              fail(reqid, e);
            }
          });
          sftp.on("SETSTAT", (reqid) => ok(reqid));
          sftp.on("FSETSTAT", (reqid) => ok(reqid));
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, root, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

module.exports = { startSftpServer };

if (require.main === module) {
  const os = require("node:os");
  const port = Number(process.argv[2]) || 2222;
  const root = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "coolftp-sftp-"));
  const web = path.join(root, "public_html");
  if (!fs.existsSync(web)) {
    fs.mkdirSync(path.join(web, "css"), { recursive: true });
    fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>hello</title><h1>served by the coolFTP dev SFTP server</h1>\n");
    fs.writeFileSync(path.join(web, "css", "site.css"), "body{font-family:system-ui}\n");
  }
  startSftpServer({ port, root }).then(() => {
    console.log(`coolFTP dev SFTP server\n  sftp://demo:secret@127.0.0.1:${port}\n  root ${root}\n  remote root for a site: /public_html\nCtrl+C to stop.`);
  });
}
