# Changelog

## 0.1.2 (2026-09-09)

Four days of deploying with 0.1.1 from Claude Code, then fixing what got in the agent's way. Most of this release is for the agent; the app gets a few things to watch it with, and a yeti.

### Fixed

- **A failed verification now fails the command.** `deploy`, `rollback`, `undo` and `verify` exit with code 3 when the files landed but the live checks did not pass, and the failing URL and status are printed on the verdict line. Before, every one of those deploys exited 0 with "see checks above". `-q` now keeps the result line, warnings, errors and the checks, and only drops progress and per-file output, so "see checks above" no longer points at nothing.
- **Output that fits in an agent's window.** A deploy of more than 20 files prints one progress line every few seconds (files, bytes, speed, ETA, connections) instead of one line per file, and "scanned N files…" only animates on a terminal. Plans longer than 20 entries are summarised by folder. MCP results carry counts, a folder breakdown and a few examples instead of every path, and the transfer log collapses after 20 files. A 15,000-file first deploy used to produce 726 KB of output with the summary at the very end.
- **The MCP server follows the app.** It decided hub-or-direct once at startup, so a session that began with the app closed never used it, and one that began with the app open failed every call after the app closed. It now checks the hub on every call.
- **A pushed file counts as deployed.** `coolftp push` of a file inside the project's remote directory records it in the deploy manifest, so `diff` and the next `deploy` no longer treat it as changed and upload it again.
- **Folders created on the way are reported.** Every command says which directories it had to create, and a single-file push that opens a new top-level folder gets a warning, which is exactly what a stale `public_html/` prefix looks like.
- `.gitkeep` files are never uploaded.
- The CLI warns once when the desktop app it routes through is a different version.
- `coolftp status` points out a sandboxed copy of the config when one exists, which is why sites saved in the app can be invisible to a CLI running inside another app's sandbox until the app is open.

### New

- **Undo, without git.** Before overwriting or deleting a file, a deploy moves the live copy into `.coolftp/backup/<deployId>/` on the server (a rename, no extra transfer). `coolftp undo` puts those versions back, removes the files that deploy added, and is itself undoable. `--dry-run` shows the work first, `--to <id>` targets an older deploy as long as nothing later touched its files. The last five deploys keep their backups; `coolftp init --keep-backups <n>` changes that, 0 turns it off. Rollbacks and undos are recorded with the deploy history, the app has an Undo button in the Deploys tab, and agents get `coolftp_undo` behind the same approval dialog as rollback.
- **Uploads are confirmed.** After each upload in a job of up to 50 files, the server is asked for the file's size and a mismatch is retried and then reported. `coolftp stat <path>` (and `coolftp_stat`) answers "is it there, how big, since when" without downloading anything.
- **Parallel FTP.** Jobs of eight files or more open up to four FTP connections; `coolftp site add --connections <n>` changes the count, and a login the server refuses is skipped with a warning rather than failing the deploy. SFTP keeps multiplexing one connection.
- **`coolftp verify`** re-runs the live checks without deploying: the homepage plus the last deploy's files, or the paths you give it. Static files are also compared byte for byte with the local copy; a mismatch is reported as stale (a cache or CDN still serving the old version) without failing the check. The result is stored with the deploy, `history` shows live, failed or stale for each one, and the app shows the same badge with a Re-check button.
- **Changed files are swapped in, never half-written.** A changed file uploads beside the live copy and is renamed into place after the old one is moved to the backup. The manifest is written the same way, so a dropped connection cannot leave a truncated manifest that turns the next deploy into "upload everything".
- **App.** A progress card per deploy in the Transfers tab (files, bytes, speed, ETA, connections, then the result and the verification badge); a Windows notification when an agent's deploy, undo or rollback finishes while the app is in the background; a result column in the Agents tab, and each call expands to show the remote directory, every file it touched, folders it created (with a warning for new top-level ones) and the live checks; Undo and Re-check buttons in the Deploys tab. The icon and the in-app logo are the new yeti.

### Tests

- e2e now also covers undo and redo, the older-deploy conflict check, backup pruning, push recording into the manifest, the created-folder warning, size confirmation, `stat`, four FTP connections against the local server, verification against a local web server including a stale copy and an unreachable site with exit code 3, quiet mode output, `.gitkeep`, mkdirp reporting, and the MCP server driven over stdio.

## 0.1.1 (2026-09-08)

Fixes from the first days of deploying a real 15,000-file site with coolFTP.

### Fixed

- **Browsing commands follow the project's remote directory.** `push`, `pull`, `ls`, `cat`, `rm`, `mkdir`, `mv` and the matching MCP tools resolved relative paths against the site root even when `.coolftp.json` set a `remoteRoot`. On a host whose FTP login lands one level above `public_html`, single-file pushes landed in a stray tree next to the web root. They now resolve against the same directory `deploy` writes to. Paths starting with `/` are still absolute on the server.
- **Public URLs for projects in a sub-directory.** A project deploying into a sub-directory of the site root had the FTP path spliced into its URLs (`example.com/public_html/...`), so every deploy reported a failed verification. `.coolftp.json` can now carry a `url` (`coolftp init --url https://example.com`, or the MCP init tool) that maps the project's remote directory to its public address.
- **Git Bash path mangling.** Git Bash rewrites arguments that start with `/` into `C:/Program Files/Git/...` before the CLI sees them, which once wrote that into `.coolftp.json`. Remote path arguments now undo the rewrite when the Git prefix is recognisable and refuse any other drive-letter path with a hint.
- **A dropped connection no longer looks like a missing manifest.** The diff connected first and then hashed the local tree; on a large project that outlasted the server's idle limit, the server closed the connection, and the swallowed failures turned the plan into "fresh site, upload everything". The scan now runs before connecting, the FTP transport reconnects when the server dropped an idle session, and only a genuinely missing file counts as "no manifest".

### Tests

- End-to-end coverage for all of the above against local FTP and SFTP servers, including a server with a short idle timeout for the reconnect case.

## 0.1.0 (2026-09-05)

First public build. Desktop SFTP/FTPS/FTP client, `coolftp` CLI, `coolftp mcp` MCP server, hash-based deploys with a server-side manifest, approval dialogs for destructive agent actions, git-based rollback, post-deploy verification, SSH host key pinning, DPAPI-encrypted passwords, and resumable deploys.
