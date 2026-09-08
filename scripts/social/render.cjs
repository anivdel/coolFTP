// Renders each .board in an HTML file to a PNG at its exact size.
//   npx electron scripts/social/render.cjs                      # social.html -> site/
//   npx electron scripts/social/render.cjs update-0.1.1.html out/dir
// Each board names its file with data-file="name.png".
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const HTML = path.resolve(__dirname, args[0] || "social.html");
const OUT = path.resolve(ROOT, args[1] || "site");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 1400, show: false, frame: false, webPreferences: { offscreen: true } });
  await win.loadFile(HTML);
  await new Promise((r) => setTimeout(r, 700));
  const boards = await win.webContents.executeJavaScript(`[...document.querySelectorAll(".board")].map((b) => [b.id, b.dataset.file])`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [id, file] of boards) {
    // Show only this board and size the viewport to it exactly, so nothing is cut off.
    const rect = await win.webContents.executeJavaScript(`(() => { for (const b of document.querySelectorAll(".board")) b.style.display = b.id === ${JSON.stringify(id)} ? "" : "none"; window.scrollTo(0, 0); const q = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { width: q.width, height: q.height }; })()`);
    win.setContentSize(Math.round(rect.width), Math.round(rect.height));
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: Math.round(rect.width), height: Math.round(rect.height) });
    fs.writeFileSync(path.join(OUT, file), img.toPNG());
    console.log(path.join(OUT, file), img.getSize());
  }
  app.quit();
});
