// Renders site images in a hidden Electron window (no headless Chrome, no visible window).
//   electron site/scripts/render.cjs assets            -> site/public/og.png + apple-touch-icon.png
//   electron site/scripts/render.cjs og                -> site/public/og.png only
//   electron site/scripts/render.cjs shot <url> <out.png> <width> <height> [scrollY]
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC = path.join(__dirname, "..", "public");
const MARK = fs.readFileSync(path.join(PUBLIC, "favicon.svg"), "utf8");
const MARK_URI = "data:image/svg+xml;base64," + Buffer.from(MARK).toString("base64");
// core/brand.mjs is ESM and this is CommonJS (Electron's main): mirror the two fields it needs.
// Keep in step with BRAND.word / BRAND.tld there.
const BRAND = { word: "noteblock", tld: ".ai" };

app.dock?.hide();
if (process.argv[2] === "assets" || process.argv[2] === "og") app.disableHardwareAcceleration(); // the demo shots need WebGL

let win = null;
async function capture(url, w, h, { wait = 800, scrollY = 0, css = "" } = {}) {
  // One window for every capture: reusing its renderer is more reliable than spawning a new one.
  win ||= new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { offscreen: true } });
  win.setContentSize(w, h);
  if (!win._logs) {
    win._logs = true;
    win.webContents.on("console-message", (e) => { if (e.level === "error" || e.level === "warning") console.warn("page:", e.message); });
  }
  win.webContents.setFrameRate(30);
  await win.loadURL(url).catch((e) => console.warn("load:", e.code, "(capturing anyway)"));
  if (css) await win.webContents.insertCSS(css);
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  if (scrollY) {
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${scrollY}); true`);
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${scrollY + 1}); true`);
  }
  await new Promise((r) => setTimeout(r, wait));
  if (process.env.RENDER_PROBE) console.log("probe:", await win.webContents.executeJavaScript(process.env.RENDER_PROBE));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  return img;
}

let n = 0;
const page = (body, w, h) => {
  const file = path.join(require("node:os").tmpdir(), `quire-render-${process.pid}-${n++}.html`);
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@600&display=swap">
<style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#fff;font-family:Geist,system-ui,sans-serif;color:#15171c}</style>
</head><body>${body}</body></html>`);
  return "file://" + file;
};

async function og() {
  const og = `<div style="box-sizing:border-box;width:1200px;height:630px;padding:96px;display:flex;flex-direction:column;justify-content:space-between;
    background:linear-gradient(180deg,#fff 0%,#f8f9fb 100%);border-bottom:10px solid #3451d1">
    <div style="display:flex;align-items:center;gap:22px;font-size:48px;font-weight:600;letter-spacing:-0.04em">
      <img src="${MARK_URI}" width="96" height="96" style="margin:-10px"><span>${BRAND.word}<span style="color:#9aa0ab">${BRAND.tld}</span></span></div>
    <div style="font-size:112px;font-weight:600;letter-spacing:-0.045em;line-height:0.98">Notes that are<br><span style="color:#8a909c">web apps.</span></div>
    <div style="font-size:30px;color:#5b6270;letter-spacing:-0.01em">Every page is a folder of plain files on your Mac.</div>
  </div>`;
  fs.writeFileSync(path.join(PUBLIC, "og.png"), (await capture(page(og, 1200, 630), 1200, 630)).toPNG());
}

async function assets() {
  await og();
  // Apple touch icon: the mark's rounded square fills the tile (iOS applies its own mask).
  const icon = `<div style="width:180px;height:180px;background:#111"><img src="${MARK_URI}" style="width:224px;height:224px;margin:-22px"></div>`;
  fs.writeFileSync(path.join(PUBLIC, "apple-touch-icon.png"), (await capture(page(icon, 180, 180), 180, 180, { wait: 300 })).toPNG());
}

app.whenReady().then(async () => {
  try {
    const [mode, url, out, w, h, scrollY] = process.argv.slice(2);
    if (mode === "assets") await assets();
    else if (mode === "og") await og();
    else if (mode === "shot") fs.writeFileSync(out, (await capture(url, +w, +h, { wait: 2500, scrollY: +scrollY || 0 })).toPNG());
    else throw new Error("usage: render.cjs assets | og | shot <url> <out> <w> <h> [scrollY]");
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
