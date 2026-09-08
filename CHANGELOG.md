# Changelog

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
