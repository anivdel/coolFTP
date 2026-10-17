# Changelog

## Claude Code plugin: coolftp 0.4.0 (2026-10-17)

- **`/coolftp:license <key>`** activates coolFTP Pro from Claude Code, or paste the key and ask Claude. With no key it shows which plan this machine is on. The `coolftp_license` tool does the work.
- Ships coolFTP 0.2.0 below.

## coolFTP 0.2.0 (2026-10-17)

- **Free covers one site, Pro is unlimited.** Every feature stays in Free for one saved site. Saving a second needs coolFTP Pro, a one-time $49 with updates for life, at https://coolftp.com/#pro. Editing or renaming the site you have always works, and sites saved before this release are kept.
- **Pro is updates for life.** A genuine key unlocks Pro in every build; nothing turns it back into Free after a date.
- **One key format for every Ledvina Software app.** coolFTP also accepts `LS1.` keys, which list the apps they unlock, so a bundle key works in coolFTP and OwlSQL alike. Existing `CFP1.` keys keep working.
- The app's Pro dialog opens when you try to add a site past the limit, and the limit error names all three ways in: the app's Pro button, `/coolftp:license`, `coolftp license activate`.

- **Fixed:** inside the Claude desktop app on Windows, the plugin, CLI and MCP server could miss sites saved in the coolFTP app and fail with `Unknown site "coolFTP"`. Claude Desktop is a packaged (MSIX) app, so Windows gives it a private copy of `%APPDATA%`: once anything coolFTP wrote there from inside Claude Desktop, that stale copy hid the real `sites.json` for good. coolFTP now keeps its config in `%USERPROFILE%\.coolftp`, which Windows does not redirect, so the app, the CLI and the plugin all read the same sites, and the app does not need to be open.
- **Moving your config.** The first run of the new app or CLI copies `%APPDATA%\coolftp` (sites, deploy history, known hosts, license) into `%USERPROFILE%\.coolftp`. Sandboxed copies are renamed to `coolftp.sandbox-bak-<date>` first so the real files win, and any site that only existed in a sandboxed copy is added. The old folder is left in place. macOS, Linux and `COOLFTP_HOME` are unchanged.
- **Update the app and the CLI together.** After the move, sites added in an app or CLI up to 0.1.4 go to the old folder and are not seen by the new one. The new app also writes its hub file to the old folder, and the new CLI looks there, so either still routes through the other while the app is open.
- `coolftp status` and `coolftp_status` no longer tell you to open the app when they find a sandboxed config. If an older coolFTP writes one again, the note says it is not used and where sites are read from.
- New test: `npm run test:config` (Windows) covers the move, a stale sandboxed copy, a sandbox-only setup and `COOLFTP_HOME`.

## Claude Code plugin: coolftp 0.3.8 (2026-10-16)

- Undo and delete steps in the panel say what they do ("Restoring the files from before the last change", "Taking it off the server") instead of asking you to approve them in the coolFTP app, which the plugin does not need.

## Claude Code plugin: coolftp 0.3.7 (2026-10-16)

- **No pale rim around the yeti.** The traced fur reached out to the logo's soft edge pixels, past the black outline, leaving a thin white line around him. `scripts/plugin-yeti.py` now drops soft edge pixels before tracing and draws the silhouette's black edge over the fur.


## Claude Code plugin: coolftp 0.3.6 (2026-10-16)

- **The yeti's face shows in Claude's panel.** 0.3.5 drew him from embedded PNGs, which the panel strips, so only his vector eyes showed. He is now all vector shapes, traced from the rig with vtracer (`scripts/plugin-yeti.py`), and half the size.


## Claude Code plugin: coolftp 0.3.5 (2026-10-16)

- **The yeti is in the panel.** He sits under the path the files fly along and acts out each step: breathes and blinks while waiting, nods and watches files go right while uploading, watches them come back on downloads, reads side to side during previews and live checks, hops with a grin when a deploy is live, looks up wide-eyed on warnings, undos and deletes, and glares and shakes his head on errors. Drawn from the same rig as the videos (`scripts/plugin-yeti.py` embeds it), animated with SVG only.

## Claude Code plugin: coolftp 0.3.4 (2026-10-16)

- **The panel lists the files each step touched.** Under every deploy, upload, download, undo and rollback: new (`+`), changed (`~`), removed (`−`), sent (`↑`) or fetched (`↓`), with sizes where coolFTP gives them. The first five show; **All N files** opens the rest. Paths are shown inside the web root (`index.html`, not `/domains/x.com/public_html/index.html`). Panel only: no server change.

## Claude Code plugin: coolftp 0.3.3 (2026-10-16)

- **The MCP server ships inside the plugin.** The plugin carries its own copy of the coolftp CLI (`server/coolftp.js`, one file with no dependencies, refreshed by `npm run build`), and starts it in place of a global `coolftp` or `npx`. A plugin update now brings server changes with it, so the live progress from 0.3.2 works straight away, with no npm install and no desktop app. `COOLFTP_BIN` still picks another coolftp.
- Downloads report live progress too: the live file is named for the project folder the call came from.

## Claude Code plugin: coolftp 0.3.2 (2026-10-16)

- **Live progress in the panel.** While files move, the panel names the file being sent with its bytes so far (`…/media/intro.mp4 · 12.0 MB of 48.0 MB`), draws a progress bar, and shows the whole job: files done, bytes, speed and time left. The terminal panel gets a text bar. The status line shows the percentage.
- How: the MCP server writes a small live file to `COOLFTP_LIVE_DIR` (set by the plugin to its own `.live` folder) at most four times a second while a deploy, upload, download, undo or rollback runs, and the panel reads it every second. Needs the coolFTP CLI after 0.1.4; with 0.1.4 the panel looks as before.

## Claude Code plugin: coolftp 0.3.1 (2026-10-16)

- **The panel names the site.** Every step says which site it went to, by the domain people know it by: "Publishing your site to coolftp.com", "about.html is on jledvina.com". The panel asks coolFTP once per project folder, so two projects in one session never borrow each other's name. Before, it said "your website" until a live check gave it an address, and could reuse another project's domain.
- `coolftp_status` now answers `site: { name, url, host }` for the project. The plugin falls back to `coolftp_sites` with coolFTP 0.1.4.
- An unknown site no longer tells you to open the coolFTP app.

## Claude Code plugin: coolftp 0.3.0 (2026-10-16)

coolFTP is now one Claude Code plugin. One install gives Claude the MCP server, the deploy skill, slash commands and the live panel; before, that took an npm install, a `claude mcp add` (with a `cmd /c` wrapper on Windows), copying a skill folder by hand and a separate mod. Works with coolFTP 0.1.4 as it is; the app, CLI and MCP server are unchanged. Source in [plugins/coolftp](plugins/coolftp).

- Install with `/plugin install coolftp --marketplace anivdel/coolFTP`. Needs Node 18 or newer; the desktop app is optional.
- **MCP server, started for you.** A global `coolftp` is used when there is one, so it matches the CLI and the app; otherwise the latest from npm runs through `npx`. No `cmd /c` on Windows.
- **Deploy skill, MCP first.** The skill that was in this repo's `.claude/skills/deploy` now ships with the plugin and works in any project: it links a new project, previews before deploying, reports the live verdict exactly, and never asks for a password in the chat.
- **Commands:** `/coolftp:setup`, `/coolftp:deploy`, `/coolftp:undo`, `/coolftp:live`.
- **The coolftp-live panel is part of the plugin.** If you installed `coolftp-live`, uninstall it (`/plugin uninstall coolftp-live`) and install `coolftp`; the panel's saved history starts fresh. If you added the MCP server by hand, `claude mcp remove coolftp -s user` so Claude does not see each tool twice.

## 0.1.4 (2026-10-12)

A fix release for the MCP server. The app and CLI are otherwise the same as 0.1.3.

- **Fixed:** with the coolFTP app open, `coolftp_upload` given a relative local path (`index.html`) failed with "Local path not found: C:\Program Files\coolFTP\index.html", and `coolftp_download` saved into the app's install folder instead of the project. The MCP server handed the path to the app as it was, and the app read it from its own folder. The tools now resolve local paths against the project folder before calling the app, as the CLI always has. Deploys were not affected.

## 0.1.3 (2026-10-11)

A fix release. The app, CLI and MCP server are otherwise the same as 0.1.2; the Claude Code mod ships separately (below).

- **Fixed:** a deploy, upload or download that runs on several workers could report "Deploy stopped after 30 of 30 files" when every file had landed. Two workers finishing together could both reach for the last file, and the one that came up empty failed the whole run. Seen intermittently in CI on the SFTP e2e.

## Claude Code mod: coolftp-live 0.2.1 (2026-10-11)

- The first tile is now **Last change**: how long since Claude last changed anything on your server (a deploy, an upload, an undo, a delete), across sessions. It replaces "publishes this session", which stayed at 0 for anyone who updates a site a file at a time.
- The **Up** tile says how fast the front page loaded in the last live check: "loads in 0.2s".

## Claude Code mod: coolftp-live 0.2.0 (2026-10-11)

The panel is redrawn as pictures and plain English; 0.1.0 showed raw numbers that only meant something to someone who already knew coolFTP.

- **A picture of the whole trip.** Your computer, your website (by its domain) and the path between them. Files fly along the path while Claude publishes or uploads, and back while it downloads; rings pulse around the site while it checks the site is up; a magnifying glass, a bin or a spinning arrow while it looks around, deletes or restores. The site gets a green ✓, yellow ! or red ✗ when the step ends.
- **Plain English.** Each step is a headline and one sentence: "Publishing your site to coolftp.com", "Your site is live · 3 files updated · 19 KB", "Couldn't publish: coolFTP could not find this site here. Open the coolFTP app and try again." Toasts use the same words.
- **Three tiles:** files sent, whether the site is answering, and (0.2.1) how long since the last change. Below them, "What Claude did": each step with an icon, its sentence and "2 min ago · took 3s", and a link to open the site.
- Bookkeeping calls (`status`, `sites`, `history`, `init`) are no longer shown.
- The terminal, which has no pictures, gets the same plain words.

## Claude Code mod: coolftp-live 0.1.0 (2026-10-11)

A Claude Code mod that shows coolFTP's work in a panel beside the conversation. It works with coolFTP 0.1.2 as it is; the app, CLI and MCP server are unchanged. Source in [mods/coolftp-live](mods/coolftp-live); the repository root is a Claude Code marketplace for it.

- **Live panel.** Every `coolftp_*` MCP call, and every `coolftp ...` command Claude runs in the shell, appears as it starts: a timer while it runs, then ✓, ! or ✗ with the outcome in one line (files added, changed and removed, bytes, duration, and the live verdict), plus a link to the deployed page.
- **Status line and toasts.** The status line says what coolFTP is doing; deploys, undos, rollbacks, uploads, deletes, writes, renames and new folders end with a toast.
- **History across sessions.** The last 20 finished steps are kept, so a new session opens with recent deploys. **Clear** empties the list.
- **`/coolftp-panel`** opens the panel again.
- **Watch only.** The mod never blocks or rewrites a call, and if it fails itself the call goes through untouched.
- Install with `/plugin install coolftp-live --marketplace anivdel/coolFTP`, or from `coolftp-live-mod.zip` on coolftp.com with `claude --plugin-dir`.

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

### Added on 2026-09-10

The 0.1.2 installer was rebuilt with this in it, so the SHA-256 on the download page changed with it.

- **Drag to select.** Press in either file list and drag: a box follows the pointer and every row it touches is highlighted, the way Explorer and FileZilla select files, so uploading a handful of files is a drag and a click on Upload. A plain drag replaces the selection, Ctrl+drag toggles the rows in the box, Shift+drag adds them, a click on empty space clears it, and the list scrolls when the pointer goes past its edge. Ctrl+A selects everything in the focused list. The pane's status line now says what is selected, for example "12 files (3.4 MB) + 1 folder selected · 128 items".
- **Drag and drop between the panes.** Grab a file or folder by its icon or name and drop it on the other pane: local to remote uploads, remote to local downloads, and a drop onto a folder row lands inside that folder. A drag from the blank part of a row, the size and date columns, or empty space still draws the selection box, so both gestures work even in a full list. Escape cancels a drag.
- **Pause, resume and cancel from the card.** Every deploy or folder transfer card in the Transfers tab has Pause and Cancel buttons, for agent-driven deploys too. Both let the files in flight finish first; a cancelled deploy saves what landed and can be run again to continue. Each card draws a speed graph of the transfer, and a card that stopped early says why. A manual upload or download of several files or folders, from the buttons or a drag between the panes, now runs as one operation with a card of its own and parallel connections, instead of one small job per file.
- **Deleting shows its progress.** Deleting files or folders from the remote pane is one operation with a card of its own in the Transfers tab, pause and cancel included, and a message says what was deleted when it finishes. The Activity tab still logs it.
- **Claude Desktop extension.** `npm run mcpb` packs the MCP server into `coolFTP-<version>.mcpb`; open it in the Claude Desktop app to install, set a default project folder in its settings, and the chat gets the same tools Claude Code has, with the approvals in coolFTP. `server.json` describes the server for the MCP Registry.

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
