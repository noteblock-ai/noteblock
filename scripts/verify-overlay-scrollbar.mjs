// H=$(mktemp -d); HOME=$H QUIRE_CONFIG_DIR=$H/.noteblock QUIRE_CAPTURE=/tmp/x.png QUIRE_OPEN_PAGE=Welcome QUIRE_TEST_SCRIPT=scripts/verify-overlay-scrollbar.mjs ./node_modules/.bin/electron .
//
// Overlay scrollbar check: a page going from no-scroll to scroll moves nothing, at any window
// width, with a classic scrollbar forced. Runs in the app's main process (hidden window, no host
// cursor). Add `-AppleShowScrollBars Always` after `electron .` for macOS's real classic
// scrollbars. Not part of CI or `pnpm check`.
//
// Classic is forced with a ::-webkit-scrollbar width rule, since Electron on a trackpad Mac
// defaults to overlay. "Before" takes the html.q-overlay-scroll class off, which is the page as
// it was without this feature; "after" leaves it on with the same forcing rule in place.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORCE_PX = 15;
const FORCE = `html::-webkit-scrollbar{width:${FORCE_PX}px}html::-webkit-scrollbar-thumb{background:#888}`;
const filler = (n) => Array.from({ length: n }, (_, i) => `<p>Filler paragraph ${i}.</p>`).join("");
const fileWith = (body, head = "", bodyAttrs = "") => `<!doctype html><html><head><title>Welcome</title>${head}</head><body${bodyAttrs}>\n${body}\n</body></html>\n`;

/** Runs in the page frame. */
const HELPERS = `(() => {
  const probe = () => {
    const r = document.getElementById("probe").getBoundingClientRect();
    return { left: r.left, width: r.width, clientWidth: document.documentElement.clientWidth };
  };
  const region = () => document.querySelector("[data-q-region]");
  window.__os = {
    probe,
    force(on) {
      let s = document.getElementById("os-force");
      if (on && !s) { s = document.createElement("style"); s.id = "os-force"; s.textContent = ${JSON.stringify(FORCE)}; document.head.appendChild(s); }
      if (!on && s) s.remove();
    },
    feature(on) { document.documentElement.classList.toggle("q-overlay-scroll", on); },
    // Types until the page overflows, the way a person does: a new paragraph and a line of text.
    typeToOverflow() {
      const r = region();
      r.focus();
      const sel = getSelection();
      sel.selectAllChildren(r);
      sel.collapseToEnd();
      let n = 0;
      const start = performance.now();
      while (document.documentElement.scrollHeight <= innerHeight + 300 && n < 400) {
        document.execCommand("insertParagraph");
        document.execCommand("insertText", false, "Another line " + n++);
      }
      return { lines: n, msPerLine: (performance.now() - start) / Math.max(1, n) };
    },
    overflow: () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    native() {
      const d = document.createElement("div");
      d.style.cssText = "position:absolute;top:-999px;width:100px;height:100px;overflow:scroll";
      document.documentElement.appendChild(d);
      const w = d.offsetWidth - d.clientWidth;
      const sw = getComputedStyle(d).scrollbarWidth;
      d.remove();
      return { width: w, scrollbarWidth: sw };
    },
    thumb() {
      const t = document.querySelector(".q-scrollbar");
      if (!t) return null;
      const th = t.firstChild, r = th.getBoundingClientRect(), cs = getComputedStyle(th);
      return { on: t.classList.contains("q-on"), armed: t.classList.contains("q-armed"), ui: t.hasAttribute("data-q-ui"), parent: t.parentNode.tagName,
        left: r.left, right: r.right, top: r.top, height: r.height, width: r.width, opacity: +cs.opacity, bg: cs.backgroundColor, pe: getComputedStyle(t).pointerEvents, vw: document.documentElement.clientWidth };
    },
    scrollTop: () => document.scrollingElement.scrollTop,
    hover(x) { document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: 200, bubbles: true })); },
  };
  return true;
})()`;

export default async function run({ win, floating, getVault, BrowserWindow }) {
  const vault = fs.realpathSync(getVault());
  const realHome = fs.realpathSync(os.userInfo().homedir);
  if (vault.startsWith(realHome + path.sep)) throw new Error(`refusing to edit a vault under the real home: ${vault}. See the run line at the top of this file.`);

  const frame = () => win.webContents.mainFrame.frames[0];
  const js = (s) => frame().executeJavaScript(s);
  const until = async (test, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      try { if (frame()) { const v = await js(test); if (v) return v; } } catch {}
      if (Date.now() > end) return null;
      await sleep(50);
    }
  };
  const os_ = (call) => js(`window.__os.${call}`);
  const pageFile = path.join(vault, "Welcome", "index.html");
  const original = fs.readFileSync(pageFile, "utf8");
  const load = async (html) => {
    await sleep(700); // a pending save from the last edit lands before the file is replaced
    fs.writeFileSync(pageFile, html);
    await sleep(300);
    await js("location.reload(); true").catch(() => {});
    await sleep(400);
    assert.ok(await until(`document.readyState === "complete" && document.documentElement.classList.contains("q-edit")`), "the page never reached edit mode");
    await js(HELPERS);
    await sleep(100);
  };
  const eq = (a, b, what) => assert.equal(a, b, `${what}: ${a} vs ${b}`);
  const results = [];
  const ok = (name, detail = "") => { results.push(name); console.log(`ok   ${name}${detail ? "  " + detail : ""}`); };

  const start = fileWith(`<p id="probe">Measured paragraph.</p>`);
  await load(start);
  const native = await os_("native()");
  console.log(`[overlay] system scrollbar width here: ${native.width}px (${native.width ? "classic" : "overlay"}); forcing ${FORCE_PX}px with ::-webkit-scrollbar`);

  /* Before and after, at several widths. */
  const sizes = [[700, 600], [931, 700], [1180, 800], [1533, 900]];
  for (const [w, h] of sizes) {
    win.setContentSize(w, h);
    await sleep(250);
    // Before: the feature off, a classic scrollbar forced.
    await load(start);
    eq(await os_("overflow()"), 0, "the page should start short");
    await os_("force(true)");
    await os_("feature(false)");
    const b0 = await os_("probe()");
    await os_("typeToOverflow()");
    await sleep(50);
    const b1 = await os_("probe()");
    // After: the same forcing rule, the feature on.
    await load(start);
    eq(await os_("overflow()"), 0, "the page should start short");
    await os_("force(true)");
    const a0 = await os_("probe()");
    const typed = await os_("typeToOverflow()");
    assert.ok((await os_("overflow()")) > 0, "the page should overflow");
    await sleep(50);
    const a1 = await os_("probe()");
    console.log(`[overlay] window ${w}: before left ${b0.left} -> ${b1.left}, width ${b0.width} -> ${b1.width}, clientWidth ${b0.clientWidth} -> ${b1.clientWidth} | after left ${a0.left} -> ${a1.left}, width ${a0.width} -> ${a1.width}, clientWidth ${a0.clientWidth} -> ${a1.clientWidth} | typing ${typed.msPerLine.toFixed(2)} ms/line`);
    assert.notEqual(b0.clientWidth, b1.clientWidth, `the before-state should reproduce the shift at ${w}`);
    eq(a1.left, a0.left, `paragraph left at ${w}`);
    eq(a1.width, a0.width, `paragraph width at ${w}`);
    eq(a1.clientWidth, a0.clientWidth, `clientWidth at ${w}`);
  }
  ok("before-state shifts; after-state moves nothing at 4 widths");

  /* The thumb, on a page long enough to scroll. */
  win.setContentSize(1100, 760);
  await sleep(250);
  await load(fileWith(`<p id="probe">Measured paragraph.</p>${filler(150)}`));
  await os_("force(true)");
  await js("window.scrollTo(0, 0)");
  await sleep(1300);
  await js("window.scrollTo(0, 500)");
  assert.ok(await until(`!!document.querySelector(".q-scrollbar.q-on")`, 3000), "the thumb should appear on scroll");
  await sleep(250);
  const t1 = await os_("thumb()");
  assert.ok(t1.ui, "the thumb is in the data-q-ui layer");
  assert.ok(t1.width >= 6 && t1.width <= 8, `thumb width ${t1.width}`);
  assert.ok(t1.vw - t1.right >= 0 && t1.vw - t1.right <= 4, `thumb at the right edge: ${t1.right} of ${t1.vw}`);
  assert.ok(t1.opacity > 0.9, "thumb visible");
  assert.equal(t1.pe, "none", "a thumb shown by scrolling does not take clicks");
  await js("window.scrollTo(0, 3000)");
  await sleep(100);
  const t2 = await os_("thumb()");
  assert.ok(t2.top > t1.top, `thumb follows the scroll: ${t1.top} -> ${t2.top}`);
  ok("thumb appears on scroll, follows it", `${t1.width}px wide, top ${t1.top} -> ${t2.top}, ${t1.bg}, parent <${t1.parent.toLowerCase()}>`);
  await sleep(1150);
  eq((await os_("thumb()")).opacity, 0, "thumb opacity after the fade");
  ok("thumb fades after ~800ms");

  /* Hover and drag. Real input where a hidden window takes it, through the page's own events. */
  const box = await win.webContents.executeJavaScript(`(() => { const r = document.querySelector("iframe").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const send = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(box.x + x), y: Math.round(box.y + y), ...extra });
  await js("window.scrollTo(0, 0)");
  await sleep(100);
  const edge = t1.vw - 3;
  send("mouseMove", edge, 200);
  await sleep(200);
  let real = !!(await os_("thumb()")).armed;
  if (!real) {
    await os_(`hover(${edge})`);
    await sleep(100);
  }
  const h1 = await os_("thumb()");
  assert.ok(h1.armed && h1.opacity > 0, "hover near the edge reveals and arms the thumb");
  assert.equal(h1.pe, "auto");
  ok("hover near the right edge reveals it", real ? "(real mouse event)" : "(dispatched mousemove)");
  await os_(`hover(100)`);
  await sleep(100);
  const hOff = await os_("thumb()");
  assert.ok(!hOff.armed && hOff.pe === "none", "moving away disarms it");
  await os_(`hover(${edge})`);
  await sleep(100);
  const g = await os_("thumb()");
  const gy = g.top + g.height / 2;
  const before = await os_("scrollTop()");
  if (real) {
    send("mouseMove", edge, gy);
    await sleep(50);
    send("mouseDown", edge, gy, { button: "left", clickCount: 1 });
    await sleep(50);
    send("mouseMove", edge, gy + 120, { modifiers: ["leftButtonDown"] });
    await sleep(100);
    send("mouseUp", edge, gy + 120, { button: "left", clickCount: 1 });
    await sleep(100);
  }
  if (!real || (await os_("scrollTop()")) === before) {
    real = false;
    await js(`(() => {
      const t = document.querySelector(".q-scrollbar-thumb");
      const ev = (type, y) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: ${edge}, clientY: y }));
      ev("pointerdown", ${gy}); ev("pointermove", ${gy + 120}); ev("pointerup", ${gy + 120});
    })()`);
  }
  await sleep(100);
  const dragged = await os_("scrollTop()");
  assert.ok(dragged > before + 200, `dragging the thumb scrolls: ${before} -> ${dragged}`);
  ok("dragging the thumb scrolls the page", `${before} -> ${dragged} ${real ? "(real mouse events)" : "(dispatched pointer events)"}`);

  /* Track click. */
  const beforeTrack = await os_("scrollTop()");
  await js(`(() => {
    const t = document.querySelector(".q-scrollbar");
    const y = innerHeight - 4;
    t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: ${edge}, clientY: y }));
  })()`);
  await sleep(50);
  const afterTrack = await os_("scrollTop()");
  assert.ok(afterTrack - beforeTrack > 300, `track click pages down: ${beforeTrack} -> ${afterTrack}`);
  ok("track click pages down", `${beforeTrack} -> ${afterTrack}`);

  /* Wheel and keyboard: the root still scrolls with its scrollbar hidden. */
  await js("window.scrollTo(0, 0)");
  await sleep(50);
  send("mouseWheel", 400, 300, { deltaX: 0, deltaY: -300, canScroll: true });
  await sleep(300);
  const wheeled = await os_("scrollTop()");
  console.log(`[overlay] wheel via sendInputEvent: scrollTop 0 -> ${wheeled}${wheeled ? "" : " (a hidden window drops wheel input; scrollBy stands in below)"}`);
  await js("window.scrollBy(0, 240)");
  await sleep(50);
  assert.ok((await os_("scrollTop()")) >= 240, "the root still scrolls");
  ok("root still scrolls with its native bar hidden");

  /* Inner scrollers keep their scrollbars. */
  const inner = await os_("native()");
  eq(inner.scrollbarWidth, "auto", "an inner scroller's scrollbar-width");
  eq(inner.width, native.width, "an inner scroller's native bar");
  ok("inner scrollers keep their own native scrollbars", `${inner.width}px, scrollbar-width ${inner.scrollbarWidth}`);

  /* Nothing is saved. */
  await js(`(() => { const r = document.querySelector("[data-q-region]"); r.focus(); const s = getSelection(); s.selectAllChildren(r); s.collapseToEnd(); document.execCommand("insertText", false, "saved word"); })()`);
  await sleep(1300);
  const saved = fs.readFileSync(pageFile, "utf8");
  assert.ok(saved.includes("saved word"), "the edit should have saved");
  assert.ok(!/q-scrollbar|q-overlay-scroll/.test(saved), "the thumb and its class stay out of the saved file");
  ok("saved file holds no thumb or class");

  /* Reading mode. */
  await js(`window.postMessage({ quire: 1, type: "mode", edit: false }, "*")`);
  await sleep(150);
  if (await js(`document.documentElement.classList.contains("q-edit")`)) {
    console.log("[overlay] the page ignored a mode message from itself; asked the renderer instead");
    await win.webContents.executeJavaScript(`document.querySelector("iframe").contentWindow.postMessage({ quire: 1, type: "mode", edit: false }, "*")`);
    await sleep(200);
  }
  eq(await js(`document.documentElement.classList.contains("q-edit")`), false, "in reading mode");
  await sleep(1000);
  await js("window.scrollBy(0, 300)");
  await sleep(150);
  assert.ok((await os_("thumb()")).on, "thumb in reading mode");
  ok("works in reading mode");
  await win.webContents.executeJavaScript(`document.querySelector("iframe").contentWindow.postMessage({ quire: 1, type: "mode", edit: true }, "*")`);

  /* Roots that don't scroll, and full-bleed pages. */
  await load(fileWith(`<p id="probe">Short.</p>`));
  await os_(`hover(${t1.vw - 3})`);
  await js("window.dispatchEvent(new Event('scroll'))");
  await sleep(150);
  eq(await os_("thumb()"), null, "thumb on a page that fits");
  ok("a page that fits gets no thumb");

  await load(fileWith(`<p id="probe">Hidden root.</p>${filler(150)}`, `<style>html{overflow:hidden}</style>`));
  await os_(`hover(${t1.vw - 3})`);
  await js("window.dispatchEvent(new Event('scroll'))");
  await sleep(150);
  eq(await os_("thumb()"), null, "thumb with overflow:hidden on html");
  ok("html overflow:hidden gets no thumb");

  await load(fileWith(`<p id="probe">Bare.</p>${filler(150)}`, "", ` data-q-theme="none"`));
  await js("window.scrollTo(0, 300)");
  await sleep(150);
  assert.ok((await os_("thumb()")).on, "thumb on a theme-less page that scrolls");
  ok(`data-q-theme="none" that scrolls gets it`);

  /* Print and the host checks, read from the source. */
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.match(fs.readFileSync(path.join(here, "../app/runtime/theme.css"), "utf8"), /@media print \{\s*\.q-scrollbar \{ display: none !important; \}/);
  ok("hidden in print");

  /* The floating note. */
  if (floating) {
    await floating.capture(path.join(os.tmpdir(), `os-floating-${process.pid}.png`), { delay: 1500 });
    const note = BrowserWindow.getAllWindows().find((w) => w !== win);
    const nf = note && note.webContents.mainFrame.frames.find((f) => f.name === "q-floating");
    if (!nf) console.log("[overlay] floating note opened without a page frame (the picker); not checked there");
    else {
      const out = await nf.executeJavaScript(`(async () => {
        const de = document.documentElement;
        const classOn = de.classList.contains("q-overlay-scroll");
        const w0 = de.clientWidth;
        const d = document.createElement("div"); d.style.height = "4000px"; document.body.appendChild(d);
        de.getBoundingClientRect();
        const w1 = de.clientWidth;
        window.scrollTo(0, 200);
        await new Promise((r) => setTimeout(r, 300));
        const on = !!document.querySelector(".q-scrollbar.q-on");
        d.remove();
        return { classOn, w0, w1, on, floating: de.classList.contains("q-floating") };
      })()`);
      assert.ok(out.floating && out.classOn && out.on, `floating note: ${JSON.stringify(out)}`);
      eq(out.w0, out.w1, "floating note clientWidth");
      ok("floating note gets it", JSON.stringify(out));
    }
  }

  fs.writeFileSync(pageFile, original);
  console.log(`\nverify-overlay-scrollbar: ${results.length} checks passed`);
}
