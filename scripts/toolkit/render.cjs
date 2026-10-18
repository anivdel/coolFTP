// Renders scripts/toolkit/toolkit.html frame by frame into a silent MP4 (narration and music come after).
//   npx electron scripts/toolkit/render.cjs [out.mp4]          default site/toolkit.mp4
//   npx electron scripts/toolkit/render.cjs --frames 60,300    PNG stills into scripts/toolkit/frames
//   --page toolkit-long.html                                   render the long upsell instead
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
const W = 1280, H = 720, FPS = 30;
const args = process.argv.slice(2).filter((a) => !a.startsWith("--inspect"));
const fi = args.indexOf("--frames");
const sample = fi >= 0 ? args[fi + 1].split(",").map(Number) : null;
const pi = args.indexOf("--page");
const page = pi >= 0 ? args[pi + 1] : "toolkit.html";
const out = path.resolve(args.find((a, i) => !a.startsWith("--") && i !== fi + 1 && i !== pi + 1) || path.join(__dirname, "..", "..", "site", "toolkit.mp4"));
const ffmpeg = process.env.FFMPEG || "ffmpeg";

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, frame: false, enableLargerThanScreen: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(60);
  win.setContentSize(W, H);
  await win.loadFile(path.join(__dirname, page), { query: { render: "1" } });
  await win.webContents.executeJavaScript("window.ready");
  const dur = await win.webContents.executeJavaScript("DURATION");
  const grab = async (t) => {
    await win.webContents.executeJavaScript(`render(${t}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`);
    let img = await win.webContents.capturePage();
    const s = img.getSize();
    if (s.width !== W || s.height !== H) img = img.resize({ width: W, height: H, quality: "best" });
    return img;
  };
  await grab(0); await grab(0); // the first capture can be stale
  if (sample) {
    const dir = path.join(__dirname, "frames");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of sample) fs.writeFileSync(path.join(dir, `frame-${String(f).padStart(4, "0")}.png`), (await grab(f / FPS)).toPNG());
    return app.quit();
  }
  const ff = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const N = Math.round(dur * FPS);
  for (let i = 0; i < N; i++) {
    const buf = (await grab(i / FPS)).toBitmap();
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 150 === 0) console.log(`frame ${i}/${N}`);
  }
  ff.stdin.end();
  ff.on("close", (code) => {
    console.log(code === 0 ? `wrote ${out}` : `ffmpeg exited ${code}`);
    app.quit();
  });
});
