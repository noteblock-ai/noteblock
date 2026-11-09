// H=$(mktemp -d); HOME=$H QUIRE_CONFIG_DIR=$H/.noteblock QUIRE_CAPTURE=/tmp/x.png QUIRE_OPEN_PAGE=Welcome QUIRE_TEST_SCRIPT=scripts/verify-flash-free.mjs ./node_modules/.bin/electron .
//
// A page reloading because its files changed never shows an unloaded frame (usePageSwap.js). Runs
// in the app's main process, in a transparent window that never takes focus, with no host cursor: a hidden window has
// no animation frames to sample. Writes to the page's index.html on disk and samples the app window on every animation
// frame. Not part of CI or `pnpm check`.
//
// "Before" sets window.__quireSwapOff, which makes every reload the plain remount it used to be.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filler = (n, tag = "Filler") => Array.from({ length: n }, (_, i) => `<p>${tag} paragraph ${i}.</p>`).join("\n");
const fileWith = (body, head = "") => `<!doctype html><html><head><title>Welcome</title>${head}</head><body>\n${body}\n</body></html>\n`;

// In the app window: one sample per animation frame.
const SAMPLER = `(() => {
  window.__samples = { n: 0, maxFrames: 0, gapFrames: 0, noneVisible: 0, moves: [], stop: false };
  const tick = () => {
    const s = window.__samples;
    if (s.stop) return;
    const frames = [...document.querySelectorAll(".content iframe")];
    const shown = frames.filter((f) => { const c = getComputedStyle(f); return c.visibility !== "hidden" && Number(c.opacity) > 0; });
    const top = shown[shown.length - 1];
    s.n++;
    s.maxFrames = Math.max(s.maxFrames, frames.length);
    if (!top) s.noneVisible++;
    else if (top.dataset.qLoaded !== "1") s.gapFrames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

const inApp = (win, js) => win.webContents.executeJavaScript(js);
/** Runs in the frame the app has on screen: the only one, or the last that isn't a buffer. */
const inPage = async (win, js) => {
  const all = win.webContents.mainFrame.frames.filter((f) => /^quire:\/\/(vault|p-)/.test(f.url));
  if (!all.length) throw new Error("no page frame");
  return all[all.length - 1].executeJavaScript(js);
};
const frameCount = (win) => inApp(win, `document.querySelectorAll(".content iframe").length`);

async function until(what, fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await Promise.race([fn(), sleep(1000).then(() => false)]);
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what);
    await sleep(20);
  }
}

const hasText = (win, text) => inPage(win, `document.body.textContent.includes(${JSON.stringify(text)})`);
const samplesOn = (win) => inApp(win, SAMPLER);
const samplesOff = (win) => inApp(win, `(window.__samples.stop = true, window.__samples)`);
const settle = async (win) => {
  await until("one iframe", async () => (await frameCount(win)) === 1);
  await sleep(150);
};
const scrollPage = (win, y) => inPage(win, `(window.scrollTo({top:${y},behavior:"instant"}), (document.scrollingElement||document.documentElement).scrollTop)`);
const pageY = (win) => inPage(win, `(document.scrollingElement||document.documentElement).scrollTop`);

const results = [];
function row(name, s, extra = "") {
  console.log("[flash-free]", name, "unloaded frames:", s.gapFrames + s.noneVisible, "of", s.n, extra);
  results.push({ name, samples: s.n, unloaded: s.gapFrames + s.noneVisible, maxFrames: s.maxFrames, extra });
}

export default async function run({ app, win, floating, getVault }) {
  const file = path.join(getVault(), "Welcome", "index.html");
  setTimeout(() => {
    console.error("[quire-test] timed out; got as far as", results.map((r) => r.name).join(", ") || "nothing");
    app.exit(1);
  }, 170000);
  win.webContents.setBackgroundThrottling(false);
  // Ordered in, inactive and fully transparent: animation frames run, nothing shows, focus stays put.
  // Never let it take a click or key status from the app the person is using.
  win.setFocusable(false);
  win.setIgnoreMouseEvents(true);
  win.setOpacity(0);
  win.showInactive();

  const write = (html) => fs.writeFileSync(file, html);
  write(fileWith(filler(300, "Start")));
  await until("the long page", () => hasText(win, "Start paragraph 299"));
  await settle(win);

  /* ---- the same height: exact y, new content, never an unloaded frame */
  let y = await scrollPage(win, 2400);
  assert.ok(y > 2000, "the page should scroll, got " + y);
  await samplesOn(win);
  write(fileWith(filler(300, "Edit1")));
  await until("the first edit", () => hasText(win, "Edit1 paragraph 299"));
  await settle(win);
  let s = await samplesOff(win);
  assert.ok(s.n > 5, "the app window should be animating, got " + s.n + " samples");
  assert.equal(s.gapFrames + s.noneVisible, 0, "an unloaded frame was on top for " + (s.gapFrames + s.noneVisible) + " frames");
  assert.equal(s.maxFrames, 2, "the new page should load in a second frame, saw at most " + s.maxFrames);
  assert.equal(await frameCount(win), 1);
  assert.equal(await pageY(win), y, "the same height keeps the exact y");
  row("same height", s, `y ${y} -> ${await pageY(win)}`);

  /* ---- a different height: the same ratio */
  const before = await inPage(win, `(() => { const e = document.scrollingElement; return { y: e.scrollTop, max: e.scrollHeight - e.clientHeight }; })()`);
  await samplesOn(win);
  write(fileWith(filler(600, "Edit2")));
  await until("the taller edit", () => hasText(win, "Edit2 paragraph 599"));
  await settle(win);
  s = await samplesOff(win);
  const after = await inPage(win, `(() => { const e = document.scrollingElement; return { y: e.scrollTop, max: e.scrollHeight - e.clientHeight }; })()`);
  assert.equal(s.gapFrames + s.noneVisible, 0);
  assert.ok(Math.abs(after.y / after.max - before.y / before.max) < 0.01, `ratio ${before.y / before.max} became ${after.y / after.max}`);
  row("taller page", s, `ratio ${(before.y / before.max).toFixed(3)} -> ${(after.y / after.max).toFixed(3)}`);

  /* ---- a newer change during the wait restarts the buffer: still at most 2 frames */
  const slow = `<script>{const t=Date.now();while(Date.now()-t<500);}</script>`;
  write(fileWith(filler(300, "Base")));
  await until("base", () => hasText(win, "Base paragraph 299"));
  await settle(win);
  await samplesOn(win);
  write(fileWith(filler(300, "Burst1"), slow));
  await sleep(250);
  write(fileWith(filler(300, "Burst2"), slow));
  await sleep(250);
  write(fileWith(filler(300, "Burst3")));
  await until("the last of a burst", () => hasText(win, "Burst3 paragraph 299"));
  await settle(win);
  s = await samplesOff(win);
  assert.ok(s.maxFrames <= 2, "a burst stacked " + s.maxFrames + " iframes");
  assert.equal(s.gapFrames + s.noneVisible, 0);
  row("burst of 3 changes", s);

  /* ---- a load past 3 s swaps anyway */
  await samplesOn(win);
  const t0 = Date.now();
  write(fileWith(filler(50, "Stuck"), `<script>{const t=Date.now();while(Date.now()-t<3600);}</script>`));
  await until("a swap at the deadline", () => hasText(win, "Stuck paragraph 49"), 12000);
  await settle(win);
  s = await samplesOff(win);
  assert.equal(await frameCount(win), 1);
  assert.ok(Date.now() - t0 < 9000);
  row("load past the deadline", s, `on screen after ${Date.now() - t0} ms`);

  /* ---- caret and focus move to the new frame */
  write(fileWith(`<h1>Welcome</h1>\n<p>First block</p>\n<p>Second block of text</p>`));
  await until("the caret page", () => hasText(win, "Second block of text"));
  await settle(win);
  await sleep(300);
  await inPage(win, `(() => {
    const r = document.querySelector("[data-q-region]");
    const p = [...r.querySelectorAll("p")].pop();
    r.focus();
    getSelection().collapse(p.firstChild, 6);
    return p.textContent;
  })()`);
  await inApp(win, `document.querySelector(".content iframe").focus()`);
  write(fileWith(`<h1>Welcome</h1>\n<p>First block changed</p>\n<p>Second block of text</p>`));
  await until("the caret edit", () => hasText(win, "First block changed"));
  await settle(win);
  const caret = await inPage(win, `(() => { const s = getSelection(); return { text: s.focusNode && s.focusNode.textContent, offset: s.focusOffset }; })()`);
  assert.equal(await inApp(win, `document.activeElement === document.querySelector(".content iframe")`), true, "the new frame has focus");
  assert.deepEqual(caret, { text: "Second block of text", offset: 6 });

  /* ---- unsaved typing is saved first and is on screen after the swap */
  await inPage(win, `(() => {
    const r = document.querySelector("[data-q-region]");
    const p = [...r.querySelectorAll("p")].pop();
    p.append(" typed-here");
    r.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    return true;
  })()`);
  fs.utimesSync(file, new Date(), new Date()); // a change the watcher sees, while the typing is unsaved
  fs.appendFileSync(file, "\n");
  await until("the typing to survive", () => fs.readFileSync(file, "utf8").includes("typed-here"));
  await settle(win);
  await sleep(600);
  assert.equal(await hasText(win, "typed-here"), true, "the typing is on screen after the reload");

  await sleep(1600); // the watcher ignores this file for 1.5 s after main wrote it (that save)

  /* ---- a page with a canvas uses the plain reload: it never runs twice */
  write(fileWith(filler(100, "Canvas") + `<canvas width="10" height="10"></canvas>`));
  await until("the canvas page", () => hasText(win, "Canvas paragraph 99"));
  await settle(win);
  await samplesOn(win);
  write(fileWith(filler(100, "Canvas2") + `<canvas width="10" height="10"></canvas>`));
  await until("the canvas edit", () => hasText(win, "Canvas2 paragraph 99"));
  await settle(win);
  s = await samplesOff(win);
  assert.equal(s.maxFrames, 1, "a canvas page never has a second frame");
  row("canvas page, plain reload", s);

  /* ---- real pixels: every frame the window paints during a swap of a dark page, then without one */
  const DARK = `<style>html,body{background:#102030!important;color:#102030!important}</style>`;
  const painted = async (tag) => {
    const t = { n: 0, white: 0 };
    win.webContents.beginFrameSubscription(false, (image) => {
      const size = image.getSize();
      const px = image.crop({ x: Math.round(size.width * 0.5), y: Math.round(size.height * 0.3), width: Math.round(size.width * 0.2), height: Math.round(size.height * 0.2) }).toBitmap();
      let bright = 0;
      for (let i = 0; i < px.length; i += 16) if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) bright++;
      t.n++;
      if (bright / (px.length / 16) > 0.5) {
        t.white++;
        if (process.env.FLASH_DEBUG_DIR) fs.writeFileSync(path.join(process.env.FLASH_DEBUG_DIR, `${tag}-${t.n}.png`), image.toPNG());
      }
    });
    write(fileWith(filler(300, tag), DARK));
    await until("the dark edit", () => hasText(win, tag + " paragraph 299"));
    await settle(win);
    await sleep(300);
    win.webContents.endFrameSubscription();
    return t;
  };
  await sleep(1600);
  write(fileWith(filler(300, "DarkBase"), DARK));
  await until("the dark page", () => hasText(win, "DarkBase paragraph 299"));
  await settle(win);
  await sleep(500);
  const on = { n: 0, white: 0 };
  for (let i = 0; i < 8; i++) {
    const t = await painted("DarkOn" + i);
    on.n += t.n;
    on.white += t.white;
    await sleep(200);
  }
  assert.equal(on.white, 0, `${on.white} of ${on.n} painted frames were white`);
  results.push({ name: "painted frames, 8 swaps", samples: on.n, unloaded: on.white, maxFrames: "", extra: "unloaded = mostly white" });
  await inApp(win, `window.__quireSwapOff = true`);
  const off = { n: 0, white: 0 };
  for (let i = 0; i < 8; i++) {
    const t = await painted("DarkOff" + i);
    off.n += t.n;
    off.white += t.white;
    await sleep(200);
  }
  await inApp(win, `delete window.__quireSwapOff`);
  assert.ok(off.white > 0, "the white check should see the plain remount's flash");
  results.push({ name: "BEFORE: painted frames, 8 remounts", samples: off.n, unloaded: off.white, maxFrames: "", extra: "unloaded = mostly white" });

  /* ---- before: the plain remount, for the numbers */
  write(fileWith(filler(300, "Off")));
  await until("the off page", () => hasText(win, "Off paragraph 299"));
  await settle(win);
  await inApp(win, `window.__quireSwapOff = true`);
  y = await scrollPage(win, 2400);
  await samplesOn(win);
  write(fileWith(filler(300, "Off2")));
  await until("the off edit", () => hasText(win, "Off2 paragraph 299"));
  await settle(win);
  s = await samplesOff(win);
  row("BEFORE: same height, swap off", s, `y ${y} -> ${await pageY(win)}`);
  await inApp(win, `delete window.__quireSwapOff`);

  /* ---- the floating note, the mirror case: same hook. Its window stays hidden, so a timer samples. */
  await floating.capture(path.join(os.tmpdir(), `flash-free-note-${process.pid}.png`), { delay: 1500 });
  const note = floating.webContents();
  const notePage = await note.executeJavaScript(`window.quireApp.floatingPage().then((p) => p.path)`);
  const noteFile = path.join(getVault(), ...notePage.split("/"), "index.html");
  const inNote = async (js) => {
    const all = note.mainFrame.frames.filter((f) => /^quire:\/\/(vault|p-)/.test(f.url));
    return all[all.length - 1].executeJavaScript(js);
  };
  fs.writeFileSync(noteFile, fileWith(filler(200, "Note1")));
  await until("the note's page", () => inNote(`document.body.textContent.includes("Note1 paragraph 199")`));
  await sleep(300);
  const noteY = await inNote(`(window.scrollTo({top:1200,behavior:"instant"}), (document.scrollingElement||document.documentElement).scrollTop)`);
  await note.executeJavaScript(`(() => {
    window.__noteSamples = { n: 0, maxFrames: 0, gapFrames: 0, noneVisible: 0 };
    window.__noteTimer = setInterval(() => {
      const s = window.__noteSamples, frames = [...document.querySelectorAll(".floating-body iframe")];
      const shown = frames.filter((f) => Number(getComputedStyle(f).opacity) > 0), top = shown[shown.length - 1];
      s.n++;
      s.maxFrames = Math.max(s.maxFrames, frames.length);
      if (!top) s.noneVisible++;
      else if (top.dataset.qLoaded !== "1") s.gapFrames++;
    }, 8);
  })()`);
  fs.writeFileSync(noteFile, fileWith(filler(200, "Note2")));
  await until("the note's edit", () => inNote(`document.body.textContent.includes("Note2 paragraph 199")`));
  await until("one frame in the note", () => note.executeJavaScript(`document.querySelectorAll(".floating-body iframe").length === 1`));
  await sleep(200);
  s = await note.executeJavaScript(`(clearInterval(window.__noteTimer), window.__noteSamples)`);
  assert.equal(s.gapFrames + s.noneVisible, 0, "the note showed an unloaded frame");
  assert.equal(s.maxFrames, 2, "the note's new page should load in a second frame");
  assert.equal(await inNote(`(document.scrollingElement||document.documentElement).scrollTop`), noteY);
  row("floating note", s, `y ${noteY} kept`);

  console.table(results);
  console.log("verify-flash-free: ok");
}
