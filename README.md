# coolFTP

A desktop SFTP / FTPS / FTP client that coding agents can drive.

You write code with Claude Code (or Cursor, Codex, whatever). The agent runs `coolftp deploy`. The desktop app shows every call and every file as it lands on your web server. Deploys upload only files whose content hash changed, and each deploy records the git commit that produced it.

```
packages/core   shared TypeScript library: transports, sites, hash manifest, sync, deploy
packages/cli    `coolftp` command line + `coolftp mcp` MCP server for agents
packages/app    Electron desktop app (two-pane browser, transfer queue, live agent feed)
site/           landing page for coolftp.com
scripts/        build + end-to-end test
```

## Run it

```bash
npm install
npm run build
npm run app          # opens the desktop app
```

CLI during development:

```bash
node packages/cli/dist/coolftp.js --help
```

To get a global `coolftp` command from this checkout:

```bash
cd packages/cli && npm link
```

## Add a server

```bash
# SFTP with your existing ~/.ssh key or the ssh-agent
coolftp site add coolftp.com --host coolftp.com --user deploy --root /var/www/html

# FTPS with a password (shared hosts)
coolftp site add oldhost --host ftp.oldhost.net --user me --protocol ftps --password '...' --root /public_html

coolftp site test coolftp.com
```

Or use the **Sites** button in the app. Passwords are stored in plain text in `%APPDATA%\coolftp\sites.json`, so prefer keys for SFTP.

## Link a project and deploy

```bash
cd my-site
coolftp init coolftp.com --local-dir dist --build "npm run build"
coolftp diff                       # preview
coolftp deploy -m "first deploy"
coolftp deploy --delete            # also remove remote files deleted locally
coolftp deploy --commit -m "msg"   # git add -A, git commit, then deploy
coolftp history
```

`coolftp init` writes `.coolftp.json`:

```json
{ "site": "coolftp.com", "localDir": "dist", "build": "npm run build", "ignore": ["*.map"] }
```

Commit it. Add a `.coolftpignore` (gitignore syntax) for anything that must never go up. `.git`, `node_modules`, `.env*`, `*.log` and the coolFTP files are always excluded.

## Let Claude Code drive it

MCP (recommended, gives Claude typed tools):

```bash
claude mcp add coolftp -- node "C:\path\to\cool FTP\packages\cli\dist\coolftp.js" mcp
```

Or per project in `.mcp.json`:

```json
{ "mcpServers": { "coolftp": { "command": "node", "args": ["C:\\path\\to\\cool FTP\\packages\\cli\\dist\\coolftp.js", "mcp"] } } }
```

Tools exposed: `coolftp_sites`, `coolftp_status`, `coolftp_init`, `coolftp_diff`, `coolftp_deploy`, `coolftp_rollback`, `coolftp_history`, `coolftp_ls`, `coolftp_read`, `coolftp_write`, `coolftp_upload`, `coolftp_download`, `coolftp_mkdir`, `coolftp_delete`, `coolftp_rename`.

## Safety rails for agent-driven deploys

- **Approval dialog.** While the desktop app is open, an agent call that deletes a path, deploys with `--delete`, or rolls back pops a dialog in the app and waits for your click. No answer within two minutes is a deny. There is a checkbox to auto-approve for the rest of the session.
- **First-deploy delete guard.** Before a manifest exists on the server, `--delete` is refused if the target folder contains files coolFTP never uploaded. Pass `--delete-untracked` to override.
- **Rollback.** `coolftp rollback` restores the previous commit that was live for the project, using a temporary git worktree so your working tree is untouched. `--to <commit|deployId>` targets any point in history. The Deploys tab in the app has the same buttons.
- **Verification.** Give a site a public `--url` and every deploy prints the URLs of changed files, then fetches the homepage and up to four of them and reports the status codes. MCP results carry the same data so an agent can confirm the site is live.
- **Host key pinning.** SFTP host keys are recorded on first use in `known_hosts.json` and a changed key is refused with a loud error. `coolftp site trust <name>` forgets the recorded key after a legitimate server rebuild; `coolftp site keys` lists them.
- **Encrypted passwords.** On Windows, passwords and key passphrases in `sites.json` are encrypted with DPAPI under your user account. The CLI and the app share the store.
- **Resumable deploys.** Transfers retry up to three times. If a deploy still fails partway, files that landed are written to the manifest so the next run does not repeat them.

Any agent with a shell can simply run `coolftp deploy` inside a linked project. The CLI detects Claude Code, Cursor, Codex, Gemini CLI and Aider from their environment and labels the call accordingly; pass `--agent <name>` to override.

This repo also ships a `/deploy` skill for Claude Code in `.claude/skills/deploy`.

## How agent calls reach the app

When the desktop app is running it listens on a random `127.0.0.1` port and writes `%APPDATA%\coolftp\hub.json` with the port and a per-session token. The CLI and MCP server look for that file, and if the app answers, they send the command to the app instead of running it themselves. Events stream back as NDJSON, so the terminal still shows progress, and the app shows the same call in its **Agents** panel, its transfer queue, and its deploy history. If the app is closed, the CLI runs everything in-process. `--direct` forces that.

## How deploys decide what to upload

1. Scan the local folder, hashing files (SHA-256, cached by size and mtime).
2. Read `<remoteRoot>/.coolftp/manifest.json` from the server. It maps every deployed path to its hash.
3. Upload files whose hash differs or which are missing from the manifest. Files in the manifest but not local are reported as stale and only removed with `--delete`.
4. Write the new manifest, plus a deploy record (git commit, branch, dirty flag, message, agent, counts, duration).

On a server with no manifest yet, the remote tree is walked and compared by size; that first deploy establishes the manifest. `--force` re-uploads everything.

The manifest directory gets a `.htaccess` with `Require all denied`. On nginx, deny `/.coolftp` yourself or point `remoteRoot` above the web root.

## Tests

```bash
npm run e2e
```

Starts a local FTP server (ftp-srv) and a local SFTP server (ssh2, in `scripts/lib/sftp-server.cjs`) in temp directories and drives the CLI through site setup, init, the first-deploy delete guard, deploy, manifest diff, delete sync, `--commit`, rollback by previous commit and by deploy id, push, pull, rename, mkdir, remove, history, encrypted passwords, and SSH host key pinning (a swapped server key is refused, then trusted). 88 checks in total.

## Try it without a real host

```bash
npm run dev:ftp     # ftp://demo:secret@127.0.0.1:2121, remote root /public_html
npm run dev:sftp    # sftp://demo:secret@127.0.0.1:2222, remote root /public_html
```

Both seed a temp folder with a few files. Add a site pointing at one, connect in the app, and deploy any folder at it.

## Package the app

```bash
npm run dist
```

Uses electron-builder with `packages/app/electron-builder.yml`. Output lands in `release/`. Builds are unsigned.
