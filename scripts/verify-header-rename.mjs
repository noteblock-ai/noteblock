// Header ↔ page name in the real app, in a hidden capture window (no window on screen, no host
// cursor). Runs inside the app's main process through QUIRE_TEST_SCRIPT. Not part of CI.
//
//   pnpm build; H=$(mktemp -d); HOME=$H QUIRE_CONFIG_DIR=$H/.noteblock QUIRE_CAPTURE=/tmp/x.png QUIRE_OPEN_PAGE=Welcome QUIRE_CAPTURE_DELAY=3500 QUIRE_TEST_SCRIPT=scripts/verify-header-rename.mjs ./node_modules/.bin/electron .
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPage } from "../core/index.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `(() => {
  const h1 = () => document.querySelector("[data-q-region] > h1");
  const tick = () => document.dispatchEvent(new Event("selectionchange"));
  const place = (el, at) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const t = walk.nextNode();
    const sel = getSelection();
    if (t) sel.collapse(t, at === "end" ? t.length : Math.min(at, t.length));
    else sel.collapse(el, 0);
    tick();
  };
  window.__t = {
    h1, tick, place,
    ready: () => !!document.querySelector('[data-q-region][contenteditable="true"]') && !!(window.quire && window.quire.page.path),
    // Select the header, type over it.
    setHeader(text) {
      const h = h1();
      h.closest("[data-q-region]").focus();
      const r = document.createRange();
      r.selectNodeContents(h);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      tick();
      if (text) document.execCommand("insertText", false, text);
      else document.execCommand("delete");
      tick();
      return h1().textContent;
    },
    // The caret moves to the block after the header, some text lands there at once.
    leave(type) {
      place(h1().nextElementSibling, 2);
      if (type) document.execCommand("insertText", false, type);
      tick();
    },
    caret() {
      const sel = getSelection();
      const n = sel.anchorNode;
      return { block: n && (n.nodeType === 1 ? n : n.parentElement).closest("h1,p")?.tagName, text: n && n.textContent, offset: sel.anchorOffset };
    },
    key(k, opts) {
      const ev = new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true, ...opts });
      (getSelection().anchorNode?.parentElement || document.body).dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    state: () => ({ marker: window.__marker || 0, path: window.quire.page.path, url: location.pathname, h1: h1() && h1().textContent, title: window.quire.page.title }),
  };
  return true;
})()`;

async function run({ win, getVault }) {
  const vault = fs.realpathSync(getVault());
  const frame = () => win.webContents.mainFrame.frames[0];
  setTimeout(() => {
    console.error("verify-header-rename: timed out");
    process.exit(2);
  }, 100000).unref();
  // A frame being replaced can leave executeJavaScript hanging.
  const once = (s) => Promise.race([frame().executeJavaScript(s), sleep(2000).then(() => Promise.reject(new Error("no answer from the frame")))]);
  const js = async (s) => {
    for (let i = 0; ; i++) {
      try {
        return await once(s);
      } catch (e) {
        if (i > 10) throw e;
        await sleep(200);
      }
    }
  };
  const app = (s) => win.webContents.executeJavaScript(s);
  const file = (p, f = "index.html") => fs.readFileSync(path.join(vault, p, f), "utf8");
  const has = (p) => fs.existsSync(path.join(vault, p));
  const log = () => execFileSync("git", ["log", "--format=%s", "-n", "12"], { cwd: vault, encoding: "utf8" });
  const until = async (what, fn, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > ms) throw new Error("timed out: " + what);
      await sleep(40);
    }
  };
  let passed = 0;
  const check = (name, fn) => {
    fn();
    passed++;
    console.log("ok   " + name);
  };
  const open = async (p) => {
    await sleep(600); // the watcher has told the app about a page made just now
    await js(`window.quire.navigate(${JSON.stringify(p)})`);
    await until("open " + p, async () => {
      await js(HELPERS);
      return js(`window.__t.ready() && window.quire.page.path === ${JSON.stringify(p)}`);
    });
    await js("window.__marker = 1; true");
  };
  const page = (name, html) => createPage(vault, name, { content: `<!doctype html><html><head><title>${name}</title></head><body>\n${html}\n</body></html>\n` });

  page("Alpha", "<h1>Alpha</h1>\n<p>first line</p>\n<p>second line</p>");
  page("Home", '<h1>Home</h1>\n<p><a href="../Alpha/">to alpha</a></p>');
  page("Taken", "<h1>Taken</h1>\n<p>x</p>");
  page("Different", "<h1>A title on purpose</h1>\n<p>x</p>");
  page("Selfy", '<h1>Selfy</h1>\n<p><a href="../Selfy/">me</a></p>');
  page("NoHead", "<p>intro</p>\n<div>atomic</div>\n<h1>NoHead</h1>\n<p>x</p>");
  createPage(vault, "Mark", { format: "md", content: "---\na: 1\n---\n# Mark\n\nbody text\n" });
  page("Side", "<h1>Side</h1>\n<p>keep   these   bytes</p>");
  page("Side2", "<h1>Other title</h1>\n<p>x</p>");
  createPage(vault, "SideMd", { format: "md", content: "# SideMd\n\n```\n# SideMd\n```\n" });
  page("Side3", "<h1>Side3</h1>\n<p>x</p>");

  /* ---- the rename, with the frame staying up */
  await open("Alpha");
  assert.equal(await js('window.__t.setHeader("Alpha two")'), "Alpha two");
  await js('window.__t.leave("X"); true');
  await until("Alpha renamed", () => has("Alpha two") && !has("Alpha"));
  await until("frame told", () => js('window.__t.state().path === "Alpha two"'));
  await sleep(1500);
  const a = await js("window.__t.state()");
  const c1 = await js("window.__t.caret()");
  check("folder renamed", () => assert.ok(has("Alpha two") && !has("Alpha")));
  check("inbound link rewritten", () => assert.ok(file("Home").includes('href="../Alpha%20two/"'), file("Home")));
  check("committed", () => assert.match(log(), /Rename Alpha to Alpha two/));
  check("frame not reloaded", () => assert.equal(a.marker, 1));
  check("frame's path and URL follow", () => assert.deepEqual([a.path, a.url, a.title], ["Alpha two", "/Alpha%20two/", "Alpha two"]));
  check("the main process sees the new URL", () => assert.match(frame().url, /\/Alpha%20two\/$/));
  check("caret stays in the block they moved to", () => assert.deepEqual([c1.block, c1.offset], ["P", 3]));
  check("typing after the rename is kept", () => assert.ok(/fiXrst line/.test(file("Alpha two")), file("Alpha two")));
  check("header saved", () => assert.ok(file("Alpha two").includes("<h1>Alpha two</h1>")));
  assert.equal(await app('document.querySelectorAll("iframe[data-q-frame]").length'), 1);
  await js('window.__t.place(window.__t.h1().nextElementSibling, 1); document.execCommand("insertText", false, "Y"); true');
  await until("save lands on the new path", () => /fYiXrst|Yf/.test(file("Alpha two")) || file("Alpha two").includes("Y"));
  check("a save after the rename lands in the new folder", () => assert.ok(!has("Alpha")));

  /* ---- ⌘Z restores the name when the header changes back */
  for (let i = 0; i < 6; i++) {
    await js('window.__t.key("z", { metaKey: true }); true');
    await sleep(60);
    if ((await js("window.__t.h1().textContent")) === "Alpha") break;
  }
  const u = await js("window.__t.caret()");
  console.log("     after undo the caret is in", u.block);
  assert.equal(await js("window.__t.h1().textContent"), "Alpha");
  await js("window.__t.tick(); window.__t.place(window.__t.h1(), 'end'); window.__t.leave(); true");
  await until("undo renames back", () => has("Alpha") && !has("Alpha two"));
  check("undo of the header, then leaving, restores the name", () => assert.ok(file("Home").includes('href="../Alpha/"')));
  await until("frame told", () => js('window.__t.state().path === "Alpha"'));
  assert.equal(await js("window.__marker"), 1);

  /* ---- refusals: nothing happens, and the header stays as typed */
  await js('window.__t.setHeader("Taken"); window.__t.leave(); true');
  await sleep(900);
  check("taken name: no rename, header stays", () => assert.ok(has("Alpha") && file("Alpha").includes("<h1>Taken</h1>")));
  await js('window.__t.setHeader("Alpha three"); window.__t.leave(); true');
  await until("fixing a refused header renames", () => has("Alpha three"));
  check("a refused header stays tied: fixing it renames", () => assert.ok(!has("Alpha")));
  await until("frame told", () => js('window.__t.state().path === "Alpha three"'));

  await js('window.__t.setHeader(""); window.__t.leave(); true');
  await sleep(700);
  check("empty header: no rename", () => assert.ok(has("Alpha three")));
  await js('window.__t.setHeader("Alpha four"); window.__t.leave(); true');
  await until("empty then typed renames", () => has("Alpha four"));
  await until("frame told", () => js('window.__t.state().path === "Alpha four"'));

  await js('window.__t.setHeader("Bad: name"); window.__t.leave(); true');
  await sleep(900);
  check("a character Windows can't hold: no rename", () => assert.ok(has("Alpha four") && !has("Bad: name") && file("Alpha four").includes("<h1>Bad: name</h1>")));
  await js('window.__t.setHeader("Ends with dot."); window.__t.leave(); true');
  await sleep(900);
  check("trailing dot: no rename", () => assert.ok(has("Alpha four") && !has("Ends with dot.")));

  await js('window.__t.setHeader("One/Two"); window.__t.leave(); true');
  await until("slash becomes dash", () => has("One-Two"));
  check("/ becomes -, header stays as typed", () => assert.ok(file("One-Two").includes("<h1>One/Two</h1>")));
  await until("frame told", () => js('window.__t.state().path === "One-Two"'));

  await js('window.__t.setHeader("one-two"); window.__t.leave(); true');
  await until("case only", () => fs.readdirSync(vault).includes("one-two"));
  check("case-only rename", () => assert.ok(!fs.readdirSync(vault).includes("One-Two")));
  await until("frame told", () => js('window.__t.state().path === "one-two"'));
  assert.equal(await js("window.__marker"), 1);

  /* ---- Enter leaves the header */
  await js(`window.__t.setHeader("Enter name"); window.__t.place(window.__t.h1(), "end");
    if (!window.__t.key("Enter")) document.execCommand("insertParagraph"); window.__t.tick(); true`);
  await until("Enter renames", () => has("Enter name"));
  check("Enter renames", () => assert.ok(!has("one-two")));
  await until("frame told", () => js('window.__t.state().path === "Enter name"'));
  assert.equal((await js("window.__t.caret()")).block, "P");

  /* ---- IME */
  await js(`document.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); window.__t.setHeader("Ime name"); window.__t.leave(); true`);
  await sleep(700);
  check("no rename during a composition", () => assert.ok(!has("Ime name")));
  await js(`document.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); window.__t.place(window.__t.h1(), "end"); true`);
  await sleep(50);
  await js("window.__t.leave(); true");
  await until("after composition", () => has("Ime name"));
  check("renames once the composition ended and the caret left", () => assert.ok(!has("Enter name")));

  /* ---- headers that never matched, and h1s that aren't the header */
  await open("Different");
  await js('window.__t.setHeader("Another title"); window.__t.leave(); true');
  await sleep(900);
  check("a header that never matched: no rename", () => assert.ok(has("Different") && !has("Another title") && file("Different").includes("Another title")));

  await open("NoHead");
  await js('window.__t.setHeader("NoHead two"); window.__t.leave(); true');
  await sleep(900);
  check("an h1 outside the first region is not the header", () => assert.ok(has("NoHead") && !has("NoHead two") && file("NoHead").includes("NoHead two")));

  /* ---- markdown */
  await open("Mark");
  await js('window.__t.setHeader("Mark two"); window.__t.leave(); true');
  await until("md renamed", () => has("Mark two"));
  await sleep(600);
  check("md page renames, keeps its frontmatter", () => assert.match(file("Mark two", "index.md"), /^---\na: 1\n---\n# Mark two\n/));

  /* ---- a link to itself: the file changes under the frame, so it swaps */
  await open("Selfy");
  await js('window.__t.setHeader("Selfy two"); window.__t.leave(); true');
  await until("self renamed", () => has("Selfy two"));
  check("self link rewritten", () => assert.ok(file("Selfy two").includes('href="./"'), file("Selfy two")));
  await until("frame shows the rewritten link", async () => {
    try {
      return await once(`!!document.querySelector('a[href="./"]')`);
    } catch {
      return false;
    }
  });
  await sleep(600);
  await js(HELPERS);
  await js('document.querySelector("[data-q-region]").focus(); window.__t.place(window.__t.h1().nextElementSibling, 0); document.execCommand("insertText", false, "Z"); true');
  await until("saved", () => file("Selfy two").includes("Z"));
  assert.ok(file("Selfy two").includes('href="./"'), file("Selfy two"));
  console.log("     self-link page: marker after swap =", await js("window.__marker || 0"));

  /* ---- sidebar → header */
  const ren = (from, to) => app(`window.quireApp.rename(${JSON.stringify(from)}, ${JSON.stringify(to)})`);
  const sideBefore = file("Side");
  await ren("Side", "Side new");
  check("sidebar rename changes a matching h1, bytes elsewhere untouched", () => assert.equal(file("Side new"), sideBefore.replace("<h1>Side</h1>", "<h1>Side new</h1>")));
  await ren("Side2", "Side2 new");
  check("sidebar rename leaves an unmatched h1", () => assert.ok(file("Side2 new").includes("<h1>Other title</h1>")));
  await ren("SideMd", "SideMd new");
  check("sidebar rename changes the first # line, not a code block", () => assert.equal(file("SideMd new", "index.md"), "# SideMd new\n\n```\n# SideMd\n```\n"));
  await ren("Side3", "Side3 new");
  check("same commit as the rename", () => {
    assert.ok(file("Side3 new").includes("<h1>Side3 new</h1>"));
    const show = execFileSync("git", ["show", "--name-status", "--format=%s", "HEAD"], { cwd: vault, encoding: "utf8" });
    assert.match(show, /Rename Side3 to Side3 new/);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--", "Side3 new"], { cwd: vault, encoding: "utf8" }).trim(), "");
    assert.ok(show.includes("Side3 new/index.html"), show);
  });

  /* ---- sidebar rename of the page on screen, typing not saved yet */
  await open("Taken");
  await js(`window.__t.place(window.__t.h1().nextElementSibling, 0); document.execCommand("insertText", false, "unsaved "); true`);
  await app(`(async () => { window.__quireStartRename("Taken"); })()`);
  await sleep(150);
  const typed = await app(`(() => {
    const input = document.activeElement;
    if (!input || input.tagName !== "INPUT") return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Taken new");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);
  assert.ok(typed, "the rename field");
  await until("sidebar renamed on screen", () => has("Taken new"));
  await sleep(800);
  check("on-screen sidebar rename: typing and new header both on disk", () => {
    const f = file("Taken new");
    assert.ok(f.includes("<h1>Taken new</h1>") && f.includes("unsaved x"), f);
  });
  await until("new frame shows the header", async () => {
    try {
      return (await once(`document.querySelector("h1")?.textContent`)) === "Taken new";
    } catch {
      return false;
    }
  });

  console.log(`\nverify-header-rename: ${passed} passed`);
}

export default run;
