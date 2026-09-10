---
name: deploy
description: Deploy the current project to its web server with coolFTP. Use when the user says "deploy", "ship it", "push to the server", "put this live", "undo the deploy", or asks what is live.
---

# Deploy with coolFTP

The `coolftp` CLI uploads only files whose content changed, records the git commit with each deploy, keeps the previous versions on the server so the deploy can be undone, checks the live site afterwards, and shows the whole run live in the coolFTP desktop app when it is open.

Locate the CLI: if a global `coolftp` exists use it, otherwise use `node "<repo>/packages/cli/dist/coolftp.js"` where `<repo>` is the coolFTP checkout. If the `coolftp_deploy` MCP tool is available, prefer it over the shell; the MCP results are already summarised for you.

## Steps

1. Check the project is linked: `coolftp status`. If there is no `.coolftp.json`, ask the user which site to use (list them with `coolftp site list`) and run `coolftp init <site>` with `--local-dir` if the deployable output is a build folder such as `dist`. If the site's FTP root is not the web root (for example the login lands one level above `public_html`), pass `--remote-root /public_html` and `--url https://the-domain.com` so verification checks the real URLs. If `status` says the app is not running and mentions a sandboxed copy of the config, ask the user to open the coolFTP app; sites saved in the app are only visible through it.
2. Preview first: `coolftp diff`. Summarise the plan in one line (new, changed, stale, bytes). Long plans are already grouped by folder. If the plan is unexpectedly large or includes files that look private, stop and ask.
3. Deploy: `coolftp deploy -m "<one line describing the change>"`. Add `--commit` when the user asked to commit as part of deploying. Never pass `--delete` unless the user explicitly asked for stale remote files to be removed. Use `-q` for big deploys; the result line, warnings, errors and the live checks still print.
4. Read the exit code. 0 means uploaded and, when the site has a URL, verified live. **3 means the files landed but the live checks failed**; the verdict line names the URL and the status it answered. Report that as "uploaded, but not verified live", never as live. 1 is an error before or during the upload; the message says what.
5. Report the result line coolFTP prints (counts, duration, commit) and the verdict. "live, but N files are still served from an old copy" means the upload is complete and a cache or CDN in front of the server has not picked it up yet; say so, and do not re-deploy to fix it.

## Undo

When the user says "undo that", "put it back", or a deploy turns out wrong: `coolftp undo` restores the previous versions of the files the last deploy changed or deleted and removes the files it added. It needs no git and works from a dirty tree. `coolftp undo --dry-run` shows what it would do; `coolftp undo --to <deployId>` reverts an older deploy from `coolftp history` when nothing later touched its files. An undo can itself be undone with another `coolftp undo`. The app asks the user to approve an undo when it is open.

## Rolling back

When the user wants a specific earlier commit live again: `coolftp rollback` (previous live commit) or `coolftp rollback --to <commit or deploy id>` from `coolftp history`. Rollback needs git and a coolFTP manifest on the server. It deploys the committed files of that commit; add `--build` only if the user confirms the build step should run. For "undo the last deploy" prefer `coolftp undo`.

## Checking what is live

`coolftp verify` fetches the site's public URL and the last deploy's files (or `coolftp verify <paths...>`) and reports the status codes, plus whether static files are being served with the local bytes. Exit code 3 when a check fails. `coolftp history` shows each deploy with live / failed / stale and whether it can still be undone. `coolftp stat <path>` says whether a remote file exists and how big it is, without downloading it.

## Approval

While the coolFTP desktop app is open, deletes, `--delete` deploys, rollbacks and undos wait for the user to click Allow in the app. If a call comes back "Denied in the coolFTP app", stop and ask; do not retry or route around it with `--direct`.

## Single files and browsing

For one file, `coolftp push <local> <remote>` (or `coolftp_upload`). Relative remote paths, and the paths for `ls`, `stat`, `cat`, `pull`, `rm`, `mkdir` and `mv`, resolve against the project's remote directory from `.coolftp.json`, the same place `deploy` writes to. So inside a project linked with `--remote-root /public_html`, `coolftp push js/app.js js/app.js` lands at `/public_html/js/app.js`. Do not add the remote directory as a prefix yourself; a push that had to create a new top-level folder prints a warning, which almost always means a stale prefix. Only paths starting with `/` are absolute on the server. A pushed file's size is confirmed by the server, and a push inside the project's remote directory is recorded in the deploy manifest, so the next deploy does not upload it again.

Deleting remote files goes through `coolftp_delete` (or `coolftp rm`); the app asks the user to approve it. Do not work around a denied delete.

## Notes

- `coolftp deploy --dry-run --json` gives a machine-readable plan; `--json` on any command prints its full result.
- Build commands configured in `.coolftp.json` run automatically before each deploy. Pass `--no-build` only if the user asks.
- Files matching `.coolftpignore`, `.git`, `node_modules`, `.env*`, `*.log` and `.gitkeep` are never uploaded.
- Big FTP deploys use up to four connections; a "Could not open connection" warning means the host allows fewer and the deploy continued with what it got.
- If the deploy fails with an auth error, do not retry with guessed credentials. Tell the user to fix the site in the coolFTP app.
- A "the coolFTP app is X and this CLI is Y" warning means the installed app is a different version; tell the user, and remember that commands routed through the app run with the app's version.
