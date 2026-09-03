---
name: deploy
description: Deploy the current project to its web server with coolFTP. Use when the user says "deploy", "ship it", "push to the server", "put this live", or asks what is live.
---

# Deploy with coolFTP

The `coolftp` CLI uploads only files whose content changed, records the git commit with each deploy, and shows the whole run live in the coolFTP desktop app when it is open.

Locate the CLI: if a global `coolftp` exists use it, otherwise use `node "<repo>/packages/cli/dist/coolftp.js"` where `<repo>` is the coolFTP checkout. If the `coolftp_deploy` MCP tool is available, prefer it over the shell.

## Steps

1. Check the project is linked: `coolftp status`. If there is no `.coolftp.json`, ask the user which site to use (list them with `coolftp site list`) and run `coolftp init <site>` with `--local-dir` if the deployable output is a build folder such as `dist`.
2. Preview first: `coolftp diff`. Summarise the plan in one line (new, changed, stale, bytes). If the plan is unexpectedly large or includes files that look private, stop and ask.
3. Deploy: `coolftp deploy -m "<one line describing the change>"`. Add `--commit` when the user asked to commit as part of deploying. Never pass `--delete` unless the user explicitly asked for stale remote files to be removed.
4. Report the result line coolFTP prints (counts, duration, commit) and nothing else.

## Notes

- `coolftp deploy --dry-run --json` gives a machine-readable plan.
- Build commands configured in `.coolftp.json` run automatically before each deploy. Pass `--no-build` only if the user asks.
- Files matching `.coolftpignore`, `.git`, `node_modules`, `.env*` and `*.log` are never uploaded.
- If the deploy fails with an auth error, do not retry with guessed credentials. Tell the user to fix the site in the coolFTP app.
