import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const alias = { "@coolftp/core": path.join(root, "packages/core/src/index.ts") };
const nodeExternal = ["electron", "cpu-features", "*.node"];
const buildDate = new Date().toISOString().slice(0, 10);
console.log(`build ${pkg.version} dated ${buildDate}`);

/** @type {esbuild.BuildOptions[]} */
const targets = [
  {
    entryPoints: [path.join(root, "packages/cli/src/coolftp.ts")],
    outfile: path.join(root, "packages/cli/dist/coolftp.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    bundle: true,
    alias,
    external: nodeExternal,
    banner: { js: "#!/usr/bin/env node" },
    define: { __VERSION__: JSON.stringify(pkg.version), __BUILD_DATE__: JSON.stringify(buildDate) },
    sourcemap: true,
    logLevel: "info",
  },
  {
    entryPoints: [path.join(root, "packages/app/src/main/main.ts")],
    outfile: path.join(root, "packages/app/dist/main.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    bundle: true,
    alias,
    external: nodeExternal,
    define: { __VERSION__: JSON.stringify(pkg.version), __BUILD_DATE__: JSON.stringify(buildDate) },
    sourcemap: true,
    logLevel: "info",
  },
  {
    entryPoints: [path.join(root, "packages/app/src/main/preload.ts")],
    outfile: path.join(root, "packages/app/dist/preload.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    bundle: true,
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  },
  {
    entryPoints: [path.join(root, "packages/app/src/renderer/app.ts")],
    outfile: path.join(root, "packages/app/dist/renderer/app.js"),
    platform: "browser",
    format: "iife",
    target: "es2022",
    bundle: true,
    sourcemap: true,
    logLevel: "info",
  },
];

function copyStatic() {
  const src = path.join(root, "packages/app/src/renderer");
  const dst = path.join(root, "packages/app/dist/renderer");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["index.html", "styles.css", "logo.png"]) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  const assets = path.join(root, "packages/app/assets");
  if (fs.existsSync(assets)) fs.cpSync(assets, path.join(root, "packages/app/dist/assets"), { recursive: true });
}

/**
 * The Claude Code plugin ships its own copy of the CLI (one file, no dependencies), so a plugin
 * update carries MCP server changes with it: no npm install, no global coolftp, no desktop app.
 */
function bundleIntoPlugin() {
  const dst = path.join(root, "plugins/coolftp/server");
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, "packages/cli/dist/coolftp.js"), path.join(dst, "coolftp.js"));
  fs.writeFileSync(path.join(dst, "VERSION"), `${pkg.version} ${buildDate}\n`);
}

copyStatic();
if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  fs.watch(path.join(root, "packages/app/src/renderer"), () => copyStatic());
  console.log("watching...");
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  bundleIntoPlugin();
  console.log("build complete");
}
