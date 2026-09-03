/*
 * Renders scripts/demo/demo.html into an MP4 by seeking the deterministic timeline
 * frame by frame in an offscreen Electron window and piping PNG frames to ffmpeg.
 *   npx electron scripts/demo/render.cjs                 -> site/demo.mp4 (1280x720, 30 fps)
 *   STILLS=3000,9000,24000 npx electron scripts/demo/render.cjs   -> PNG stills for review
 */
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const HTML = path.join(__dirname, "demo.html");
const OUT = process.env.OUT || path.join(ROOT, "site", "demo.mp4");
const FPS = Number(process.env.FPS || 30);
const STILLS = process.env.STILLS ? process.env.STILLS.split(",").map(Number) : null;
const STILL_DIR = process.env.STILL_DIR || path.join(__dirname, "stills");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(60);
  await win.loadFile(HTML);
  await new Promise((r) => setTimeout(r, 800));
  const duration = await win.webContents.executeJavaScript("window.DURATION");

  // Seek, then wait for the compositor to actually paint the new state before capturing.
  const frame = async (t) => {
    await win.webContents.executeJavaScript(
      `window.seek(${t}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`,
    );
    // The DOM now reflects t; give the offscreen compositor a moment, then grab the frame.
    await new Promise((r) => setTimeout(r, 70));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 720 });
    return img.toPNG();
  };

  if (STILLS) {
    fs.mkdirSync(STILL_DIR, { recursive: true });
    for (const t of STILLS) {
      fs.writeFileSync(path.join(STILL_DIR, `t${t}.png`), await frame(t));
      console.log("still", t);
    }
    app.quit();
    return;
  }

  const ffmpeg = process.env.FFMPEG || require("ffmpeg-static");
  const total = Math.ceil((duration / 1000) * FPS);
  console.log(`rendering ${total} frames at ${FPS} fps (${(duration / 1000).toFixed(1)}s) -> ${OUT}`);
  const ff = spawn(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    OUT,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const exit = new Promise((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  for (let i = 0; i < total; i++) {
    const png = await frame((i / FPS) * 1000);
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 150 === 0) console.log(`  frame ${i}/${total}`);
  }
  ff.stdin.end();
  await exit;
  const size = fs.statSync(OUT).size;
  console.log(`done: ${OUT} (${(size / 1048576).toFixed(1)} MB)`);
  app.quit();
});
