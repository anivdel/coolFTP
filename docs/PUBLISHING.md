# Publishing a release

Everything a stranger can install comes from three places: npm (the CLI and MCP server), coolftp.com (the Windows app and the `.mcpb`), and the MCP Registry (which points at both). Directories such as Smithery, Glama, PulseMCP and mcp.so read from the registry and from npm, so keep those two current and the rest follows.

## 0. Bump

1. Set the version in `package.json` and `packages/cli/package.json` (same number).
2. Add the release to `CHANGELOG.md` and the News section of `site/index.html`.
3. `npm install` so `package-lock.json` carries the new version, then commit.

## 1. Build and test

```bash
npm ci
npm run build
npm run typecheck
npm run e2e
```

## 2. Publish the CLI to npm

One-time: `npm login` (the account that owns the `coolftp` name). Then, from the repo root:

```bash
cd packages/cli
npm pack --dry-run        # expect exactly: dist/coolftp.js, README.md, LICENSE, package.json
npm publish
```

The package declares no dependencies on purpose: `dist/coolftp.js` is a single esbuild bundle. Prove it after publishing:

```bash
npx -y coolftp@latest --version
```

## 3. Ship the app and the extension

```bash
npm run dist              # release/coolFTP-<version>-x64.exe and coolFTP-portable.exe
npm run mcpb              # release/coolFTP-<version>.mcpb, and updates server.json with its SHA-256
```

Copy the three files into `site/releases/`, put their SHA-256s and the download links into `site/index.html`, and deploy the site (`coolftp deploy` from `site/`, or "deploy the site" in Claude Code).

## 4. Publish to the MCP Registry

One-time: install the publisher (see https://github.com/modelcontextprotocol/registry, "Publishing") and `mcp-publisher login github` with the GitHub account that owns `anivdel/coolFTP`. The `io.github.anivdel/*` namespace is validated through that login; the npm entry is validated through the `mcpName` field in `packages/cli/package.json`, and the `.mcpb` entry through the URL and hash `npm run mcpb` wrote into `server.json`.

The registry accepts `.mcpb` bundles only when they are hosted on a GitHub or GitLab release, not on coolftp.com. Until releases are attached to GitHub, `server.json` lists the npm package only, and the `.mcpb` stays a download on coolftp.com. To list it too: create a GitHub release for the tag, attach `release/coolFTP-<version>.mcpb`, and add an `mcpb` package entry whose `identifier` is the release asset URL and whose `fileSha256` is the hash `npm run mcpb` printed.

Note the registry caps `description` at 100 characters; `mcp-publisher validate` checks it before you log in.

After steps 2 and 3 are live:

```bash
mcp-publisher publish
```

## 5. Tag and push

```bash
git tag v<version>
git push && git push --tags
```

## 6. Tell the directories (first release only, then they track the registry)

- Smithery: https://smithery.ai (add server, point at the GitHub repo)
- Glama: https://glama.ai/mcp/servers (submit)
- PulseMCP: https://www.pulsemcp.com/submit
- mcp.so: https://mcp.so (submit)
- Awesome MCP Servers list: open a PR adding `coolftp` under deployment / file systems

Each listing should use the same one-liner as npm: "Deploy a website to its SFTP or FTP host from a coding agent. Only changed files go up, the live site is checked afterward, and a bad deploy is undone without git."
