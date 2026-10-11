# coolftp-live: a Claude Code mod

Adds a coolFTP panel to Claude Code. Every deploy, upload, live check and undo Claude runs through coolFTP shows up as it happens: a ticking timer while it runs, then a ✓, ! or ✗ with the result in one line (`+1 ~2 −0 · 41 KB · 2s · live`) and a link to the site.

- Works with the coolFTP MCP tools (`coolftp_deploy`, `coolftp_undo`, ...) and with `coolftp ...` commands Claude runs in the shell.
- The status line says what is running; changes to the server end with a toast.
- The last 20 steps are kept, so a new session opens with your recent deploys.
- `/coolftp-panel` opens the panel again after you close it. **Clear** (`c`) empties it.
- It only watches. It never blocks or changes a coolFTP call, even if it fails itself.

## Install

In Claude Code:

```
/plugin install coolftp-live --marketplace anivdel/coolFTP
```

Answer `y` to add the marketplace, then pick a scope.

Or from a folder: download `coolftp-live-mod.zip` from coolftp.com, unzip it, and start Claude Code with `claude --plugin-dir <folder>`.

## Develop

```
claude plugin validate mods/coolftp-live
claude plugin test mods/coolftp-live
```
