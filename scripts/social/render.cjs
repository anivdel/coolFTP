// Renders each board in social.html to a PNG at its exact size.  npx electron scripts/social/render.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(ROOT, "site");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 1400, show: false, frame: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, "social.html"));
  await new Promise((r) => setTimeout(r, 700));
  const boards = [["og", "social-1200x630.png"], ["sq", "social-1080x1080.png"]];
  for (const [id, file] of boards) {
    // Show only this board and size the viewport to it exactly, so nothing is cut off.
    const rect = await win.webContents.executeJavaScript(`(() => { for (const b of document.querySelectorAll(".board")) b.style.display = b.id === ${JSON.stringify(id)} ? "" : "none"; window.scrollTo(0, 0); const q = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { width: q.width, height: q.height }; })()`);
    win.setContentSize(Math.round(rect.width), Math.round(rect.height));
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: Math.round(rect.width), height: Math.round(rect.height) });
    fs.writeFileSync(path.join(OUT, file), img.toPNG());
    console.log(file, img.getSize());
  }
  app.quit();
});
