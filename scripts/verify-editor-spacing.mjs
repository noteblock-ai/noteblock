// Editor spacing check: drives the real editor in a real (hidden) Chromium page and asserts on
// computed layout. Runs inside the app's main process through QUIRE_TEST_SCRIPT. No visible
// window, no host cursor. Not part of CI or `pnpm check`.
//
// Run (temp HOME and config, so no real vault is touched; `pnpm build` once if app/renderer/dist
// is missing):
//
//   T=$(mktemp -d); HOME=$T QUIRE_CONFIG_DIR=$T/config QUIRE_CAPTURE=/tmp/x.png QUIRE_OPEN_PAGE=Welcome QUIRE_TEST_SCRIPT=scripts/verify-editor-spacing.mjs ./node_modules/.bin/electron .
//
// Exits nonzero and prints a table of offenders. SPACING_ONLY=<substring> runs matching cases;
// SPACING_DEBUG=1 prints each case's final HTML.
//
// Each case sets the first region's content (or writes the page file and reloads), runs edit
// steps, then checks: every <p> has one line-height and one pair of margins; the gap between
// consecutive blocks is the theme's value for that pair; every line is a whole number of line
// heights; no inline style, stray span, <div>, <font>, empty list or nested <p> in the region;
// and, where a case names one, the region is exactly as tall as a page typed clean.
//
// The keys go through the runtime's keydown handlers as a dispatched KeyboardEvent; when nothing
// handled one, the same editing command Chromium runs for that key follows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* What theme.css says, in px at the default 16px text size. Written out here rather than measured
   from a control block, so that a theme change that breaks the rhythm is caught. */
const MARGINS = { P: [0, 12], UL: [4, 12], OL: [4, 12], H1: [0, 16], H2: [36, 10], H3: [28, 8], H4: [22, 6], BLOCKQUOTE: [0, 12], PRE: [0, 12], HR: [28, 28] };
const ITEM_GAP = 4;

/** Runs in the page frame. */
const PAGE_HELPERS = `(() => {
  const MARGINS = ${JSON.stringify(MARGINS)};
  const ITEM_GAP = ${ITEM_GAP};
  const region = () => document.querySelector("[data-q-region]");
  const near = (a, b) => Math.abs(a - b) < 0.51;
  const px = (v) => parseFloat(v) || 0;

  function nodeOf(sel, n) {
    const all = region().querySelectorAll(sel);
    const el = all[n || 0];
    if (!el) throw new Error("no element: " + sel);
    return el;
  }
  // The text position "offset" characters into el's own line, walking past sub-lists.
  function textAt(el, offset) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement.closest("ul,ol") !== el.closest("ul,ol") && el.tagName === "LI" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    let t, left = offset;
    while ((t = walk.nextNode())) {
      if (left <= t.nodeValue.length) return [t, left];
      left -= t.nodeValue.length;
    }
    return [el, 0];
  }
  function point(sel, where, n) {
    const el = nodeOf(sel, n);
    if (where === "end") {
      const stop = el.tagName === "LI" ? Array.from(el.children).find((c) => /^(UL|OL)$/.test(c.tagName)) : null;
      const before = stop ? stop.previousSibling : el.lastChild;
      if (before && before.nodeType === 3) return [before, before.nodeValue.length];
      if (before && before.nodeName === "BR") return [el, Array.prototype.indexOf.call(el.childNodes, before)];
      return [el, stop ? Array.prototype.indexOf.call(el.childNodes, stop) : el.childNodes.length];
    }
    if (where === "start") return textAt(el, 0);
    return textAt(el, where);
  }
  function select(a, b) {
    const r = document.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
  }
  function target() {
    const s = getSelection();
    let n = s.rangeCount ? s.anchorNode : null;
    if (n && n.nodeType !== 1) n = n.parentElement;
    return n && n.closest("[data-q-region]") ? n : region();
  }
  const NATIVE = { Backspace: "delete", Delete: "forwardDelete", Enter: "insertParagraph" };
  function key(k, opts) {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...(opts || {}) });
    target().dispatchEvent(ev);
    if (ev.defaultPrevented) return;
    if (k === "Enter" && opts && opts.shiftKey) document.execCommand("insertLineBreak");
    else if (NATIVE[k]) document.execCommand(NATIVE[k]);
  }
  function paste(html, text) {
    const dt = new DataTransfer();
    if (html) dt.setData("text/html", html);
    dt.setData("text/plain", text == null ? "" : text);
    target().dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  /* The audit: a list of {what, where, got, want}. */
  function short(el) {
    return (el.outerHTML || "").replace(/ data-q-[a-z-]+="[^"]*"/g, "").slice(0, 70);
  }
  // Where an item's own line ends, its sub-lists not counted. (A Range's rect is the glyphs' box,
  // not the line's, so it only counts the lines.)
  function lineBottom(li, lh) {
    const box = li.getBoundingClientRect();
    const stop = Array.from(li.children).find((c) => /^(UL|OL)$/.test(c.tagName));
    if (!stop) return box.bottom;
    const r = document.createRange();
    r.selectNodeContents(li);
    r.setEndBefore(stop);
    return box.top + Math.max(1, Math.round(r.getBoundingClientRect().height / lh)) * lh;
  }
  const topList = (el) => {
    let l = el.closest("ul,ol");
    for (let up = l; up; up = up.parentElement.closest("ul,ol")) l = up;
    return l;
  };
  function audit(allow) {
    allow = allow || {};
    const root = region();
    const out = [];
    const bad = (what, where, got, want) => out.push({ what, where: short(where), got: String(got), want: String(want) });
    const all = Array.from(root.querySelectorAll("*"));
    const bodyLh = px(getComputedStyle(document.body).lineHeight);
    all.forEach((el) => {
      if (el.hasAttribute("style") && !allow.style) bad("inline style", el, el.getAttribute("style"), "none");
      if (el.tagName === "SPAN" && !allow.span) bad("stray span", el, "span", "none");
      if (el.tagName === "FONT") bad("stray font", el, "font", "none");
      if (el.tagName === "DIV") bad("div in region", el, "div", "p");
      if ((el.tagName === "UL" || el.tagName === "OL") && !el.querySelector("li")) bad("empty list", el, "no items", "removed");
      if (el.tagName === "P" && el.parentElement.closest("p")) bad("p inside p", el, "nested", "flat");
      if (el.tagName === "P" && !el.firstChild) bad("empty p, no br", el, "0 lines", "removed");
      if (/^(LI|P)$/.test(el.tagName) && !el.textContent.replace(/[\\s\\u200b\\ufeff]/g, "") && !el.querySelector("img,hr,li") && el.querySelectorAll("br").length > 1) bad("blank block of several brs", el, el.querySelectorAll("br").length, 1);
    });
    Array.from(root.children).forEach((el) => {
      if (el.tagName === "P") {
        const cs = getComputedStyle(el);
        if (!near(px(cs.lineHeight), bodyLh)) bad("p line-height", el, cs.lineHeight, bodyLh + "px");
        if (!near(px(cs.marginTop), MARGINS.P[0])) bad("p margin-top", el, cs.marginTop, MARGINS.P[0] + "px");
        if (!near(px(cs.marginBottom), MARGINS.P[1])) bad("p margin-bottom", el, cs.marginBottom, MARGINS.P[1] + "px");
      }
    });
    // Lines: a block's own text is a whole number of line heights.
    all.concat().filter((el) => /^(P|LI)$/.test(el.tagName) && !el.querySelector("img")).forEach((el) => {
      const inner = Array.from(el.children).filter((c) => /^(UL|OL|P)$/.test(c.tagName));
      if (inner.length) return; // measured through its children
      const h = el.getBoundingClientRect().height;
      const n = Math.round(h / bodyLh);
      if (n < 1 || !near(h, n * bodyLh)) bad(el.tagName.toLowerCase() + " height", el, h.toFixed(2) + "px", "a whole number of " + bodyLh + "px lines");
    });
    // Gaps between consecutive blocks.
    const kids = Array.from(root.children);
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1], b = kids[i];
      const ma = MARGINS[a.tagName], mb = MARGINS[b.tagName];
      if (!ma || !mb) continue;
      const want = Math.max(ma[1], mb[0]);
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      // A list's box starts at its first item: the item's margin sticks out of the list.
      const got = rb.top - ra.bottom;
      if (!near(got, want)) bad("gap " + a.tagName + " to " + b.tagName, b, got.toFixed(2) + "px", want + "px");
    }
    // Between the lines of a list, whatever wraps them: bare, <li><p>, nested.
    const lines = all.filter((el) => el.tagName === "LI");
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1], b = lines[i];
      if (topList(a) !== topList(b)) continue;
      const got = b.getBoundingClientRect().top - lineBottom(a, bodyLh);
      if (!near(got, ITEM_GAP)) bad("gap between items", b, got.toFixed(2) + "px", ITEM_GAP + "px");
    }
    return out;
  }
  function html() {
    return region().innerHTML.replace(/ data-q-[a-z-]+="[^"]*"/g, "");
  }
  function height() {
    return region().scrollHeight;
  }
  function set(h) {
    const r = region();
    // The runtime takes changes with no recent user event for the page's own script drawing.
    window.dispatchEvent(new Event("pointerdown"));
    r.innerHTML = h;
    r.focus({ preventScroll: true });
  }
  // From the block before the region to the region's first line.
  function topGap() {
    const r = region();
    return r.firstElementChild.getBoundingClientRect().top - r.previousElementSibling.getBoundingClientRect().bottom;
  }
  window.__sp = { region, topGap, nodeOf, point, select, key, paste, audit, html, height, set,
    caret: (sel, where, n) => { const p = point(sel, where, n); select(p, p); },
    type: (s) => { for (const c of s) document.execCommand("insertText", false, c); },
    range: (a, b) => select(point(a[0], a[1], a[2]), point(b[0], b[1], b[2])),
    insertHtml: (h) => document.execCommand("insertHTML", false, h),
  };
  return true;
})()`;

/* ---- the cases. A step is [helper, ...args] on window.__sp; "check" audits mid-way; a case's
   `same` is the clean HTML the end state must match in markup and height. */

const back = (n = 1) => Array.from({ length: n }, () => ["key", "Backspace"]);
const CASES = [
  {
    name: "type bullets, Backspace them all away",
    start: "<h2>Title</h2><p>Above</p><p>Below</p>",
    steps: [
      ["caret", "p", "end", 0], ["key", "Enter"], ["type", "- "], ["type", "one"], ["key", "Enter"], ["type", "two"], ["check"],
      ...back(3), // "two"
      ...back(1), // the emptied item joins the one above
      ...back(3), // "one"
      ...back(1), // the only item: a blank paragraph
      ["expect", "<h2>Title</h2><p>Above</p><p><br></p><p>Below</p>"],
      ...back(1), // the blank paragraph goes
    ],
    same: "<h2>Title</h2><p>Above</p><p>Below</p>",
  },
  {
    name: "Backspace on an empty only item",
    start: "<p>Above</p><ul><li><br></li></ul><p>Below</p>",
    steps: [["caret", "li", "start"], ...back(1)],
    same: "<p>Above</p><p><br></p><p>Below</p>",
  },
  {
    name: "Backspace at the start of the first item with text",
    start: "<p>Above</p><ul><li>one</li><li>two</li></ul><p>Below</p>",
    steps: [["caret", "li", "start", 0], ...back(1)],
    same: "<p>Above</p><p>one</p><ul><li>two</li></ul><p>Below</p>",
  },
  {
    name: "unbullet every item from the top down",
    start: "<p>Above</p><ul><li>one</li><li>two</li><li>three</li></ul><p>Below</p>",
    steps: [["caret", "li", "start", 0], ...back(1), ["caret", "li", "start", 0], ...back(1), ["caret", "li", "start", 0], ...back(1)],
    same: "<p>Above</p><p>one</p><p>two</p><p>three</p><p>Below</p>",
  },
  {
    name: "unbullet a middle item, then the rest",
    start: "<p>Above</p><ul><li>one</li><li>two</li><li>three</li></ul><p>Below</p>",
    steps: [["caret", "li", "start", 2], ...back(1), ["caret", "li", "start", 1]],
    same: "<p>Above</p><ul><li>one</li><li>twothree</li></ul><p>Below</p>",
  },
  {
    name: "Enter on an empty last item leaves the list",
    start: "<p>Above</p><ul><li>one</li><li><br></li></ul><p>Below</p>",
    steps: [["caret", "li", "start", 1], ["key", "Enter"]],
    same: "<p>Above</p><ul><li>one</li></ul><p><br></p><p>Below</p>",
  },
  {
    name: "Enter on an empty middle item",
    start: "<p>Above</p><ul><li>one</li><li><br></li><li>three</li></ul><p>Below</p>",
    steps: [["caret", "li", "start", 1], ["key", "Enter"]],
    same: "<p>Above</p><ul><li>one</li></ul><p><br></p><ul><li>three</li></ul><p>Below</p>",
  },
  {
    name: "select every item, Backspace, Backspace",
    start: "<p>Above</p><ul><li>one</li><li>two</li><li>three</li></ul><p>Below</p>",
    steps: [["range", ["li", "start", 0], ["li", "end", 2]], ...back(1), ["expect", "<p>Above</p><p><br></p><p>Below</p>"], ...back(1)],
    same: "<p>Above</p><p>Below</p>",
  },
  {
    name: "select every item with Delete, then forward-delete the blank",
    start: "<p>Above</p><ul><li>one</li><li>two</li></ul><p>Below</p>",
    steps: [["range", ["li", "start", 0], ["li", "end", 1]], ["key", "Delete"], ["expect", "<p>Above</p><p><br></p><p>Below</p>"], ["key", "Delete"]],
    same: "<p>Above</p><p>Below</p>",
  },
  {
    name: "select across items, part of each",
    start: "<p>Above</p><ul><li>one</li><li>two</li><li>three</li></ul><p>Below</p>",
    steps: [["range", ["li", 2, 0], ["li", 2, 2]], ...back(1)],
    same: "<p>Above</p><ul><li>onree</li></ul><p>Below</p>",
  },
  {
    name: "select from a paragraph into a list",
    start: "<p>Above</p><ul><li>one</li><li>two</li></ul><p>Below</p>",
    steps: [["range", ["p", 2, 0], ["li", 1, 0]], ...back(1)],
    same: "<p>Abne</p><ul><li>two</li></ul><p>Below</p>",
  },
  {
    name: "select from a list into the paragraph below",
    start: "<p>Above</p><ul><li>one</li><li>two</li></ul><p>Below</p>",
    steps: [["range", ["li", 1, 1], ["p", 2, 1]], ...back(1)],
    same: "<p>Above</p><ul><li>one</li><li>tlow</li></ul>",
  },
  {
    name: "select from above a list to below it",
    start: "<p>Above</p><ul><li>one</li><li>two</li></ul><p>Below</p>",
    steps: [["range", ["p", 2, 0], ["p", 2, 1]], ...back(1)],
    same: "<p>Ablow</p>",
  },
  {
    name: "select from an item into a quote below",
    start: "<p>Above</p><ul><li>one</li><li>two</li></ul><blockquote>Quote</blockquote><p>Below</p>",
    steps: [["range", ["li", 1, 1], ["blockquote", 2, 0]], ...back(1)],
  },
  {
    name: "select a whole list and the quote below it",
    start: "<p>Above</p><ul><li>one</li></ul><blockquote>Quote</blockquote><p>Below</p>",
    steps: [["range", ["li", "start", 0], ["blockquote", "end", 0]], ...back(1)],
  },
  {
    name: "select across <li><p> items",
    start: "<p>Above</p><ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul><p>Below</p>",
    steps: [["range", ["li p", 1, 0], ["li p", 1, 2]], ...back(1)],
  },
  {
    name: "select all the region, Backspace, type",
    start: "<p>Above</p><ul><li>one</li><li>two</li></ul><p>Below</p>",
    steps: [["range", ["p", "start", 0], ["p", "end", 1]], ...back(1), ["type", "x"]],
    same: "<p>x</p>",
  },
  {
    name: "select all of a list-only region, Backspace, type",
    start: "<ul><li>one</li><li>two</li></ul>",
    steps: [["range", ["li", "start", 0], ["li", "end", 1]], ...back(1), ["type", "x"]],
    same: "<p>x</p>",
  },
  {
    name: "Backspace on a blank paragraph under a list",
    start: "<ul><li>one</li></ul><p><br></p><p>Below</p>",
    steps: [["caret", "p", "start", 0], ...back(1)],
    same: "<ul><li>one</li></ul><p>Below</p>",
  },
  {
    name: "Delete at the end of an item over a blank paragraph",
    start: "<ul><li>one</li></ul><p><br></p><p>Below</p>",
    steps: [["caret", "li", "end", 0], ["key", "Delete"]],
    same: "<ul><li>one</li></ul><p>Below</p>",
  },
  {
    name: "Delete in a blank paragraph over a list",
    start: "<p>Above</p><p><br></p><ul><li>one</li></ul>",
    steps: [["caret", "p", "start", 1], ["key", "Delete"]],
    same: "<p>Above</p><ul><li>one</li></ul>",
  },
  {
    name: "Backspace on a blank paragraph between two lists",
    start: "<ul><li>one</li></ul><p><br></p><ul><li>two</li></ul>",
    steps: [["caret", "p", "start", 0], ...back(1)],
    same: "<ul><li>one</li><li>two</li></ul>",
  },
  {
    name: "Backspace a paragraph up into the list above",
    start: "<ul><li>one</li></ul><p>Below</p><p>End</p>",
    steps: [["caret", "p", "start", 0], ...back(1)],
    same: "<ul><li>oneBelow</li></ul><p>End</p>",
  },
  {
    name: "Delete at the end of a paragraph over a list",
    start: "<p>Above</p><ul><li>one</li><li>two</li></ul>",
    steps: [["caret", "p", "end", 0], ["key", "Delete"]],
    same: "<p>Aboveone</p><ul><li>two</li></ul>",
  },
  {
    name: "Delete at the end of the last item over a paragraph",
    start: "<ul><li>one</li></ul><p>Below</p><p>End</p>",
    steps: [["caret", "li", "end", 0], ["key", "Delete"]],
    same: "<ul><li>oneBelow</li></ul><p>End</p>",
  },
  {
    name: "Backspace-merge two paragraphs",
    start: "<p>First</p><p>Second</p><p>Third</p>",
    steps: [["caret", "p", "start", 1], ...back(1)],
    same: "<p>FirstSecond</p><p>Third</p>",
  },
  {
    name: "Delete-merge two paragraphs",
    start: "<p>First</p><p>Second</p><p>Third</p>",
    steps: [["caret", "p", "end", 0], ["key", "Delete"]],
    same: "<p>FirstSecond</p><p>Third</p>",
  },
  {
    name: "Backspace a paragraph up into a heading",
    start: "<h2>Head</h2><p>Body</p><p>End</p>",
    steps: [["caret", "p", "start", 0], ...back(1)],
    same: "<h2>HeadBody</h2><p>End</p>",
  },
  {
    name: "Backspace a heading up into a paragraph",
    start: "<p>Body</p><h2>Head</h2><p>End</p>",
    steps: [["caret", "h2", "start", 0], ...back(1)],
    same: "<p>BodyHead</p><p>End</p>",
  },
  {
    name: "Delete a subheading up into a paragraph",
    start: "<p>Body</p><h3>Head</h3><p>End</p>",
    steps: [["caret", "p", "end", 0], ["key", "Delete"]],
    same: "<p>BodyHead</p><p>End</p>",
  },
  {
    name: "Backspace a paragraph up into a quote",
    start: "<blockquote>Quote</blockquote><p>Body</p><p>End</p>",
    steps: [["caret", "p", "start", 0], ...back(1)],
    same: "<blockquote>QuoteBody</blockquote><p>End</p>",
  },
  {
    name: "Backspace with bold at the seam",
    start: "<p>First <b>bold</b></p><p><b>more</b> text</p>",
    steps: [["caret", "p", "start", 1], ...back(1)],
    same: "<p>First <b>boldmore</b> text</p>",
    sameLoose: true, // <b>bold</b><b>more</b> reads the same; markup isn't the point here
  },
  {
    name: "Enter/Backspace chain at the end of a paragraph",
    start: "<p>First</p><p>Second</p>",
    steps: [["caret", "p", "end", 0], ["key", "Enter"], ["key", "Enter"], ["key", "Enter"], ["check"], ...back(3)],
    same: "<p>First</p><p>Second</p>",
  },
  {
    name: "Enter/Backspace chain in the middle of a paragraph",
    start: "<p>FirstSecond</p>",
    steps: [["caret", "p", 5, 0], ["key", "Enter"], ["key", "Enter"], ["check"], ["caret", "p", "start", 2], ...back(2)],
    same: "<p>FirstSecond</p>",
  },
  {
    name: "Enter after a heading, Backspace",
    start: "<h2>Head</h2><p>Body</p>",
    steps: [["caret", "h2", "end", 0], ["key", "Enter"], ["type", "x"], ["check"], ...back(2)],
    same: "<h2>Head</h2><p>Body</p>",
  },
  {
    name: "Shift-Enter then delete it",
    start: "<p>First</p><p>Second</p>",
    steps: [["caret", "p", "end", 0], ["key", "Enter", { shiftKey: true }], ["type", "x"], ...back(2)],
    same: "<p>First</p><p>Second</p>",
    sameLoose: true, // the live "First<br>" draws one line; the save trims the <br>
  },
  {
    name: "paste styled HTML from Google Docs",
    start: "<p>Above</p><p><br></p><p>Below</p>",
    steps: [
      ["caret", "p", "start", 1],
      ["paste", '<b style="font-weight:normal" id="docs-internal-guid-1"><p dir="ltr" style="line-height:1.38;margin-top:18pt"><span style="font-size:11pt;font-family:Arial">One</span></p><p dir="ltr" style="line-height:1.38"><span style="font-size:11pt">Two</span></p><ul style="margin-top:0"><li style="line-height:2"><p style="line-height:1.38"><span>Three</span></p></li></ul></b>', "One\nTwo\nThree"],
    ],
    same: "<p>Above</p><p>One</p><p>Two</p><ul><li>Three</li></ul><p>Below</p>",
  },
  {
    name: "paste styled HTML in the middle of a line",
    start: "<p>Before after</p><p>Below</p>",
    steps: [["caret", "p", 7, 0], ["paste", '<span style="font-size:20px;line-height:3;color:rgb(9,9,9)"><b>loud</b></span>', "loud"]],
    same: "<p>Before <b>loud</b>after</p><p>Below</p>",
    sameLoose: true, // Chromium keeps the space before the insert as &nbsp;; no vertical effect
  },
  {
    name: "paste two blocks into a list item",
    start: "<ul><li>one</li><li>two</li></ul><p>Below</p>",
    steps: [["caret", "li", "end", 0], ["paste", '<div style="line-height:2">Aa</div><div style="line-height:2">Bb</div>', "Aa\nBb"]],
  },
  {
    name: "insertHTML of styled text, as a browser extension or Edit menu would",
    start: "<p>First</p><p>Second</p>",
    steps: [["caret", "p", "end", 0], ["insertHtml", '<span style="line-height: 2.5; font-size: 22px;">big</span>'], ["type", "x"]],
    same: "<p>Firstbigx</p><p>Second</p>",
  },
  {
    name: "a <li><p> item: rhythm, Backspace, Backspace",
    start: "<p>Above</p><ul><li><p>one</p></li><li><p>two</p></li></ul><p>Below</p>",
    steps: [["check"], ["caret", "li p", "start", 0], ...back(1)],
    same: "<p>Above</p><p>one</p><ul><li><p>two</p></li></ul><p>Below</p>",
  },
  {
    name: "a <li><p> item joins the item above",
    start: "<ul><li><p>one</p></li><li><p>two</p></li></ul><p>Below</p>",
    steps: [["caret", "li p", "start", 1], ...back(1)],
    same: "<ul><li>onetwo</li></ul><p>Below</p>",
  },
  {
    name: "Backspace an emptied <li><p> item",
    start: "<p>Above</p><ul><li><p><br></p></li></ul><p>Below</p>",
    steps: [["caret", "li p", "start", 0], ...back(1)],
    same: "<p>Above</p><p><br></p><p>Below</p>",
  },
  {
    name: "nested list: same rhythm at each level, then Backspace out",
    start: "<p>Above</p><ul><li>one<ul><li>sub</li><li>sub2</li></ul></li><li>two</li></ul><p>Below</p>",
    steps: [["check"], ["caret", "li", "start", 2], ...back(1), ["check"], ["caret", "li", "start", 1], ...back(1), ["check"]],
  },
  {
    name: "nested item emptied and deleted",
    start: "<p>Above</p><ul><li>one<ul><li>x</li></ul></li></ul><p>Below</p>",
    steps: [["caret", "li", "end", 1], ...back(1), ...back(1), ...back(1)],
    same: "<p>Above</p><ul><li>one</li></ul><p>Below</p>",
  },
  {
    name: "inline marks don't change a line's height",
    start: '<p>Plain text</p><p>With <code>code</code> in it</p><p>With <b>bold</b> and <i>italics</i> and <a href="https://example.com">a link</a></p><p>With <kbd>kbd</kbd> and x<sup>2</sup> and y<sub>3</sub></p><ul><li>An <code>item</code></li></ul><p>End</p>',
    steps: [],
  },
  {
    name: "empty blocks: one line, normal margins",
    start: "<p>One</p><p><br></p><p><br></p><p>Two</p><ul><li><br></li><li>x</li></ul><h3>Three</h3><p><br></p>",
    steps: [],
  },
  {
    name: "a heading after a non-text block keeps its margin while editing",
    file: '<div class="block">Not text</div>\n<h2>Head</h2>\n<p>Body</p>',
    steps: [["expectTopGap", 36]],
  },
  {
    name: "a saved page's stamped span doesn't teach the editor to keep new ones",
    file: '<h2>Head</h2>\n<p>Body <span style="font-size: 16px;">old</span></p>',
    steps: [["caret", "p", "start", 0], ...back(1)],
    same: "<h2>HeadBody old</h2>",
  },
  {
    name: "a saved page: junk heals on the next edit, the author's spans stay",
    file: [
      '<p style="line-height: 1.38;">Styled paragraph</p>',
      '<p>One <span style="font-size: 16px; line-height: 24.8px;">merged</span> line</p>',
      '<p>Two <span style="color: rgb(200, 0, 0);">kept</span> <font style="line-height: 2;">font</font></p>',
      "<ul></ul>",
      "<ul><li><br></li></ul>",
      '<ol style="line-height: 1.38;"><li style="line-height: 1.38;">item</li></ol>',
      "<p></p>",
      '<p>Last<span style="letter-spacing: normal; font-size: 16px;"></span></p>',
    ].join("\n"),
    steps: [["caret", "p", "end", 0], ["type", "!"]],
    same: '<p>Styled paragraph!</p><p>One merged line</p><p>Two <span style="color: rgb(200, 0, 0);">kept</span> font</p><ol><li>item</li></ol><p>Last</p>',
    allow: { span: true, style: true },
    savedHas: ["Styled paragraph!", '<span style="color: rgb(200, 0, 0);">kept</span>'],
    savedLacks: ["line-height", "font-size", "<ul>", "<font"],
  },
];

/* ---- running */

async function run({ win, getVault }) {
  // A file written from here reloads the page; a plain remount, not the buffered swap, so the frame this script holds is the one on screen.
  await win.webContents.executeJavaScript("window.__quireSwapOff = true");
  // Never let a mistyped run line edit a real vault.
  const vault = fs.realpathSync(getVault());
  const realHome = fs.realpathSync(os.userInfo().homedir);
  if (vault.startsWith(realHome + path.sep)) throw new Error(`refusing to edit a vault under the real home: ${vault}. See the run line at the top of this file.`);

  const frame = () => win.webContents.mainFrame.frames[0];
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      try {
        const f = frame();
        if (f) {
          const v = await f.executeJavaScript(fn);
          if (v) return v;
        }
      } catch {}
      if (Date.now() > end) return null;
      await sleep(100);
    }
  };
  const ready = `document.documentElement.classList.contains("q-edit") && !!document.querySelector("[data-q-region]")`;
  const js = (s) => frame().executeJavaScript(s);
  const call = (name, ...args) => js(`window.__sp.${name}(...${JSON.stringify(args)})`);
  const sp = async () => {
    if (!(await until(ready))) throw new Error("the page never reached edit mode");
    await js(PAGE_HELPERS);
  };

  const pageFile = path.join(vault, "Welcome", "index.html");
  if (!fs.existsSync(pageFile)) throw new Error(`no ${pageFile}; run with QUIRE_OPEN_PAGE=Welcome on a fresh vault`);
  const original = fs.readFileSync(pageFile, "utf8");
  // One plain region to edit: the seeded Welcome has a script-free head we keep.
  const fileWith = (body) => `<!doctype html><html><head><title>Welcome</title></head><body>\n${body}\n</body></html>\n`;
  const reloadWith = async (body) => {
    fs.writeFileSync(pageFile, fileWith(body));
    await sleep(600); // the save and watcher settle
    await js("location.reload(); true").catch(() => {});
    await sleep(500);
    await sp();
  };
  await reloadWith("<p>Spacing check</p>");

  const only = process.env.SPACING_ONLY || "";
  const rows = [];
  let ran = 0;
  for (const c of CASES) {
    if (only && !c.name.includes(only)) continue;
    ran++;
    const push = (o) => rows.push({ case: c.name, ...o });
    try {
      if (c.file != null) await reloadWith(c.file);
      else await call("set", c.start);
      for (const step of c.steps) {
        const [name, ...args] = step;
        if (name === "check") (await call("audit", c.allow || {})).forEach((o) => push({ ...o, what: "mid-way: " + o.what }));
        else if (name === "expect") {
          const got = await call("html");
          if (got !== args[0]) push({ what: "mid-way markup", where: "", got, want: args[0] });
        } else if (name === "expectTopGap") {
          const got = await call("topGap");
          if (Math.abs(got - args[0]) > 0.51) push({ what: "gap above the region", where: "", got: got.toFixed(2) + "px", want: args[0] + "px" });
        } else await call(name, ...args);
        await sleep(0);
      }
      (await call("audit", c.allow || {})).forEach(push);
      const got = await call("html");
      if (process.env.SPACING_DEBUG) console.log(`[${c.name}]\n  ${got}`);
      const after = await call("height");
      if (c.savedHas || c.savedLacks) {
        await sleep(900); // past the save debounce
        const saved = fs.readFileSync(pageFile, "utf8");
        (c.savedHas || []).forEach((s) => { if (!saved.includes(s)) push({ what: "saved file lacks", where: "", got: saved.slice(0, 200), want: s }); });
        (c.savedLacks || []).forEach((s) => { if (saved.includes(s)) push({ what: "saved file holds", where: "", got: s, want: "gone" }); });
      }
      if (c.same != null) {
        if (!c.sameLoose && got !== c.same) push({ what: "markup", where: "", got, want: c.same });
        await call("set", c.same);
        const clean = await call("height");
        if (Math.abs(after - clean) > 0.5) push({ what: "region height vs clean page", where: "", got: after + "px", want: clean + "px" });
      }
    } catch (e) {
      push({ what: "error", where: "", got: String(e && e.message), want: "" });
    }
  }

  fs.writeFileSync(pageFile, original);

  const clip = (s, n) => {
    s = String(s == null ? "" : s).replace(/\s+/g, " ");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  if (rows.length) {
    const cols = [["case", 40], ["what", 28], ["where", 44], ["got", 56], ["want", 56]];
    const line = (r) => cols.map(([k, w]) => clip(r[k], w).padEnd(w)).join(" | ");
    console.log(line({ case: "case", what: "what", where: "where", got: "got", want: "want" }));
    console.log(cols.map(([, w]) => "-".repeat(w)).join("-+-"));
    rows.forEach((r) => console.log(line(r)));
  }
  const failed = new Set(rows.map((r) => r.case));
  console.log(`\nverify-editor-spacing: ${ran - failed.size}/${ran} cases clean, ${rows.length} offenders`);
  if (rows.length) throw new Error(`${rows.length} spacing offenders`);
}

export default run;
