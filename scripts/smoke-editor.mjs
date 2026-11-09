// Smoke test for the editor's pure HTML helpers in app/runtime/runtime.js: the paste
// sanitizer, plain text / markdown paste, copy-out text and the list repair.
// runtime.js is a browser script; run without a window it hands these to globalThis.__quireEditor.
// Run: node scripts/smoke-editor.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({});
vm.runInContext(readFileSync(path.join(root, "app/runtime/runtime.js"), "utf8"), ctx, { filename: "runtime.js" });
const E = ctx.__quireEditor;
assert.ok(E, "runtime.js should expose __quireEditor without a window");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}

/* ---- parse / serialize */

test("parse and serialize round-trip", () => {
  const html = '<p>a &amp; b &lt;c&gt;&nbsp;<b>bold</b> <a href="x?a=1&amp;b=2">l</a></p><ul><li>one</li><li>two<br></li></ul>';
  assert.equal(E.serializeHtml(E.parseHtml(html)), html);
});

test("parser closes implied tags like a browser", () => {
  assert.equal(E.serializeHtml(E.parseHtml("<ul><li>a<li>b</ul><p>x<p>y")), "<ul><li>a</li><li>b</li></ul><p>x</p><p>y</p>");
  assert.equal(E.serializeHtml(E.parseHtml("<p>a<ul><li>b</li></ul>")), "<p>a</p><ul><li>b</li></ul>");
});

/* ---- paste: sanitizer */

const san = E.sanitizeHtml;

test("Google Docs: guid wrapper, styled spans, dir/role attrs", () => {
  const gdocs = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234-abcd"><h2 dir="ltr" style="line-height:1.38;margin-top:18pt"><span style="font-size:16pt;font-family:Arial;color:#000000;">Plan</span></h2><p dir="ltr" style="line-height:1.38"><span style="font-size:11pt;font-weight:700;">Bold</span><span style="font-size:11pt;"> and </span><span style="font-style:italic;">ital</span></p><br><ol style="margin-top:0;"><li dir="ltr" style="list-style-type:decimal;" aria-level="1"><p dir="ltr" role="presentation"><span>First</span></p></li><li dir="ltr" aria-level="1"><p dir="ltr" role="presentation"><span>Second</span></p></li><ol><li aria-level="2"><p role="presentation"><span>Nested</span></p></li></ol></ol></b>`;
  assert.equal(
    san(gdocs),
    "<h2>Plan</h2><p><b>Bold</b> and <i>ital</i></p><ol><li>First</li><li>Second<ol><li>Nested</li></ol></li></ol>"
  );
});

test("web page: classes, styles, divs, scripts, comments, meta", () => {
  const web = `<html><head><style>p{color:red}</style></head><body><!--StartFragment--><div class="post" style="x"><h4 class="t">Small</h4><div>Line <span class="hl" style="color:red">one</span></div><div><a href="https://ex.com/a?b=1" onclick="evil()" class="lnk">link</a></div><script>alert(1)</script><img src="https://ex.com/i.png" width="10" alt="pic" onerror="x"></div><!--EndFragment--></body></html>`;
  assert.equal(san(web), '<h3>Small</h3><p>Line one</p><p><a href="https://ex.com/a?b=1">link</a></p><p><img src="https://ex.com/i.png" alt="pic"></p>');
});

test("unsafe links are dropped, text kept", () => {
  assert.equal(san('<p><a href="javascript:alert(1)">x</a> <img src="javascript:1"></p>'), "<p>x</p>");
});

test("Notion: headings, lists, code, quote", () => {
  const notion = `<h1>Title</h1><ul><li>One</li><li>Two</li></ul><pre><code class="language-js">let a = 1;\n  b();</code></pre><blockquote>Quote</blockquote>`;
  assert.equal(san(notion), "<h1>Title</h1><ul><li>One</li><li>Two</li></ul><pre><code>let a = 1;\n  b();</code></pre><blockquote>Quote</blockquote>");
});

test("tables keep their cells, lose styles and colgroups", () => {
  const t = `<table style="border:1px"><colgroup><col width="100"></colgroup><tbody><tr><td style="x"><p dir="ltr"><span>a</span></p></td><td colspan="2" class="c">b</td></tr></tbody></table>`;
  assert.equal(san(t), '<table><tbody><tr><td>a</td><td colspan="2">b</td></tr></tbody></table>');
});

test("whitespace from source formatting collapses", () => {
  assert.equal(san("<ul>\n  <li>\n    one\n  </li>\n  <li>two <b>bold</b> end</li>\n</ul>\n<p>\n  para\n</p>"), "<ul><li>one</li><li>two <b>bold</b> end</li></ul><p>para</p>");
});

test("empty paragraphs and stray brs go", () => {
  assert.equal(san("<p></p><p>a</p><br><br><p><span> </span></p><p>b</p>"), "<p>a</p><p>b</p>");
});

test("Obsidian reading view: bullets, collapse icons, checkboxes", () => {
  const obs = `<div class="el-h2"><h2 data-heading="Todo" dir="auto"><span class="heading-collapse-indicator collapse-indicator collapse-icon"><svg viewBox="0 0 100 100"><path d="M0"></path></svg></span>Todo</h2></div><div class="el-ul"><ul class="has-list-bullet"><li data-line="0" dir="auto"><span class="list-bullet"></span>Milk <a data-href="Shop" href="Shop" class="internal-link">Shop</a></li><li class="task-list-item" data-task=""><input type="checkbox" class="task-list-item-checkbox">Eggs</li></ul></div>`;
  assert.equal(san(obs), '<h2>Todo</h2><ul><li>Milk <a href="Shop">Shop</a></li><li>Eggs</li></ul>');
});

test("Quire's own copy pastes back unchanged", () => {
  const ours = '<h2>Plan</h2><ol start="3"><li>three <b>b</b></li><li>four<ul><li>sub</li></ul></li></ol><p>end <a href="https://ex.com">x</a></p>';
  assert.equal(san(ours), ours);
});

/* ---- paste: plain text and markdown */

test("plain lines become paragraphs", () => {
  assert.equal(E.plainToHtml("one\ntwo\n\nthree & <four>"), "<p>one</p><p>two</p><p>three &amp; &lt;four&gt;</p>");
});

test("markdown text becomes blocks", () => {
  const md = "# Title\n\nSome **bold** and *it* and `code` and [a link](https://ex.com).\n\n- one\n- two\n  - nested\n\n3. three\n4. four\n\n> quoted\n\n```\nx < 1\n```\n\n---";
  assert.equal(
    E.plainToHtml(md),
    '<h1>Title</h1><p>Some <b>bold</b> and <i>it</i> and <code>code</code> and <a href="https://ex.com">a link</a>.</p>' +
      '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="3"><li>three</li><li>four</li></ol>' +
      "<blockquote>quoted</blockquote><pre>x &lt; 1</pre><hr>"
  );
});

test("snake_case and arithmetic stars stay text", () => {
  assert.equal(E.plainToHtml("a_b_c and 2 * 3 * 4"), "<p>a_b_c and 2 * 3 * 4</p>");
});

test("pastePlan: a plain run flows inline, blocks go in as HTML", () => {
  assert.deepEqual({ ...E.pastePlan("", "just words") }, { text: "just words" });
  assert.deepEqual({ ...E.pastePlan("", "- a\n- b") }, { html: "<ul><li>a</li><li>b</li></ul>" });
  assert.deepEqual({ ...E.pastePlan("", "a\nb") }, { html: "<p>a</p><p>b</p>" });
  assert.deepEqual({ ...E.pastePlan('<meta charset="utf-8"><span style="color:red">hi</span>', "hi") }, { text: "hi" });
  assert.deepEqual({ ...E.pastePlan("<p>hi <b>there</b></p>", "hi there") }, { html: "hi <b>there</b>" });
  // A code editor's styled HTML next to markdown source: the source wins.
  assert.deepEqual(
    { ...E.pastePlan('<div style="font-family:Menlo"><div><span>## Head</span></div><div><span>- item</span></div></div>', "## Head\n- item") },
    { html: "<h2>Head</h2><ul><li>item</li></ul>" }
  );
});

/* ---- copy out */

test("copy-out text keeps list markers and numbering", () => {
  const html = '<h2>Plan</h2><p>Intro <b>bold</b><br>next line</p><ol start="3"><li>three</li><li>four<ul><li>sub</li></ul></li></ol><ul><li>dot</li></ul><blockquote>q</blockquote><pre>a\n  b</pre>';
  assert.equal(E.htmlToPlain(html), "Plan\n\nIntro bold\nnext line\n\n3. three\n4. four\n   - sub\n\n- dot\n\n> q\n\na\n  b");
});

/* ---- list repair */

const norm = (h, o) => E.normalizeHtml(h, o);

test("two lists of a kind back to back join", () => {
  assert.equal(norm("<ol><li>a</li></ol><ol><li>b</li></ol>"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(norm("<ol><li>a</li></ol>\n<ol><li>b</li></ol>"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(norm('<ol><li>a</li></ol><ol start="5"><li>b</li></ol>'), '<ol><li>a</li></ol><ol start="5"><li>b</li></ol>');
  assert.equal(norm("<ul><li>a</li></ul><ol><li>b</li></ol>"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
});

test("empty items, stray brs and divs in lists go", () => {
  assert.equal(norm("<ol><li>a</li><li><br></li><br><li></li><li>b<br></li></ol>"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(norm("<ol><li>a</li><div>b</div></ol>"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(norm("<ol><li>a<div>b</div></li></ol>"), "<ol><li>a<br>b</li></ol>");
  assert.equal(norm("<ol><li><br></li></ol>"), "");
});

test("a list inside a list moves into the item above", () => {
  assert.equal(norm("<ul><li>a</li><ul><li>b</li></ul></ul>"), "<ul><li>a<ul><li>b</li></ul></li></ul>");
});

test("top-level inline runs become paragraphs; a <div> becomes a <p>", () => {
  assert.equal(norm("loose <b>text</b><ol><li>a</li></ol><div>d</div>"), "<p>loose <b>text</b></p><ol><li>a</li></ol><p>d</p>");
});

test("a trailing <br> after text goes, a Shift-Enter line stays", () => {
  assert.equal(norm("<p>a<br></p><p>b<br><br></p><p><br></p>"), "<p>a</p><p>b<br><br></p><p><br></p>");
});

test("deleting the middle of a list: what Chrome leaves is repaired", () => {
  // Backspace over items 2-3 as Chrome does it: an emptied item, style spans, the list split by a <br>.
  const left = '<ol><li>one</li><li><span style="font-size: 16px;">two</span>four</li><li><br></li></ol><br><ol><li>five</li></ol>';
  assert.equal(norm(left, { keepSpan: () => false, dropEmpty: true, trimBr: true, wrapTop: true, dropBrRuns: true }), "<ol><li>one</li><li>twofour</li><li>five</li></ol>");
});

test("spans the file had are kept", () => {
  assert.equal(norm('<p><span style="color:red">x</span></p>', { keepSpan: () => true, wrapTop: true }), '<p><span style="color:red">x</span></p>');
  assert.equal(norm('<p><span class="tag">x</span></p>', { keepSpan: () => false, wrapTop: true }), '<p><span class="tag">x</span></p>');
});

/* ---- spacing junk. What Chromium really leaves (the case names in verify-editor-spacing.mjs show
   where), and what older saves kept. The layout half of this check is that script. */

const save = (h) => norm(h); // the options a save uses
const live = (h) => norm(h, { keepSpan: () => false, wrapTop: true }); // the options typing uses
const liveDelete = (h) => norm(h, { keepSpan: () => false, dropEmpty: true, dropBrRuns: true, wrapTop: true });

test("spans Chromium stamps on a merge go, even from a saved file", () => {
  const cases = [
    ['<h2>Head<span style="font-size: 16px;">Body</span></h2>', "<h2>HeadBody</h2>"], // paragraph into a heading
    ['<p>Body<span style="font-size: 1.4375em; font-weight: 600; letter-spacing: -0.01em;">Head</span></p>', "<p>BodyHead</p>"], // h2 into a paragraph
    ['<p>Body<span style="font-size: 1.125em; font-weight: 600;">Head</span></p>', "<p>BodyHead</p>"], // h3 into a paragraph
    ['<blockquote>Quote<span style="color: rgb(21, 23, 28);">Body</span></blockquote>', "<blockquote>QuoteBody</blockquote>"], // paragraph into a quote
    ['<p>One <span style="font-size: 16px; line-height: 24.8px;">merged</span> line</p>', "<p>One merged line</p>"],
    ['<p><span style="color: rgb(0, 0, 0); font-family: Arial; font-size: 16px; line-height: 1.38;">x</span></p>', "<p>x</p>"],
    ['<p>a <font style="line-height: 2;">b</font></p>', "<p>a b</p>"],
    ["<p>a <span>b</span></p>", "<p>a b</p>"],
    ['<p>Last<span style="letter-spacing: normal; font-size: 16px;"></span></p>', "<p>Last</p>"],
  ];
  cases.forEach(([a, b]) => assert.equal(save(a), b));
});

test("line-height stamped on a block goes", () => {
  assert.equal(save('<p style="line-height: 1.38;">x</p>'), "<p>x</p>");
  assert.equal(save('<p style="line-height:1.38;margin-top:18pt">x</p>'), '<p style="line-height:1.38;margin-top:18pt">x</p>'); // a margin is a decision
  assert.equal(save('<ol style="line-height: 1.38;"><li style="line-height: 1.38;">x</li></ol>'), "<ol><li>x</li></ol>");
  assert.equal(save('<h2 style="line-height: 24px; font-size: 16px;">x</h2>'), "<h2>x</h2>");
});

test("styles an author wrote stay", () => {
  [
    '<p><span style="color: rgb(200, 0, 0);">x</span></p>',
    '<p><span style="color:red">x</span></p>',
    '<p><span style="font-size:1.2em">x</span></p>',
    '<p><span style="font-size: 14px; color: #888;">x</span></p>',
    '<p><span style="font-size: 14px; font-weight: 600;">x</span></p>',
    '<p style="font-size:13px">x</p>',
    '<p style="margin-top:0">x</p>',
    '<p style="color:red;line-height:2">x</p>',
    '<p style="text-align:center">x</p>',
    '<p><img src="a.png" style="width:100px"></p>',
    '<p><span class="tag">x</span></p>',
  ].forEach((h) => assert.equal(save(h), h));
  // A class stays, the stamped style beside it doesn't.
  assert.equal(save('<p><span class="tag" style="line-height: 2;">x</span></p>'), '<p><span class="tag">x</span></p>');
});

test("an app block's styles aren't looked at", () => {
  const h = '<p>a</p><div data-app="x"><p style="line-height: 2;"><span style="font-size: 16px;">b</span></p></div>';
  assert.equal(save(h), h);
});

test("empty lists go; an empty item among others stays while typing", () => {
  assert.equal(live("<p>a</p><ul></ul><p>b</p>"), "<p>a</p><p>b</p>");
  assert.equal(live("<p>a</p><ul><li><br></li></ul><p>b</p>"), "<p>a</p><p>b</p>");
  assert.equal(live("<ul><li><br></li><li>&nbsp;</li></ul><p>b</p>"), "<p>b</p>");
  assert.equal(live("<ul><li>a<ul><li><br></li></ul></li></ul>"), "<ul><li>a</li></ul>");
  assert.equal(live("<ul><li>a</li><li><br></li></ul>"), "<ul><li>a</li><li><br></li></ul>");
  assert.equal(live('<ul><li><img src="a.png"></li></ul>'), '<ul><li><img src="a.png"></li></ul>');
});

test("a delete only takes items it emptied: a blank bullet elsewhere stays", () => {
  const kept = (h) => norm(h, { keepSpan: () => false, dropEmpty: true, dropBrRuns: true, wrapTop: true, keepItem: () => true });
  assert.equal(kept("<ul><li>a</li><li>b</li><li><br></li></ul>"), "<ul><li>a</li><li>b</li><li><br></li></ul>");
});

test("a <p> with nothing in it goes, a blank line stays", () => {
  assert.equal(save("<p>a</p><p></p><p>b</p>"), "<p>a</p><p>b</p>");
  assert.equal(save("<p>a</p><p>\n</p><p>b</p>"), "<p>a</p><p>b</p>");
  assert.equal(save("<p>a</p><p><br></p><p>b</p>"), "<p>a</p><p><br></p><p>b</p>");
  assert.equal(save('<p class="gap"></p>'), '<p class="gap"></p>');
});

test("what a nested <p> leaves behind is repaired", () => {
  // Backspace on an <li><p> item used to save <p><p>one</p></p>, which loads split around empties.
  assert.equal(save("<p></p><p>one</p><p></p>"), "<p>one</p>");
  // The string parser closes a <p> at a block, so a span carries the live shape in here.
  assert.equal(save("<p><span><p>one</p></span></p>"), "<p>one</p>");
  assert.equal(save("<p>a<span><p>one</p></span>b</p>"), "<p>a</p><p>one</p><p>b</p>");
});

test("a loose list is left as it is until someone edits that item", () => {
  const h = "<ul><li><p>a</p></li><li><p>b</p><ul><li><p>c</p></li></ul></li></ul>";
  assert.equal(save(h), h);
  assert.equal(live(h), h);
});

test("a <br> a delete leaves between blocks goes, unless it's the only line", () => {
  assert.equal(liveDelete("<ul><li>a</li></ul><br><ul><li>b</li></ul>"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(liveDelete("<p>a</p><br><p>b</p>"), "<p>a</p><p>b</p>");
  assert.equal(liveDelete("<br>"), "<p><br></p>");
  // Typing doesn't drop it: that's a line someone may be about to fill.
  assert.equal(live("<p>a</p><br><p>b</p>"), "<p>a</p><p><br></p><p>b</p>");
});

test("healing leaves clean pages alone", () => {
  const h = '<h2>Plan</h2><p>a <b>b</b>&nbsp;<i>c</i> <a href="x">d</a></p><ul><li>e<ul><li>f</li></ul></li></ul><blockquote>g<br>h</blockquote><pre>i\n  j</pre><p><br></p><hr><ol start="3"><li>k</li></ol>';
  assert.equal(save(h), h);
  assert.equal(live(h), h);
});

test("find: matches in order, case folding, white space", () => {
  const f = (t, q, mc) => JSON.parse(JSON.stringify(E.findIn(t, q, mc)));
  assert.deepEqual(f("Shortcut, shortcuts, SHORTCUT", "shortcut"), [[0, 8], [10, 18], [21, 29]]);
  assert.deepEqual(f("Shortcut, shortcuts, SHORTCUT", "shortcut", true), [[10, 18]]);
  assert.deepEqual(f("aaaa", "aa"), [[0, 2], [2, 4]]);
  assert.deepEqual(f("press the  key", "the  key"), []); // the page text is collapsed; so is the query
  assert.deepEqual(f("press the key", "the  key"), [[6, 13]]);
  assert.deepEqual(f("abc", "   "), []);
  assert.deepEqual(f("İstanbul istanbul", "istanbul"), [[9, 17]]);
});

/* ---- slash menu and page links */

test("slash token: start of text or after white space, query up to the caret", () => {
  const tok = (t, c) => {
    const r = E.findEditorToken(t, c);
    return r && r.kind === "slash" ? [r.start, r.end, r.query] : r;
  };
  assert.deepEqual(tok("/"), [0, 1, ""]);
  assert.deepEqual(tok("/he"), [0, 3, "he"]);
  assert.deepEqual(tok("see /he"), [4, 7, "he"]);
  assert.deepEqual(tok("see /he"), [4, 7, "he"]);
  assert.deepEqual(tok("one\n/he"), [4, 7, "he"]);
  assert.deepEqual(tok("​/he"), [1, 4, "he"]);
  assert.deepEqual(tok("see /he and more", 7), [4, 7, "he"]); // the text after the caret isn't the query
  assert.deepEqual(tok("/bullet li"), [0, 10, "bullet li"]);
});

test("slash token: a word or URL never opens it, and it ends", () => {
  const none = (t, c) => assert.equal(E.findEditorToken(t, c), null, t);
  none("a/b");
  none("and/or");
  none("http://x");
  none("http:/");
  none("x /usr/loc"); // a second "/" ends it
  none("a / b"); // a space right after the "/"
  none("/ ");
  none("/one\ntwo");
  none("see /he", 4); // caret before the "/"
  none("/" + "x".repeat(41));
  assert.ok(E.findEditorToken("/" + "x".repeat(40)));
  none("no token here");
});

test("page token: [[ anywhere, typed characters filter", () => {
  const tok = (t, c) => {
    const r = E.findEditorToken(t, c);
    return r && r.kind === "link" ? [r.start, r.end, r.query] : r;
  };
  assert.deepEqual(tok("[["), [0, 2, ""]);
  assert.deepEqual(tok("see[[Kyo"), [3, 8, "Kyo"]);
  assert.deepEqual(tok("[[Kyoto trip"), [0, 12, "Kyoto trip"]);
  assert.deepEqual(tok("[[[a"), [1, 4, "a"]);
  assert.deepEqual(tok("[[a /b"), [0, 6, "a /b"]); // a "/" inside it stays part of the name
  const none = (t) => assert.equal(E.findEditorToken(t), null, t);
  none("[");
  none("[[a]]");
  none("[[ a");
  none("[[a\nb");
  none("[[" + "x".repeat(41));
  // A closed one earlier on the line doesn't stop a "/" after it.
  assert.equal(E.findEditorToken("[[a]] /he").kind, "slash");
});

test("page link href: relative, to the other page's folder URL", () => {
  assert.equal(E.pageLinkHref("Garden/Home", "Garden/Watering"), "../Watering/");
  assert.equal(E.pageLinkHref("Home", "Other"), "../Other/");
  assert.equal(E.pageLinkHref("Garden/Home", "Other"), "../../Other/");
  assert.equal(E.pageLinkHref("Home", "Kyoto trip/Trip budget"), "../Kyoto%20trip/Trip%20budget/");
  const hit = new URL(E.pageLinkHref("A/B/C", "A/D/E f"), "quire://vault/A/B/C/");
  assert.equal(hit.pathname, "/A/D/E%20f/");
});

test("page name match: exact title or path, no files or folders", () => {
  const nodes = [
    { kind: "folder", path: "Budget", title: "Budget" },
    { kind: "file", path: "Budget.pdf", title: "Budget.pdf" },
    { kind: "page", path: "Trips/Budget", title: "Trip budget" },
    { kind: "page", path: "Notes", title: "" },
  ];
  const path = (n) => (E.matchPageByName(nodes, n) || {}).path;
  assert.equal(path("Trip budget"), "Trips/Budget");
  assert.equal(path("  trip BUDGET "), "Trips/Budget");
  assert.equal(path("Trips/Budget"), "Trips/Budget");
  assert.equal(path("Notes"), "Notes");
  assert.equal(path("Trip"), undefined);
  assert.equal(path("Budget.pdf"), undefined);
  assert.equal(path(""), undefined);
});

/* ---- the header names the page */

test("header rename: only a header that said the name, and only when it changed", () => {
  const go = E.shouldRenameFromHeader;
  assert.equal(go("Plan", "Plan", "Plan B"), true);
  assert.equal(go("Plan", "Plan", "Plan"), false); // not changed
  assert.equal(go("Plan", "  Plan \n", "Plan"), false); // whitespace isn't a change
  assert.equal(go("Plan", "My plan", "Our plan"), false); // never matched
  assert.equal(go("Plan", "plan", "Plan B"), false); // case is exact
  assert.equal(go("Plan", "Plan", "plan"), true);
  assert.equal(go("Plan", "Plan", "   "), false); // empty
  assert.equal(go("Plan", "Plan", ""), false);
  assert.equal(go("A  B", "A\u00a0B", "C"), true); // collapsed, a typed nbsp is a space
  assert.equal(go("A-B", "A/B", "C"), true); // a header that gave this name still names it
});

test("header rename: the name a header gives", () => {
  assert.equal(E.headerName("  One  / two\n"), "One - two");
  assert.equal(E.headerName("a\u200bb"), "ab");
  assert.equal(E.headerName(null), "");
});

console.log(`\nsmoke-editor: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
