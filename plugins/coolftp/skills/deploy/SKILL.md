---
name: deploy
description: Deploy the current project to its web server (SFTP, FTPS or FTP shared hosting, cPanel, a VPS) with coolFTP, undo a deploy, or check what is live. Use when the user says "deploy", "ship it", "publish the site", "push to the server", "upload to my host", "put this live", "undo the deploy", "put it back", or asks whether the site is live.
---

# Deploy with coolFTP

coolFTP uploads only files whose content changed, records the git commit with each deploy, keeps the previous versions on the server so a deploy can be undone, and checks the live site afterwards. Use the `coolftp_*` MCP tools this plugin provides. Pass `cwd` as the project's absolute path on every call that takes it, so the right `.coolftp.json` is found.

If the `coolftp_*` tools are not available, the same commands exist as a CLI: `coolftp <command>` (or `npx -y coolftp <command>`), with `--json` for the full result.

## First time in a project

1. `coolftp_status`. If it reports a linked site, go to Deploying.
2. `coolftp_sites` lists the saved servers.
   - **None saved:** the user has to add their server once, and passwords never go through this chat. Tell them the two ways and stop until they say it is done:
     - open the coolFTP desktop app (Windows, coolftp.com) and click **Sites**, or
     - in their own terminal: `npx coolftp site add <name> --host <host> --user <user> --protocol ftps --password '<password>' --root /public_html --url https://their-domain.com` (for SFTP with an SSH key, `--protocol sftp` and no password), then `npx coolftp site test <name>`.
   - **One or more saved:** ask which one this project goes to unless it is obvious.
3. `coolftp_init` with that `site`. Set `localDir` when the deployable output is a build folder such as `dist` or `build`, and `build` when it needs a build step (`npm run build`). If the site's login lands above the web root (shared hosts often show `public_html` at the top), set `remoteRoot: "/public_html"` and `url` to the public address so the live checks fetch the real pages. If you are unsure where the web root is, `coolftp_ls` the top of the server and look.

If a call says the app is not running and mentions a sandboxed copy of the config, ask the user to open the coolFTP app: sites saved in the app are only visible through it.

## Deploying

1. **Preview:** `coolftp_diff`. Summarise the plan in one line (new, changed, stale, size). If it is unexpectedly large, would send files that look private (keys, `.env` variants, backups, database dumps), or this is the first deploy to a server that already has a site on it, stop and ask.
2. **Deploy:** `coolftp_deploy` with a one-line `message` describing the change. Set `commit: true` only when the user asked to commit. Never set `delete` unless the user explicitly asked for files removed locally to be removed from the server too.
3. **Report the verdict, exactly:**
   - `live`: done. Give the counts and the URL.
   - live checks failed: the files landed but the site did not answer as expected. Say "uploaded, but not verified live", with the URL and the status it answered. Never call it live.
   - `stale`: the upload is complete but a cache or CDN in front of the server still serves the old copy for some files. Say so; do not deploy again to fix it.
   - an error before or during the upload: report the message. coolFTP keeps what landed, so running the deploy again continues it.

## Undo and rollback

- "Undo that", "put it back", or a deploy turns out wrong: `coolftp_undo`. It restores the previous versions of the files the last deploy changed or deleted and removes the files it added. It needs no git and works from a dirty tree. `dryRun: true` shows the work first; `to: <deployId>` from `coolftp_history` reverts an older deploy when nothing later touched its files. An undo can itself be undone.
- A specific earlier commit live again: `coolftp_rollback` (the previous live commit) or with `to: <commit or deploy id>`. It needs git. Set `build: true` only if the user confirms the build should run. For "undo the last deploy", prefer `coolftp_undo`.

## What is live

`coolftp_verify` fetches the site and the last deploy's files and reports status codes and whether static files match the local bytes. `coolftp_history` lists deploys with live / failed / stale and whether each can still be undone. `coolftp_stat` says whether a remote file exists and its size without downloading it.

## Approval

While the coolFTP desktop app is open, deletes, `delete` deploys, rollbacks and undos wait for the user to click Allow in the app. A result of "Denied in the coolFTP app" is the user's answer: stop and ask; never retry it or route around it.

## Single files

`coolftp_upload` sends one file; `coolftp_read`, `coolftp_write`, `coolftp_ls`, `coolftp_mkdir`, `coolftp_rename`, `coolftp_delete` work on the server. Relative remote paths resolve against the project's remote directory, the same place deploys go, so never add `public_html/` yourself; only paths starting with `/` are absolute. An upload that had to create a new top-level folder warns, which almost always means a doubled prefix. Prefer a deploy over many single uploads.

## Notes

- Files matching `.coolftpignore`, `.git`, `node_modules`, `.env*`, `*.log` are never uploaded. Suggest a `.coolftpignore` (gitignore syntax) for anything else that must stay private.
- The build in `.coolftp.json` runs before each deploy; set `skipBuild` only if the user asks.
- An auth error means the saved credentials are wrong. Do not guess; ask the user to fix the site in the app or with `coolftp site add` again.
- "Could not open connection" warnings mean the host allows fewer parallel connections; the deploy carried on.
