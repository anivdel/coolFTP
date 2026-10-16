# coolFTP for Claude Code

One plugin that lets Claude deploy your site to its SFTP, FTPS or FTP host: Hostinger, Bluehost, GoDaddy, any cPanel box, your own VPS. Only files that changed go up, the live site is checked afterwards, and a bad deploy is undone in one step, no git needed.

What it adds to Claude Code:

- **The coolFTP MCP server**, built in. The plugin carries its own copy of the coolftp CLI, so updating the plugin updates the server too: nothing to install from npm, and the desktop app is optional. Set `COOLFTP_BIN` to run a different coolftp instead.
- **A deploy skill** that tells Claude how to deploy safely: preview first, never call a deploy live until the site answered, never delete remote files unless you asked, stop when you deny something in the coolFTP app.
- **Commands:** `/coolftp:setup` links a project to your server, `/coolftp:deploy` deploys, `/coolftp:undo` puts the previous version back, `/coolftp:live` checks what is live.
- **A live panel** beside the chat that shows each deploy as it runs: files flying to your site, the live check, a ✓ or ✗, told in plain English. `/coolftp-panel` opens it again after you close it.

Needs Node 18 or newer. The coolFTP desktop app (Windows) is optional: with it open, deploys show in the app and deletes, undos and rollbacks wait for your click.

## Install

In Claude Code:

```
/plugin install coolftp --marketplace anivdel/coolFTP
```

Answer `y` to add the marketplace, then pick a scope (user installs it for every project).

In the Claude desktop app: click + next to the prompt box, then Plugins, Add marketplace with `anivdel/coolFTP`, then add `coolftp`.

If you registered coolFTP by hand before (`claude mcp add coolftp ...`), remove that copy so Claude does not see every tool twice: `claude mcp remove coolftp -s user`. If you had the older `coolftp-live` mod, `/plugin uninstall coolftp-live`; its panel is part of this plugin now.

## First deploy

Say "set up coolFTP for this project" or run `/coolftp:setup`. Claude finds what folder gets served and links it. Your server is added once, outside the chat so the password never passes through Claude: in the coolFTP app (**Sites**), or in your own terminal:

```
npx coolftp site add myhost --host ftp.example.com --user me --protocol ftps --password 'secret' --root /public_html --url https://example.com
```

Then "deploy this". "Undo that" puts it back.

## Develop

```
claude plugin validate plugins/coolftp
claude plugin test plugins/coolftp
claude --plugin-dir plugins/coolftp
```

`COOLFTP_BIN` points the MCP server at a specific `coolftp` executable, for example a source checkout's `packages/cli/dist/coolftp.js`.
