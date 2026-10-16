// Bundles the Claude Code plugin's panel drawing (plugins/coolftp/hooks/scene.ts: the scene, the
// yeti, the progress bar, the tiles) into scripts/demo/plugin-scene.js as window.Scene, so the
// plugin video draws exactly what the panel draws. Run by `npm run plugin-video`.
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
await esbuild.build({
  // The scene, plus the yeti's rig layers so the end card can pose him frame by frame.
  stdin: {
    contents: 'export * from "./plugins/coolftp/hooks/scene.ts"; export { YETI } from "./plugins/coolftp/hooks/yeti-art.ts";',
    resolveDir: root,
    sourcefile: "plugin-scene-entry.ts",
    loader: "ts",
  },
  outfile: path.join(root, "scripts/demo/plugin-scene.js"),
  bundle: true,
  format: "iife",
  globalName: "Scene",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});
console.log("bundled plugin scene -> scripts/demo/plugin-scene.js");
