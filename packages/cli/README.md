# coolftp

Deploy a website to its SFTP, FTPS or FTP host from the terminal, or let a coding agent do it. Built for people who write code with Claude Code, Cursor or Codex and still have to get the files onto a shared host.

- **Only changed files go up.** A manifest on the server records the SHA-256 of every deployed file.
- **Undo without git.** Each deploy keeps the versions it overwrote on the server. `coolftp undo` puts them back.
- **Checked live.** After a deploy the site is fetched and the changed files compared byte for byte. Exit code 3 if it does not answer.
- **Agent-ready.** `coolftp mcp` is an MCP server with 18 typed tools: deploy, diff, undo, verify, rollback, history, ls, stat, read, write, upload, download and more. Results are summarised so they fit in an agent's window.
- **Safety rails.** Pinned SSH host keys, a first-deploy guard that refuses to delete files it never uploaded, changed files swapped into place rather than overwritten, resumable deploys.

Works with any host that speaks SFTP or FTP: Hostinger, HostGator, Bluehost, GoDaddy, any cPanel box, your own VPS. Runs on Windows, macOS and Linux. The optional desktop app (Windows) shows every agent call live and asks you before anything is deleted: [coolftp.com](https://coolftp.com).

## Install

```bash
npm i -g coolftp
```

Or run it without installing: `npx coolftp ...`

## Add a host and deploy

```bash
# a shared host over FTPS with a password
coolftp site add myhost --host ftp.example.com --user me --protocol ftps --password '...' --root /public_html --url https://example.com

# or SFTP with your existing key or ssh-agent
coolftp site add vps --host example.com --user deploy --root /var/www/html --url https://example.com

coolftp site test myhost

cd my-site
coolftp init myhost --local-dir dist --build "npm run build"
coolftp diff                 # what would go up
coolftp deploy -m "v1"       # upload only the changed files, then check the site is live
coolftp undo                 # put the previous versions back, no git needed
coolftp verify               # re-run the live checks
coolftp history              # what went live, when, from which commit
```

`coolftp init` writes a `.coolftp.json` into the project. Commit it; anyone on the team, human or agent, deploys the same way.

## Give your coding agent the tools

Claude Code, macOS and Linux:

```bash
claude mcp add --scope user coolftp -- coolftp mcp
```

Claude Code on Windows (npm bins are `.cmd` shims, so go through `cmd`):

```bash
claude mcp add --scope user coolftp -- cmd /c coolftp mcp
```

Cursor, Windsurf or any other MCP client, in its `mcp.json`:

```json
{ "mcpServers": { "coolftp": { "command": "coolftp", "args": ["mcp"] } } }
```

Then say "deploy this". Any agent with a shell can also just run `coolftp deploy` inside a linked project.

Full documentation, the desktop app and the Claude Desktop extension: [coolftp.com](https://coolftp.com) · [GitHub](https://github.com/anivdel/coolFTP)

MIT. Free for personal projects; a commercial-use license (coolFTP Pro, one-time) funds the project.
