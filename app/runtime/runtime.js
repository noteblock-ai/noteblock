/* Quire page runtime. Served at quire://runtime/runtime.js and loaded as a classic script in
 * <head>, so `window.quire` exists before any page module runs. See docs/contract.md,
 * "Page runtime".
 *
 * - RPCs go straight to window.top (the renderer) with params.page = this page's path.
 * - `resize` goes to window.parent (the page holding this embed).
 * - `mode` / `store-changed` arrive at the top page frame and every runtime relays them to its
 *   own embed iframes.
 * - Edit mode (top page frame only): text regions, selection toolbar, "/" menu, debounced save.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ editor: pure HTML helpers */

  // Paste sanitizing, copy-out text and list repair. They need no browser: the editor runs
  // them on live nodes (or on its own little tree, for strings), and scripts/smoke-editor.mjs
  // runs the same code in node. Only childNodes/parentNode/insertBefore/removeChild/appendChild,
  // nodeType/tagName/nodeValue and the attribute calls are used, which both trees have.

  function tagSet(s) {
    var o = {};
    s.split(" ").forEach(function (t) { o[t] = true; });
    return o;
  }
  var VOID = tagSet("AREA BASE BR COL EMBED HR IMG INPUT LINK META PARAM SOURCE TRACK WBR");
  var RAW_TEXT = tagSet("SCRIPT STYLE TEXTAREA TITLE XMP NOSCRIPT IFRAME NOEMBED NOFRAMES");
  var BLOCKS = tagSet("P H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE TABLE THEAD TBODY TFOOT TR TD TH HR FIGURE FIGCAPTION DIV SECTION ARTICLE HEADER FOOTER MAIN ASIDE NAV ADDRESS DL DT DD CAPTION FORM FIELDSET DETAILS SUMMARY CENTER QUIRE-EMBED");
  // Top-level nodes a region may hold as they are (everything else is wrapped in a <p>).
  var TOP_OK = tagSet("P H1 H2 H3 H4 H5 H6 UL OL BLOCKQUOTE PRE TABLE HR FIGURE IMG DIV QUIRE-EMBED IFRAME");
  var TEXT_BLOCKS = tagSet("P H1 H2 H3 H4 H5 H6 LI BLOCKQUOTE TD TH");
  // Never looked inside: embeds, app blocks, editor UI.
  function opaque(n) {
    return n.nodeType === 1 && (n.tagName === "QUIRE-EMBED" || n.tagName === "IFRAME" || n.getAttribute("contenteditable") === "false" ||
      n.getAttribute("data-app") != null || n.getAttribute("data-q-ui") != null);
  }

  var ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", trade: "™", times: "×", deg: "°", euro: "€", laquo: "«", raquo: "»", zwj: "‍", zwnj: "‌" };
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, function (m, e) {
      if (e.charAt(0) === "#") {
        var c = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; } catch (err) { return m; }
      }
      var v = ENT[e] || ENT[e.toLowerCase()];
      return v != null ? v : m;
    });
  }
  function escapeText(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;"); }
  function escapeAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;"); }

  /* ---- a tiny tree, for strings */

  function MNode(type, name) {
    this.nodeType = type;
    this.tagName = name;
    this.nodeValue = null;
    this.attributes = [];
    this.childNodes = [];
    this.parentNode = null;
  }
  MNode.prototype.insertBefore = function (n, ref) {
    if (n.nodeType === 11) {
      var self = this;
      n.childNodes.slice().forEach(function (k) { self.insertBefore(k, ref); });
      return n;
    }
    if (n.parentNode) n.parentNode.removeChild(n);
    var i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    return n;
  };
  MNode.prototype.appendChild = function (n) { return this.insertBefore(n, null); };
  MNode.prototype.removeChild = function (n) {
    var i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  };
  MNode.prototype.getAttribute = function (name) {
    for (var i = 0; i < this.attributes.length; i++) if (this.attributes[i].name === name) return this.attributes[i].value;
    return null;
  };
  MNode.prototype.setAttribute = function (name, value) {
    for (var i = 0; i < this.attributes.length; i++) if (this.attributes[i].name === name) { this.attributes[i].value = String(value); return; }
    this.attributes.push({ name: name, value: String(value) });
  };
  MNode.prototype.removeAttribute = function (name) {
    this.attributes = this.attributes.filter(function (a) { return a.name !== name; });
  };
  var mdoc = {
    createElement: function (t) { return new MNode(1, String(t).toUpperCase()); },
    createTextNode: function (s) { var n = new MNode(3, "#text"); n.nodeValue = String(s); return n; },
  };

  function parseAttrs(src) {
    var out = [];
    var seen = {};
    var re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    var m;
    while ((m = re.exec(src))) {
      var name = m[1].toLowerCase();
      if (seen[name]) continue;
      seen[name] = true;
      var v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : "";
      out.push({ name: name, value: decodeEntities(v) });
    }
    return out;
  }

  /** HTML string → a fragment of MNodes. Forgiving, like a browser, for clipboard HTML. */
  function parseHtml(html) {
    html = String(html == null ? "" : html);
    var lower = html.toLowerCase();
    var root = new MNode(11, "#fragment");
    var stack = [root];
    var top = function () { return stack[stack.length - 1]; };
    var addText = function (s) { if (s) top().appendChild(mdoc.createTextNode(decodeEntities(s))); };
    var popTo = function (names, stops) {
      for (var i = stack.length - 1; i > 0; i--) {
        var tg = stack[i].tagName;
        if (stops[tg]) return;
        if (names[tg]) { stack.length = i; return; }
      }
    };
    var re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s\/>]*)[^>]*>|<([a-zA-Z][^\s\/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    var last = 0;
    var m;
    while ((m = re.exec(html))) {
      addText(html.slice(last, m.index));
      last = re.lastIndex;
      if (m[1]) {
        var ct = m[1].toUpperCase();
        for (var i = stack.length - 1; i > 0; i--) if (stack[i].tagName === ct) { stack.length = i; break; }
        continue;
      }
      if (!m[2]) continue; // comment, doctype
      var t = m[2].toUpperCase();
      if (BLOCKS[t] && top().tagName === "P") stack.pop();
      if (t === "LI") popTo({ LI: 1 }, { UL: 1, OL: 1 });
      if (t === "TD" || t === "TH") popTo({ TD: 1, TH: 1 }, { TR: 1, TABLE: 1 });
      if (t === "TR") popTo({ TR: 1, TD: 1, TH: 1 }, { TABLE: 1, TBODY: 1, THEAD: 1, TFOOT: 1 });
      var n = new MNode(1, t);
      n.attributes = parseAttrs(m[3] || "");
      top().appendChild(n);
      if (RAW_TEXT[t]) {
        var end = lower.indexOf("</" + t.toLowerCase(), last);
        if (end < 0) end = html.length;
        var raw = html.slice(last, end);
        if (raw) n.appendChild(mdoc.createTextNode(t === "TEXTAREA" || t === "TITLE" ? decodeEntities(raw) : raw));
        var close = html.indexOf(">", end);
        last = close < 0 ? html.length : close + 1;
        re.lastIndex = last;
        continue;
      }
      if (!VOID[t] && !/\/\s*$/.test(m[3] || "")) stack.push(n);
    }
    addText(html.slice(last));
    return root;
  }

  /** The children of `node` as HTML (innerHTML), for MNodes and live nodes alike. */
  function serializeHtml(node) {
    var out = "";
    kids(node).forEach(function (n) {
      if (n.nodeType === 3) { out += escapeText(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      var t = n.tagName.toLowerCase();
      out += "<" + t;
      Array.prototype.forEach.call(n.attributes, function (a) { out += " " + a.name + '="' + escapeAttr(a.value) + '"'; });
      out += ">";
      if (VOID[n.tagName]) return;
      out += serializeHtml(n) + "</" + t + ">";
    });
    return out;
  }

  /* ---- tree helpers (live or MNode) */

  function kids(n) { return Array.prototype.slice.call(n.childNodes); }
  function tagOf(n) { return n && n.nodeType === 1 ? n.tagName : ""; }
  function sibling(n, d) {
    var p = n.parentNode;
    if (!p) return null;
    return p.childNodes[Array.prototype.indexOf.call(p.childNodes, n) + d] || null;
  }
  function textOf(n) {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1 && n.nodeType !== 11) return "";
    var s = "";
    for (var i = 0; i < n.childNodes.length; i++) s += textOf(n.childNodes[i]);
    return s;
  }
  function isBlank(s) { return !String(s).replace(/[\s ​﻿]/g, ""); }
  function isWs(n) { return n.nodeType === 3 && !n.nodeValue.replace(/[ \t\n\r\f]/g, ""); }
  function hasDesc(n, tags) {
    for (var i = 0; i < n.childNodes.length; i++) {
      var c = n.childNodes[i];
      if (c.nodeType === 1 && (tags[c.tagName] || hasDesc(c, tags))) return true;
    }
    return false;
  }
  var SOLID = tagSet("IMG HR QUIRE-EMBED IFRAME INPUT TABLE VIDEO");
  function isEmptyNode(n) { return isBlank(textOf(n)) && !(n.nodeType === 1 && (SOLID[n.tagName] || hasDesc(n, SOLID))); }
  function contains(a, b) {
    for (; b; b = b.parentNode) if (b === a) return true;
    return false;
  }
  function removeNode(n) { if (n.parentNode) n.parentNode.removeChild(n); }
  function unwrapNode(n) {
    var p = n.parentNode;
    if (!p) return;
    while (n.childNodes.length) p.insertBefore(n.childNodes[0], n);
    p.removeChild(n);
  }
  function renameNode(n, t, doc) {
    var e = doc.createElement(t);
    while (n.childNodes.length) e.appendChild(n.childNodes[0]);
    n.parentNode.insertBefore(e, n);
    n.parentNode.removeChild(n);
    return e;
  }
  /** Elements under root in document order, not looking inside opaque ones. */
  function elementsIn(root, test) {
    var out = [];
    (function walk(n) {
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.nodeType !== 1) continue;
        if (test(c)) out.push(c);
        if (!opaque(c)) walk(c);
      }
    })(root);
    return out;
  }
  function isList(n) { return n && n.nodeType === 1 && (n.tagName === "UL" || n.tagName === "OL"); }
  function ownLists(li) { return kids(li).filter(isList); }

  // What Chromium stamps on merged text (and Google Docs on a whole copy): computed values that
  // only repeat the theme. True when an inline style is nothing but that. A style that says
  // anything else (a real colour, a margin, a width) is the author's, and so is a lone font-size
  // on a block or a relative one on a span. These exact strings are a heading's or a quote's look
  // carried over by a merge, as Chromium writes them against theme.css.
  var STAMP_EXACT = {
    "font-size: 1.4375em; font-weight: 600; letter-spacing: -0.01em;": 1, // h2
    "font-size: 1.125em; font-weight: 600;": 1, // h3
    "color: rgb(21, 23, 28);": 1, // --q-ink, a paragraph into a quote
    "color: rgb(91, 98, 112);": 1, // --q-muted, a quote into a paragraph
  };
  var STAMP_ANY = /^(line-height|letter-spacing|word-spacing|font-variant(-[a-z-]+)?|font-kerning|font-feature-settings|font-family|font-stretch|text-indent|text-transform|text-decoration(-[a-z]+)?|white-space|white-space-collapse|text-wrap(-[a-z]+)?|orphans|widows|vertical-align|-webkit-text-stroke-width|-webkit-text-fill-color)$/;
  function stampedStyle(style, inlineEl) {
    var src = String(style || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/;?$/, ";");
    if (inlineEl && STAMP_EXACT[src]) return true;
    var lh = false;
    var px = false;
    var loud = false; // says more than the theme unless a line-height shows it was stamped
    var stamped = src.split(";").every(function (d) {
      if (!d.trim()) return true;
      var i = d.indexOf(":");
      if (i < 0) return false;
      var prop = d.slice(0, i).trim();
      var val = d.slice(i + 1).trim();
      if (prop === "line-height") lh = true;
      if (prop === "font-size") {
        if (/^[\d.]+(px|pt)$/.test(val)) { px = true; return true; }
        loud = true;
        return /^[\d.]+(em|rem|%)$/.test(val);
      }
      if (prop === "font-weight") {
        if (/^(normal|400)$/.test(val)) return true;
        loud = true;
        return /^(bold|[5-9]00)$/.test(val);
      }
      if (prop === "font-style") return val === "normal";
      if (prop === "color") { loud = true; return /^rgba?\(/.test(val); }
      if (prop === "background-color") return /^(transparent|rgba\(0, ?0, ?0, ?0\))$/.test(val);
      return STAMP_ANY.test(prop);
    });
    return stamped && (lh || (px && !loud && !!inlineEl));
  }
  // Inline style the browser stamped goes, then spans and <font>s left with no attributes at all
  // (they draw nothing). This one works on what's already in a saved file too.
  function healStamps(root) {
    var changed = false;
    elementsIn(root, function (n) { return n.getAttribute("style") != null; }).forEach(function (n) {
      if (opaque(n) || !stampedStyle(n.getAttribute("style"), n.tagName === "SPAN" || n.tagName === "FONT")) return;
      n.removeAttribute("style");
      changed = true;
    });
    elementsIn(root, function (n) { return (n.tagName === "SPAN" || n.tagName === "FONT") && !n.attributes.length; }).reverse().forEach(function (n) {
      unwrapNode(n);
      changed = true;
    });
    return changed;
  }

  /**
   * Repairs what contenteditable leaves in lists and blocks. Returns true when it changed
   * anything. Options: keep (a node never removed: the caret's item), dropEmpty (empty <li>),
   * keepSpan(el) (true for spans that were in the file), wrapTop (inline runs at the top level
   * become <p>s), dropBrRuns, trimBr (a lone trailing <br> after text), paste (the stricter
   * pass for pasted HTML: <p>s out of items, empty blocks dropped).
   */
  function normalizeBlocks(root, doc, o) {
    o = o || {};
    var changed = false;
    var keep = o.keep || null;
    var kept = function (n) { return keep && contains(n, keep); };

    if (healStamps(root)) changed = true;

    // Style-only spans (and <font>) the browser made while merging blocks.
    if (o.keepSpan) {
      elementsIn(root, function (n) { return n.tagName === "SPAN" || n.tagName === "FONT"; }).reverse().forEach(function (n) {
        if (o.keepSpan(n)) return;
        var other = Array.prototype.some.call(n.attributes, function (a) { return a.name !== "style" && a.name !== "color" && a.name !== "face" && a.name !== "size"; });
        if (other) return;
        unwrapNode(n);
        changed = true;
      });
    }

    // Bare <div>s: a paragraph at the top, a line break inside an item.
    elementsIn(root, function (n) { return n.tagName === "DIV" && !n.attributes.length; }).reverse().forEach(function (n) {
      var p = n.parentNode;
      if (p === root) { renameNode(n, "P", doc); changed = true; }
      else if (tagOf(p) === "LI") { flattenInto(n, doc); changed = true; }
    });

    // Blocks can't sit in a paragraph or heading (the next load would split it around an empty
    // <p>): lift them out, inline runs stay.
    elementsIn(root, function (n) { return /^(P|H[1-6])$/.test(n.tagName); }).reverse().forEach(function (p) {
      if (!kids(p).some(function (c) { return c.nodeType === 1 && BLOCKS[c.tagName]; })) return;
      changed = true;
      var run = null;
      kids(p).forEach(function (c) {
        if (c.nodeType === 1 && BLOCKS[c.tagName]) { run = null; p.parentNode.insertBefore(c, p); }
        else if (run || !isWs(c)) {
          if (!run) { run = doc.createElement(p.tagName); p.parentNode.insertBefore(run, p); }
          run.appendChild(c);
        }
      });
      removeNode(p);
    });

    if (o.paste) {
      // Paragraphs inside items and cells become lines.
      elementsIn(root, function (n) { return n.tagName === "P" && /^(LI|TD|TH)$/.test(tagOf(n.parentNode)); }).reverse().forEach(function (p) {
        flattenInto(p, doc);
      });
      changed = true;
    }

    // Lists hold items only.
    elementsIn(root, isList).forEach(function (list) {
      var run = null;
      kids(list).forEach(function (c) {
        var t = tagOf(c);
        if (t === "LI") { run = null; return; }
        if (isWs(c)) return;
        changed = true;
        if (t === "BR" || (c.nodeType !== 1 && c.nodeType !== 3)) { removeNode(c); return; }
        if (t === "UL" || t === "OL") {
          // A list right inside a list (Google Docs nests that way): it belongs to the item above.
          var prev = sibling(c, -1);
          while (prev && isWs(prev)) prev = sibling(prev, -1);
          if (tagOf(prev) === "LI") prev.appendChild(c);
          else { var li = doc.createElement("LI"); list.insertBefore(li, c); li.appendChild(c); }
          run = null;
          return;
        }
        if (c.nodeType === 1 && BLOCKS[t]) {
          var item = doc.createElement("LI");
          list.insertBefore(item, c);
          while (c.childNodes.length) item.appendChild(c.childNodes[0]);
          removeNode(c);
          run = null;
          return;
        }
        if (!run) { run = doc.createElement("LI"); list.insertBefore(run, c); }
        run.appendChild(c);
      });
    });

    // Inline runs at the top level go into paragraphs.
    if (o.wrapTop) {
      var run = null;
      var runs = [];
      kids(root).forEach(function (c) {
        if (c.nodeType === 1 && TOP_OK[c.tagName]) { run = null; return; }
        if (c.nodeType !== 1 && c.nodeType !== 3) return;
        if (!run) {
          if (isWs(c)) return;
          run = doc.createElement("P");
          root.insertBefore(run, c);
          runs.push(run);
        }
        run.appendChild(c);
      });
      runs.forEach(function (p) {
        changed = true;
        // Trailing whitespace taken into the run goes back out.
        while (p.childNodes.length && isWs(p.childNodes[p.childNodes.length - 1])) {
          root.insertBefore(p.childNodes[p.childNodes.length - 1], sibling(p, 1));
        }
        if (isEmptyNode(p) && !kept(p)) {
          var onlyBr = kids(p).every(function (c) { return tagOf(c) === "BR" || isWs(c); });
          // Not the region's only line, though: the caret needs one to stand on.
          var alone = !kids(root).some(function (c) { return c !== p && c.nodeType === 1; });
          if ((o.dropBrRuns && !alone) || !onlyBr) removeNode(p);
          else { kids(p).forEach(removeNode); p.appendChild(doc.createElement("BR")); }
        }
      });
    }

    // Empty items, then lists left with none.
    if (o.dropEmpty || o.paste) {
      elementsIn(root, function (n) { return n.tagName === "LI"; }).reverse().forEach(function (li) {
        if (!kept(li) && isEmptyNode(li) && !(o.keepItem && o.keepItem(li))) { removeNode(li); changed = true; }
      });
    }
    // A list of nothing but empty items is no list either, wherever the caret went after it.
    elementsIn(root, isList).reverse().forEach(function (list) {
      if (kept(list)) return;
      if (kids(list).some(function (c) { return tagOf(c) === "LI" && !isEmptyNode(c); })) return;
      if (kids(list).some(function (c) { return c.nodeType === 1 && tagOf(c) !== "LI"; })) return;
      removeNode(list);
      changed = true;
    });
    // A <p> with nothing at all in it has no height, so its margins collapse into a gap that
    // isn't there until someone types near it. (A blank line is <p><br></p>, and stays.)
    elementsIn(root, function (n) { return n.tagName === "P"; }).forEach(function (p) {
      if (kept(p) || !kids(p).every(isWs)) return;
      if (Array.prototype.some.call(p.attributes, function (a) { return a.name.indexOf("data-q-") !== 0 || a.name.indexOf("data-q-ai") === 0; })) return;
      removeNode(p);
      changed = true;
    });

    // Two lists of a kind back to back read as one list numbered twice: join them.
    elementsIn(root, isList).forEach(function (list) {
      if (!list.parentNode) return;
      for (;;) {
        var n = sibling(list, 1);
        var gap = [];
        while (n && isWs(n)) { gap.push(n); n = sibling(n, 1); }
        if (!n || n.tagName !== list.tagName || n.getAttribute("start") != null) break;
        gap.forEach(removeNode);
        while (n.childNodes.length) list.appendChild(n.childNodes[0]);
        removeNode(n);
        changed = true;
      }
    });

    if (o.paste) {
      elementsIn(root, function (n) { return /^(B|STRONG|I|EM|A|CODE|P|H[1-6]|BLOCKQUOTE|PRE)$/.test(n.tagName); }).reverse().forEach(function (n) {
        if (n.parentNode && isEmptyNode(n) && !(n.tagName === "PRE" && textOf(n))) {
          if (/^(B|STRONG|I|EM|A|CODE)$/.test(n.tagName) && textOf(n)) unwrapNode(n); // just a space
          else removeNode(n);
        }
      });
    }

    // "text<br>" at the end of a block: the <br> draws nothing, the file doesn't need it.
    if (o.trimBr) {
      elementsIn(root, function (n) { return TEXT_BLOCKS[n.tagName]; }).forEach(function (b) {
        var cs = kids(b);
        var end = cs.length;
        if (b.tagName === "LI") { var first = cs.findIndex(isList); if (first >= 0) end = first; }
        var i = end - 1;
        while (i >= 0 && isWs(cs[i])) i--;
        if (i < 1 || tagOf(cs[i]) !== "BR" || tagOf(cs[i - 1]) === "BR") return;
        if (isBlank(cs.slice(0, i).map(textOf).join(""))) return;
        removeNode(cs[i]);
        changed = true;
      });
    }
    return changed;
  }

  // Unwraps a block into its parent, a <br> standing in for each line it ended.
  function flattenInto(n, doc) {
    var prev = sibling(n, -1);
    while (prev && isWs(prev)) prev = sibling(prev, -1);
    if (prev && !isList(prev) && tagOf(prev) !== "BR" && !(prev.nodeType === 1 && BLOCKS[prev.tagName])) n.parentNode.insertBefore(doc.createElement("BR"), n);
    var next = sibling(n, 1);
    while (next && isWs(next)) next = sibling(next, 1);
    if (next && !isList(next) && !(next.nodeType === 1 && BLOCKS[next.tagName]) && !isEmptyNode(n)) n.parentNode.insertBefore(doc.createElement("BR"), sibling(n, 1));
    unwrapNode(n);
  }

  /* ---- paste in */

  var DROP = tagSet("SCRIPT STYLE META LINK TITLE HEAD TEMPLATE NOSCRIPT IFRAME OBJECT EMBED SVG MATH CANVAS VIDEO AUDIO BUTTON INPUT SELECT TEXTAREA OPTION COLGROUP COL BASE QUIRE-EMBED");
  var KEEP = {
    P: [], H1: [], H2: [], H3: [], UL: [], OL: ["start"], LI: [], B: [], STRONG: [], I: [], EM: [], A: ["href"], CODE: [], PRE: [],
    BLOCKQUOTE: [], IMG: ["src", "alt"], TABLE: [], THEAD: [], TBODY: [], TFOOT: [], TR: [], TH: ["colspan", "rowspan"], TD: ["colspan", "rowspan"], BR: [], HR: [],
  };
  var RENAME = {
    H4: "H3", H5: "H3", H6: "H3", TT: "CODE", KBD: "CODE", SAMP: "CODE", DIV: "P", SECTION: "P", ARTICLE: "P", MAIN: "P", HEADER: "P", FOOTER: "P",
    ASIDE: "P", NAV: "P", ADDRESS: "P", CENTER: "P", FIGURE: "P", FIGCAPTION: "P", DL: "P", DT: "P", DD: "P", CAPTION: "P", DETAILS: "P",
    SUMMARY: "P", FIELDSET: "P", LEGEND: "P", FORM: "P",
  };

  function safeHref(v) {
    v = String(v || "").trim();
    return !!v && (/^(https?:|mailto:|tel:|quire:|#|\/|\.)/i.test(v) || !/^[^\/?#]*:/.test(v));
  }
  function safeSrc(v) {
    v = String(v || "").trim();
    return !!v && (/^(https?:|quire:|data:image\/)/i.test(v) || !/^[^\/?#]*:/.test(v));
  }

  function sanitizeKids(el, inPre) {
    kids(el).forEach(function (n) {
      if (n.nodeType === 3) return;
      if (n.nodeType !== 1) { removeNode(n); return; }
      var t = n.tagName;
      if (DROP[t]) { removeNode(n); return; }
      var style = String(n.getAttribute("style") || "").toLowerCase();
      sanitizeKids(n, inPre || t === "PRE");
      if (inPre) {
        if (t === "BR") { n.parentNode.insertBefore(textLike(n, "\n"), n); removeNode(n); return; }
        if (t !== "CODE") { unwrapNode(n); return; }
      }
      if (RENAME[t]) { n = renameNode(n, RENAME[t], docOf(n)); t = n.tagName; }
      // Google Docs wraps a whole copy in <b style="font-weight:normal" id="docs-internal-guid-…">.
      if ((t === "B" || t === "STRONG") && /font-weight\s*:\s*(normal|[1-5]00)\b/.test(style)) { unwrapNode(n); return; }
      if (!KEEP[t]) {
        // Spans and the like: keep the bold/italic/code their style says, drop the rest.
        var wraps = [];
        if (/font-weight\s*:\s*(bold|bolder|[6-9]00)\b/.test(style)) wraps.push("B");
        if (/font-style\s*:\s*italic/.test(style)) wraps.push("I");
        if (/font-family\s*:[^;]*(mono|courier|consolas|menlo)/.test(style)) wraps.push("CODE");
        var inner = n;
        wraps.forEach(function (w) {
          var e = docOf(n).createElement(w);
          while (inner.childNodes.length) e.appendChild(inner.childNodes[0]);
          inner.appendChild(e);
          inner = e;
        });
        unwrapNode(n);
        return;
      }
      var allowed = KEEP[t];
      Array.prototype.map.call(n.attributes, function (a) { return a.name; }).forEach(function (name) {
        if (allowed.indexOf(name) === -1) n.removeAttribute(name);
      });
      if (t === "A" && !safeHref(n.getAttribute("href"))) { unwrapNode(n); return; }
      if (t === "IMG" && !safeSrc(n.getAttribute("src"))) { removeNode(n); return; }
      if (t === "OL" && n.getAttribute("start") != null && !(Number(n.getAttribute("start")) > 1)) n.removeAttribute("start");
    });
  }
  function docOf(n) { return n instanceof MNode ? mdoc : n.ownerDocument; }
  function textLike(n, s) { return docOf(n).createTextNode(s); }

  // Source formatting whitespace goes; spaces between words stay.
  function tidyWhitespace(root) {
    (function walk(el, inPre) {
      kids(el).forEach(function (n) {
        if (n.nodeType === 3) { if (!inPre) n.nodeValue = n.nodeValue.replace(/[ \t\n\r\f]+/g, " "); return; }
        if (n.nodeType === 1) walk(n, inPre || n.tagName === "PRE");
      });
    })(root, false);
    // Trim at the edges of blocks and line breaks, and drop whitespace between blocks.
    var edge = function (n) { return !n || (n.nodeType === 1 && (BLOCKS[n.tagName] || n.tagName === "BR")); };
    (function walk(el) {
      if (tagOf(el) === "PRE") return;
      kids(el).forEach(function (n) {
        if (n.nodeType === 1) { walk(n); return; }
        if (n.nodeType !== 3) return;
        var prev = sibling(n, -1);
        var next = sibling(n, 1);
        var blockParent = el.nodeType === 11 || BLOCKS[el.tagName];
        if (edge(prev) && blockParent) n.nodeValue = n.nodeValue.replace(/^ +/, "");
        if (edge(next) && blockParent) n.nodeValue = n.nodeValue.replace(/ +$/, "");
        if (!n.nodeValue) removeNode(n);
      });
    })(root);
  }

  /** Clipboard HTML from anywhere → the editor's own tags. */
  function sanitizeHtml(html) {
    var root = parseHtml(html);
    // <html>/<body> wrappers and Word's <o:p> just go.
    elementsIn(root, function (n) { return n.tagName === "HTML" || n.tagName === "BODY"; }).forEach(unwrapNode);
    sanitizeKids(root, false);
    tidyWhitespace(root);
    normalizeBlocks(root, mdoc, { paste: true, wrapTop: true, dropBrRuns: true, trimBr: true });
    tidyWhitespace(root);
    return serializeHtml(root);
  }

  /* ---- plain text in: paragraphs, and markdown when it looks like markdown */

  var MD_LINE = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|```|~~~)/;
  function looksMarkdown(text) {
    return String(text).split(/\r\n?|\n/).some(function (l) { return MD_LINE.test(l); });
  }

  function inlineMarkdown(s) {
    var codes = [];
    s = escapeText(s).replace(/`([^`\n]+)`/g, function (m, c) { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      return safeHref(decodeEntities(url)) ? '<a href="' + url.replace(/"/g, "&quot;") + '">' + label + "</a>" : m;
    });
    s = s.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, "<b>$1</b>").replace(/(^|[^\w])__(?=\S)([^_\n]+?)__(?!\w)/g, "$1<b>$2</b>");
    s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])?\*(?![\w*])/g, function (m, pre, body) {
      return body == null ? m : pre + "<i>" + body + "</i>";
    });
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*[^\s_])_(?!\w)/g, "$1<i>$2</i>");
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return "<code>" + codes[Number(i)] + "</code>"; });
  }

  /** Plain text → blocks: each line a paragraph; # headings, lists, quotes, fences, rules. */
  function plainToHtml(text) {
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var lists = []; // [{tag, indent}]
    var closeLists = function (indent) {
      while (lists.length && lists[lists.length - 1].indent > indent) out.push("</li></" + lists.pop().tag + ">");
    };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\t/g, "    ");
      var m;
      if (!line.trim()) continue;
      if ((m = /^\s*(```|~~~)/.exec(line))) {
        closeLists(-1);
        var code = [];
        for (i++; i < lines.length && lines[i].trim().indexOf(m[1]) !== 0; i++) code.push(lines[i]);
        out.push("<pre>" + escapeText(code.join("\n")) + "</pre>");
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeLists(-1); out.push("<hr>"); continue; }
      if ((m = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/.exec(line))) {
        var indent = m[1].length;
        var tag = m[3] != null ? "ol" : "ul";
        closeLists(indent);
        var topList = lists[lists.length - 1];
        if (topList && topList.indent === indent && topList.tag !== tag) { out.push("</li></" + lists.pop().tag + ">"); topList = lists[lists.length - 1]; }
        if (topList && topList.indent === indent) out.push("</li><li>");
        else {
          var start = tag === "ol" && Number(m[3]) > 1 ? ' start="' + Number(m[3]) + '"' : "";
          out.push("<" + tag + start + "><li>");
          lists.push({ tag: tag, indent: indent });
        }
        out.push(inlineMarkdown(m[4].replace(/^\[([ xX])\]\s+/, "[$1] ")));
        continue;
      }
      closeLists(-1);
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        var h = Math.min(m[1].length, 3);
        out.push("<h" + h + ">" + inlineMarkdown(m[2]) + "</h" + h + ">");
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        var quote = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quote.push(inlineMarkdown(lines[i].replace(/^\s{0,3}>\s?/, "")));
        i--;
        out.push("<blockquote>" + quote.join("<br>") + "</blockquote>");
        continue;
      }
      out.push("<p>" + inlineMarkdown(line.trim()) + "</p>");
    }
    closeLists(-1);
    return out.join("");
  }

  /**
   * What a paste inserts: {html} for blocks or formatting, {text} for a plain run that should
   * flow into the line where the caret is.
   */
  function pastePlan(html, text) {
    text = text == null ? "" : String(text);
    if (html && String(html).trim()) {
      var clean = sanitizeHtml(html);
      var marked = /<(h[1-6]|ul|ol|b|strong|i|em|a|code|pre|blockquote|img|table|hr)\b/i.test(clean);
      // Code editors put styled HTML next to the markdown source: the source is what's meant.
      if (!marked && text && looksMarkdown(text)) return { html: plainToHtml(text) };
      if (clean) {
        var one = /^<p>((?:(?!<\/?p>)[\s\S])*)<\/p>$/.exec(clean);
        if (one) return marked ? { html: one[1] } : { text: htmlToPlain(clean) };
        return { html: clean };
      }
      if (!text) return { text: "" };
    }
    if (looksMarkdown(text) || /\n/.test(text.trim())) return { html: plainToHtml(text) };
    return { text: text };
  }

  /* ---- copy out: readable text */

  /** HTML (a string or a tree) → plain text: blank lines between blocks, list markers kept. */
  function htmlToPlain(html) {
    var root = typeof html === "string" ? parseHtml(html) : html;
    var out = [];
    plainBlocks(root, out);
    var s = "";
    out.forEach(function (b, i) {
      if (i) s += b.tight && b.tight === out[i - 1].tight ? "\n" : "\n\n";
      s += b.text;
    });
    return s;
  }
  function inlinePlain(n) {
    if (n.nodeType === 3) return n.nodeValue.replace(/[ \t\n\r\f]+/g, " ");
    if (n.nodeType !== 1) return "";
    if (n.tagName === "BR") return "\n";
    if (n.tagName === "IMG") return n.getAttribute("alt") || "";
    if (DROP[n.tagName]) return "";
    return kids(n).map(inlinePlain).join("");
  }
  function plainBlocks(el, out) {
    var run = "";
    var flush = function () {
      var t = run.replace(/ /g, " ").replace(/ *\n */g, "\n").replace(/^ +| +$/g, "").replace(/^\n+|\n+$/g, "");
      if (!isBlank(t)) out.push({ text: t, tight: false });
      run = "";
    };
    kids(el).forEach(function (n) {
      var t = tagOf(n);
      if (n.nodeType === 1 && DROP[t]) return;
      if (t === "UL" || t === "OL") { flush(); listPlain(n, out); return; }
      if (t === "PRE") { flush(); out.push({ text: textOf(n).replace(/\n$/, ""), tight: false }); return; }
      if (t === "HR") { flush(); out.push({ text: "---", tight: false }); return; }
      if (t === "TABLE") {
        flush();
        var rows = elementsIn(n, function (c) { return c.tagName === "TR"; }).map(function (tr) {
          return kids(tr).filter(function (c) { return tagOf(c) === "TD" || tagOf(c) === "TH"; }).map(function (c) {
            return inlinePlain(c).replace(/\s+/g, " ").trim();
          }).join("\t");
        });
        if (rows.length) out.push({ text: rows.join("\n"), tight: false });
        return;
      }
      if (t === "BLOCKQUOTE") {
        flush();
        var sub = [];
        plainBlocks(n, sub);
        var q = htmlJoin(sub);
        if (q) out.push({ text: q.split("\n").map(function (l) { return "> " + l; }).join("\n"), tight: false });
        return;
      }
      if (n.nodeType === 1 && BLOCKS[t]) { flush(); plainBlocks(n, out); return; }
      run += inlinePlain(n);
    });
    flush();
  }
  function htmlJoin(blocks) {
    return blocks.map(function (b, i) { return (i ? (b.tight && b.tight === blocks[i - 1].tight ? "\n" : "\n\n") : "") + b.text; }).join("");
  }
  function listPlain(list, out) {
    var n = list.tagName === "OL" ? Number(list.getAttribute("start")) || 1 : 0;
    kids(list).forEach(function (li) {
      if (tagOf(li) !== "LI") return;
      var marker = list.tagName === "OL" ? n++ + ". " : "- ";
      var pad = marker.replace(/./g, " ");
      var sub = [];
      plainBlocks(li, sub);
      var lines = sub.map(function (b) { return b.text; }).join("\n").split("\n");
      out.push({ text: lines.map(function (l, i) { return i ? (l ? pad + l : l) : marker + l; }).join("\n").replace(/ +$/, ""), tight: list });
    });
  }

  // The page name a header's text gives: same rule as naming a page in the sidebar (core/html.mjs
  // headerName is this function's twin, for the file side).
  function headerName(text) {
    return String(text == null ? "" : text).replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim().replace(/\//g, "-");
  }
  // Leaving the page's header: does the page follow it? Only when the header said the page's name
  // before this edit and now says something else. Case counts.
  function shouldRenameFromHeader(nameBefore, headerBefore, headerAfter) {
    var before = headerName(headerBefore);
    var after = headerName(headerAfter);
    return !!after && after !== before && before === headerName(nameBefore);
  }

  if (typeof window === "undefined") {
    // Loaded by scripts/smoke-editor.mjs: hand over the pure helpers and stop.
    if (typeof globalThis !== "undefined") {
      globalThis.__quireEditor = {
        parseHtml: parseHtml, serializeHtml: serializeHtml, sanitizeHtml: sanitizeHtml, plainToHtml: plainToHtml, pastePlan: pastePlan,
        htmlToPlain: htmlToPlain, looksMarkdown: looksMarkdown,
        findIn: findIn,
        findEditorToken: findEditorToken, pageLinkHref: pageLinkHref, matchPageByName: matchPageByName,
        headerName: headerName, shouldRenameFromHeader: shouldRenameFromHeader,
        normalizeHtml: function (html, opts) {
          var root = parseHtml(html);
          normalizeBlocks(root, mdoc, opts || { dropEmpty: true, trimBr: true, wrapTop: true });
          return serializeHtml(root);
        },
      };
    }
    return;
  }
  if (window.quire) return;

  var TEXT_TAGS = ["P", "H1", "H2", "H3", "H4", "UL", "OL", "BLOCKQUOTE", "PRE", "TABLE", "HR", "FIGURE", "IMG"];
  var INVISIBLE_TAGS = ["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META", "NOSCRIPT", "BASE"];
  var READ_ONLY_MSG = "Page is read-only while it is being edited";
  var SAVE_DEBOUNCE = 400;

  var isFramed = window.parent !== window;
  // The iOS app (WKWebView): the page is the top frame and the app answers rpcs through the
  // `quire` script message handler, in every frame. There an embed is any framed page.
  var nativeHost = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.quire);
  // The renderer window: window.top in the app. Under the web host (docs/web-host.md) the
  // renderer can itself sit in someone else's iframe, so it's the nearest same-origin ancestor
  // that isn't a page (/v/...).
  var appWin = window.top;
  if (/^https?:$/.test(location.protocol) && location.pathname.indexOf("/v/") === 0) {
    try {
      var w = window.parent;
      while (w && w !== w.parent && w.location.pathname.indexOf("/v/") === 0) w = w.parent;
      if (w && w.location.origin === location.origin) appWin = w;
    } catch (e) { /* cross-origin above the renderer: stop there */ }
  }
  var isEmbedded = isFramed && (nativeHost || window.parent !== appWin);
  // The floating note names its page frame (renderer/src/Floating.jsx): compact headings there.
  if (isFramed && window.name === "q-floating") document.documentElement.classList.add("q-floating");
  // Windows (and Linux): <html class="q-os-pc">, so a page can show both spellings of a
  // shortcut and theme.css hides the other one: <span class="q-mac">⌘P</span><span class="q-pc">Ctrl+P</span>.
  // A class on <html> is never saved into the page's file.
  if (!/^Mac|^iP/.test(navigator.platform || "")) document.documentElement.classList.add("q-os-pc");
  var isTopPage = nativeHost ? !isFramed : isFramed && !isEmbedded;
  // A published page, opened in a normal browser: no Quire app around it, so the store and kv
  // live in this visitor's localStorage instead.
  var standalone = !isFramed && !nativeHost && location.protocol !== "quire:";
  // In the desktop app every page has its own origin, quire://p-<page id>/<page path>/ (one
  // site, so one renderer process, per page). The iOS app still serves quire://vault/.
  var ownOrigin = location.protocol === "quire:" && /^p-[a-z0-9]+$/.test(location.host);

  /* ------------------------------------------------------------------ storage migration */

  // Pages used to share the quire://vault origin, and so one localStorage. On a page's first
  // load on its own origin the app puts a copy of all the old keys in the head (they can't be
  // told apart by page); copy the ones this origin doesn't have yet, once, before any page
  // script runs. `quire:origin-migrated` marks it done. IndexedDB isn't migrated.
  var legacyTaken = false;
  if (ownOrigin) {
    var legacyEl = document.getElementById("q-legacy-storage");
    try {
      if (localStorage.getItem("quire:origin-migrated") == null) {
        if (legacyEl) {
          var legacyData = JSON.parse(legacyEl.textContent || "{}");
          Object.keys(legacyData).forEach(function (k) {
            if (localStorage.getItem(k) === null) localStorage.setItem(k, String(legacyData[k]));
          });
        }
        localStorage.setItem("quire:origin-migrated", String(Date.now()));
      }
      legacyTaken = !!legacyEl;
    } catch (e) { /* storage blocked or full: try again next load */ }
    if (legacyEl && legacyEl.parentNode) legacyEl.parentNode.removeChild(legacyEl);
  }

  /* ------------------------------------------------------------------ errors → the app */

  // Uncaught errors and unhandled rejections go to the app (App.jsx shows them as a top-bar
  // badge): at most 20 sends a minute per page, and a repeat of the same error only bumps its
  // count (sent at most once a second). Not in the iOS app, where window.top is a page, not the app.
  if (isFramed && !nativeHost && location.protocol === "quire:") {
    var ERR_PER_MINUTE = 20;
    var errBudget = { start: 0, sent: 0 };
    var errSeen = {};
    var sendError = function (e) {
      var now = Date.now();
      if (now - errBudget.start > 60000) {
        errBudget.start = now;
        errBudget.sent = 0;
      }
      if (errBudget.sent >= ERR_PER_MINUTE) return;
      errBudget.sent++;
      var out = { key: e.key, kind: e.kind, message: e.message, source: e.source, line: e.line, column: e.column, stack: e.stack, time: e.time, count: e.count };
      try { appWin.postMessage({ quire: 1, type: "page-error", page: pagePath(), error: out }, "*"); } catch (x) { /* gone */ }
    };
    var reportError = function (kind, message, source, line, column, stack) {
      message = String(message == null ? "Error" : message).slice(0, 2000);
      var key = kind + "|" + message + "|" + (source || "") + "|" + (line || 0) + "|" + (column || 0);
      var e = errSeen[key];
      if (e) {
        e.count++;
        e.time = Date.now();
        if (!e.timer) e.timer = setTimeout(function () { e.timer = null; sendError(e); }, 1000);
        return;
      }
      e = errSeen[key] = { key: key, kind: kind, message: message, source: source || "", line: line || 0, column: column || 0, stack: stack ? String(stack).slice(0, 8000) : "", time: Date.now(), count: 1, timer: null };
      sendError(e);
    };
    // "at fn (quire://vault/Page/app.js:12:5)" → [url, line, column] of the first frame.
    var firstFrame = function (stack) {
      var m = /((?:quire|https?|file|blob):\/\/[^\s)]+?):(\d+):(\d+)/.exec(String(stack || ""));
      return m ? [m[1], Number(m[2]), Number(m[3])] : ["", 0, 0];
    };
    window.addEventListener("error", function (ev) {
      var err = ev.error;
      reportError("error", ev.message || (err && err.message), ev.filename, ev.lineno, ev.colno, err && err.stack);
    });
    window.addEventListener("unhandledrejection", function (ev) {
      var r = ev.reason;
      var msg = r && typeof r === "object" && "message" in r ? (r.name && r.name !== "Error" ? r.name + ": " : "") + r.message : String(r);
      var at = firstFrame(r && r.stack);
      reportError("rejection", "Unhandled rejection: " + msg, at[0], at[1], at[2], r && r.stack);
    });
  }

  /* ------------------------------------------------------------------ page path */

  var cachedPath = null;
  function pagePath() {
    if (cachedPath !== null) return cachedPath;
    var meta = document.querySelector('meta[name="quire-page"]');
    if (meta) return (cachedPath = meta.getAttribute("content") || "");
    // Fallback until the meta is parsed: quire://vault/<page path>/[index.html]
    try {
      var segs = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (segs.length && /^index\.(html|md)$/i.test(segs[segs.length - 1])) segs.pop();
      return segs.join("/");
    } catch (e) {
      return "";
    }
  }

  // Relative refs resolve against the folder holding this page, like files: from
  // "Kyoto trip/Overview", "Trip budget" is "Kyoto trip/Trip budget". A leading "/" is the vault root.
  function resolvePagePath(src, base) {
    src = String(src || "").trim();
    var parts = [];
    if (src.charAt(0) !== "/") {
      parts = base == null ? pagePath().split("/").filter(Boolean).slice(0, -1) : base.split("/").filter(Boolean);
    }
    src.split("/").forEach(function (seg) {
      seg = seg.trim();
      if (!seg || seg === ".") return;
      if (seg === "..") { parts.pop(); return; }
      parts.push(seg);
    });
    return parts.join("/");
  }

  function pageUrl(path) {
    return "quire://vault/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/") + "/";
  }

  /* ------------------------------------------------------------------ /api → this page's backend */

  // A page with a backend (.noteblock "backend") reaches it at api/… relative to the page, and
  // at /api/…, which on quire://vault would otherwise mean the vault root. On a page's own
  // origin (quire://p-<id>/) the app sends /api/… to that page's backend itself.
  if (location.protocol === "quire:" && location.host === "vault") {
    var apiAbs = /^\/api(?=[\/?#]|$)/;
    var toPage = function (u) { return pageUrl(pagePath()) + u.slice(1); };
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      if (typeof input === "string" && apiAbs.test(input)) input = toPage(input);
      else if (input instanceof URL && input.protocol === "quire:" && input.host === "vault" && apiAbs.test(input.pathname)) input = toPage(input.pathname + input.search);
      else if (input instanceof Request) {
        var u = new URL(input.url);
        if (u.protocol === "quire:" && u.host === "vault" && apiAbs.test(u.pathname)) input = new Request(toPage(u.pathname + u.search), input);
      }
      return origFetch.call(this, input, init);
    };
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof url === "string" && apiAbs.test(url)) args[1] = toPage(url);
      return origOpen.apply(this, args);
    };
  }

  /* ------------------------------------------------------------------ rpc */

  var rpcSeq = 0;
  var rpcPrefix = Math.random().toString(36).slice(2, 8) + ":";
  var pending = new Map();

  // Opened in a browser from Quire (app/main/browser-server.mjs): no app around the page, so
  // rpcs go over HTTP to the local server named by the quire-rpc meta it injects.
  var rpcMeta = window.top === window && location.protocol === "http:" ? document.querySelector('meta[name="quire-rpc"]') : null;
  var httpRpcUrl = rpcMeta ? rpcMeta.getAttribute("content") : null;

  // iOS: post {id, method, params, page} to the app; it answers with __quireRpcReply.
  if (nativeHost) {
    window.__quireRpcReply = function (id, ok, value) {
      var p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(value);
      else p.reject(errorFrom(value));
    };
  }

  function rpc(method, params) {
    if (nativeHost) {
      return new Promise(function (resolve, reject) {
        var id = rpcPrefix + ++rpcSeq;
        pending.set(id, { resolve: resolve, reject: reject });
        var np = Object.assign({ page: pagePath() }, params || {});
        np.from = pagePath();
        try {
          window.webkit.messageHandlers.quire.postMessage({ id: id, method: method, params: np, page: pagePath() });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    }
    if (httpRpcUrl) {
      var hp = Object.assign({ page: pagePath() }, params || {});
      hp.from = pagePath();
      return fetch(httpRpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: pagePath(), method: method, params: hp }) })
        .then(function (r) { return r.json(); })
        .then(function (res) { if (res && "error" in res) throw new Error(res.error); return res ? res.ok : null; });
    }
    if (standalone) return localRpc(method, Object.assign({ page: pagePath() }, params || {}));
    return new Promise(function (resolve, reject) {
      var id = rpcPrefix + ++rpcSeq;
      pending.set(id, { resolve: resolve, reject: reject });
      var p = Object.assign({ page: pagePath() }, params || {});
      p.from = pagePath();
      try {
        appWin.postMessage({ quire: 1, type: "rpc", id: id, method: method, params: p }, "*");
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  /* ---- standalone (published) backend: localStorage, one key per table */

  function localKey(name) { return "quire:" + pagePath() + ":" + name; }
  function localRead(name) {
    try { return JSON.parse(localStorage.getItem(localKey(name)) || "null"); } catch (e) { return null; }
  }
  function localWrite(name, value) {
    try { localStorage.setItem(localKey(name), JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }
  function newLocalId() {
    var s = "";
    for (var i = 0; i < 10; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 36));
    return s;
  }
  function localRpc(method, p) {
    try {
      var rows = p.table != null ? localRead("t:" + p.table) || [] : null;
      var now = Date.now();
      var save = function () { localWrite("t:" + p.table, rows); };
      var find = function (id) { return rows.findIndex(function (r) { return r.id === id; }); };
      switch (method) {
        case "store.all": return Promise.resolve(rows);
        case "store.get": return Promise.resolve(rows[find(p.id)] || null);
        case "store.insert": {
          var obj = Object.assign({}, p.obj || {});
          var row = Object.assign(obj, { id: obj.id || newLocalId(), _created: now, _updated: now });
          rows.push(row);
          save();
          return Promise.resolve(row);
        }
        case "store.update": {
          var i = find(p.id);
          if (i < 0) return Promise.reject(new Error("No row " + p.id));
          rows[i] = Object.assign({}, rows[i], p.patch || {}, { id: rows[i].id, _created: rows[i]._created, _updated: now });
          save();
          return Promise.resolve(rows[i]);
        }
        case "store.remove": {
          var j = find(p.id);
          if (j >= 0) { rows.splice(j, 1); save(); }
          return Promise.resolve(true);
        }
        case "kv.get": {
          var v = localRead("kv:" + p.key);
          return Promise.resolve(v === undefined ? null : v);
        }
        case "kv.set": localWrite("kv:" + p.key, p.value === undefined ? null : p.value); return Promise.resolve(true);
        case "query": return Promise.resolve([]);
        case "pages": return Promise.resolve([]);
        case "navigate": return Promise.resolve(null);
        default: return Promise.reject(new Error("Not available on a published page: " + method));
      }
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function errorFrom(e) {
    if (e instanceof Error) return e;
    if (e && typeof e === "object" && e.message) return new Error(e.message);
    return new Error(String(e));
  }

  /* ------------------------------------------------------------------ store */

  var subscribers = new Map(); // table -> Set<cb>

  function fireTable(table) {
    var fire = function (set) {
      set.forEach(function (cb) {
        try { cb(); } catch (err) { console.error("[quire] subscriber failed", err); }
      });
    };
    if (table == null) subscribers.forEach(fire);
    else if (subscribers.has(table)) fire(subscribers.get(table));
  }

  function guardWrite() {
    return page.readOnly ? Promise.reject(new Error(READ_ONLY_MSG)) : null;
  }

  function write(table, method, params) {
    var blocked = guardWrite();
    if (blocked) return blocked;
    return rpc(method, Object.assign({ table: table }, params)).then(function (result) {
      fireTable(table);
      return result;
    });
  }

  function table(name) {
    name = String(name);
    return {
      all: function () { return rpc("store.all", { table: name }); },
      get: function (id) { return rpc("store.get", { table: name, id: id }); },
      insert: function (obj) { return write(name, "store.insert", { obj: obj, row: obj }); },
      update: function (id, patch) { return write(name, "store.update", { id: id, patch: patch }); },
      remove: function (id) { return write(name, "store.remove", { id: id }); },
      subscribe: function (cb) {
        if (typeof cb !== "function") throw new TypeError("subscribe(cb) needs a function");
        if (!subscribers.has(name)) subscribers.set(name, new Set());
        subscribers.get(name).add(cb);
        return function unsubscribe() {
          var set = subscribers.get(name);
          if (set) set.delete(cb);
        };
      },
    };
  }

  /* ------------------------------------------------------------------ window.quire */

  var page = {
    get path() { return pagePath(); },
    title: "",
    id: null,
    readOnly: false,
  };
  Object.defineProperty(page, "title", {
    enumerable: true,
    get: function () { return pageTitle || document.title || pagePath().split("/").pop() || ""; },
  });
  var pageTitle = "";

  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  var treeCache = null;

  function pages() {
    return rpc("pages", {}).then(function (tree) {
      treeCache = tree;
      return tree;
    });
  }

  function findNode(tree, path) {
    var stack = (tree || []).slice();
    while (stack.length) {
      var n = stack.shift();
      if (!n) continue;
      if (n.path === path) return n;
      if (n.children && n.children.length) stack = stack.concat(n.children);
    }
    return null;
  }

  function flatten(tree, out) {
    out = out || [];
    (tree || []).forEach(function (n) {
      out.push(n);
      flatten(n.children, out);
    });
    return out;
  }

  var quire = {
    page: page,
    store: { table: table },
    kv: {
      get: function (key) { return rpc("kv.get", { key: key }); },
      set: function (key, value) {
        var blocked = guardWrite();
        if (blocked) return blocked;
        return rpc("kv.set", { key: key, value: value });
      },
    },
    query: function (pagePathArg, tableName) {
      return rpc("query", { page: resolvePagePath(pagePathArg, ""), table: tableName });
    },
    // Read one file of another page (or this one, with pageRef "" or null), as text. Pages
    // have their own origins, so fetch("../Other page/x.json") is refused; this is the way.
    // `pageRef` is a vault path like quire.query's. Never data/, the manifest, dotfiles or the
    // backend folder. A published page can read only its own files.
    files: {
      read: function (pageRef, filePath) {
        var target = pageRef == null || pageRef === "" ? pagePath() : resolvePagePath(pageRef, "");
        if (standalone) {
          if (target !== pagePath()) return Promise.reject(new Error("files.read: " + target + " isn't published"));
          return fetch(String(filePath || "").replace(/^\/+/, "")).then(function (r) {
            if (!r.ok) throw new Error("files.read: no file " + filePath);
            return r.text();
          });
        }
        return rpc("files.read", { page: target, path: String(filePath || "") });
      },
    },
    pages: pages,
    navigate: function (target) {
      return rpc("navigate", { page: resolvePagePath(target, "") });
    },
    ready: ready,
  };
  Object.defineProperty(window, "quire", { value: quire, writable: false, configurable: false, enumerable: true });

  /* ------------------------------------------------------------------ messages */

  function embedFrames() {
    return Array.prototype.slice.call(document.querySelectorAll("iframe.q-embed-frame"));
  }

  function relayToEmbeds(msg) {
    embedFrames().forEach(function (f) {
      try { if (f.contentWindow) f.contentWindow.postMessage(msg, "*"); } catch (e) { /* gone */ }
    });
  }

  var pendingMode = null;
  var pendingAiChanged = null;
  var domReady = false;

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.quire !== 1) return;

    if (msg.type === "rpc-result") {
      if (event.source !== appWin) return;
      var p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error != null) p.reject(errorFrom(msg.error));
      else p.resolve(msg.result);
      return;
    }

    if (msg.type === "resize") {
      // From one of our embed iframes.
      var frame = embedFrames().find(function (f) { return f.contentWindow === event.source; });
      // An embed with a height of its own (dragged to size) keeps it; so does one mid-drag.
      if (frame && typeof msg.height === "number" && msg.height >= 0) {
        frame.__reportedHeight = Math.ceil(msg.height);
        if (!frame.__fixedHeight && !frame.__dragging) applyAutoHeight(frame);
      }
      return;
    }

    if (msg.type === "pong") {
      // From one of our embed iframes: it is alive.
      var pf = embedFrames().find(function (f) { return f.contentWindow === event.source; });
      if (pf) {
        pf.__lastPong = Date.now();
        if (pf.__stuck) hideEmbedStuck(pf);
      }
      return;
    }

    // An embed answering this runtime's find (find-count / find-shown).
    if (typeof msg.type === "string" && msg.type.indexOf("find-") === 0 && findReply(event, msg)) return;

    var fromAbove = event.source === window.parent || event.source === appWin;
    if (!fromAbove) return;

    if (msg.type === "find" || msg.type === "find-active" || msg.type === "find-selection" || msg.type === "find-clear") {
      onFindMessage(event, msg);
      return;
    }

    if (msg.type === "ping") {
      answerPing(event.source, msg);
      return;
    }

    if (msg.type === "mode") {
      relayToEmbeds(msg);
      if (domReady) applyMode(msg);
      else pendingMode = msg;
      return;
    }

    if (msg.type === "save") {
      if (editing && !page.readOnly) flushSave();
      return;
    }

    // The app swapping this page's frame for a freshly loaded one (usePageSwap.js).
    if (msg.type === "swap-state") {
      reply(event.source, msg, swapState());
      return;
    }
    if (msg.type === "scroll") {
      swapScroll(event.source, msg);
      return;
    }
    if (msg.type === "swap-caret") {
      restoreCaret(msg.caret);
      return;
    }
    if (msg.type === "swap-painted") {
      afterPaint(function () { reply(event.source, msg, {}); }, 300);
      return;
    }
    if (msg.type === "header-rename-result") {
      headerRenameDone(msg);
      return;
    }

    // Noteblock AI: a job's events, for whichever runtime holds that marker (an embedded page's
    // file can hold one too), and the blocks a job changed, for this page only.
    if (msg.type === "ai") {
      relayToEmbeds(msg);
      onAiEvent(msg.event);
      return;
    }

    if (msg.type === "ai-changed") {
      if (domReady) markAiChanged(msg.indexes);
      else pendingAiChanged = msg.indexes;
      return;
    }

    if (msg.type === "store-changed") {
      relayToEmbeds(msg);
      if (msg.page == null || msg.page === pagePath()) fireTable(msg.table == null ? null : msg.table);
      return;
    }
  });

  /* ------------------------------------------------------------------ frame swap */

  // When this page's files change the app loads a new frame underneath this one (usePageSwap.js).
  // The old frame says where it is scrolled to, whether typing is still unsaved, and whether the
  // page mustn't run twice; the new one takes the scroll and answers once it has painted there.
  function reply(to, msg, data) {
    data.quire = 1;
    data.type = msg.type + "-reply";
    data.seq = msg.seq;
    try { to.postMessage(data, "*"); } catch (e) { /* gone */ }
  }

  function scroller() { return document.scrollingElement || document.documentElement; }

  function runsHeavy() {
    if (document.pointerLockElement || document.querySelector("canvas, video, iframe")) return true;
    return Array.prototype.some.call(document.querySelectorAll("audio"), function (a) { return !a.paused; });
  }

  function swapState() {
    var se = scroller();
    return {
      y: se.scrollTop,
      height: se.scrollHeight,
      view: se.clientHeight,
      heavy: runsHeavy(),
      pending: !!(saveTimer || saving || dirtyWhileSaving),
      caret: caretState(),
    };
  }

  // Two animation frames on, or `ms` if there are none to be had (a hidden window).
  function afterPaint(fn, ms) {
    var done = false;
    function once() {
      if (done) return;
      done = true;
      fn();
    }
    setTimeout(once, ms);
    requestAnimationFrame(function () { requestAnimationFrame(once); });
  }

  // Exact y when the page is as tall as it was, the same fraction of the way down when it isn't.
  function swapScroll(to, msg) {
    var settled = false;
    function go() {
      if (settled) return;
      settled = true;
      var se = scroller();
      var y = Number(msg.y) || 0;
      var was = Number(msg.height) || 0;
      if (was && was !== se.scrollHeight) {
        var wasMax = was - (Number(msg.view) || se.clientHeight);
        y = wasMax > 0 ? (y / wasMax) * (se.scrollHeight - se.clientHeight) : 0;
      }
      window.scrollTo({ top: y, left: 0, behavior: "instant" });
      afterPaint(function () { reply(to, msg, { y: se.scrollTop, height: se.scrollHeight }); }, 120);
    }
    // Layout first: a font nothing has asked for yet isn't one fonts.ready waits for, and the page's
    // height changes when it arrives.
    void scroller().scrollHeight;
    setTimeout(go, 600);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go);
    else go();
  }

  // The caret as region, top-level node in it, and text offset in that node.
  function caretState() {
    var sel = window.getSelection && window.getSelection();
    var node = sel && sel.rangeCount ? sel.focusNode : null;
    if (!node) return null;
    var index = regions.findIndex(function (r) { return r.el !== node && r.el.contains(node); });
    if (index < 0) return null;
    var el = regions[index].el;
    var block = node;
    while (block.parentNode !== el) block = block.parentNode;
    var range = document.createRange();
    range.setStart(block, 0);
    range.setEnd(node, sel.focusOffset);
    return { region: index, block: Array.prototype.indexOf.call(el.childNodes, block), offset: range.toString().length };
  }

  function restoreCaret(c) {
    var region = c && regions[c.region];
    var block = region && region.el.childNodes[c.block];
    var sel = window.getSelection && window.getSelection();
    if (!block || !sel) return;
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var left = c.offset;
    var text = block.nodeType === 3 ? block : null;
    var last = text;
    if (!text) {
      while ((text = walker.nextNode())) {
        last = text;
        if (left <= text.length) break;
        left -= text.length;
      }
    }
    if (!text) { text = last; left = last ? last.length : 0; }
    region.el.focus({ preventScroll: true });
    if (text) sel.collapse(text, Math.min(left, text.length));
    else sel.collapse(block, 0);
  }

  /* ------------------------------------------------------------------ heartbeat */

  // The app pings the page frame every second and shows a "stopped responding" card when the
  // pongs stop (App.jsx, RecoveryOverlay.jsx). Each runtime passes the ping on to its embeds and
  // watches their pongs: an embed that goes quiet while this page keeps answering gets a card
  // in its own slot. Every page has its own origin and so its own process: a stuck embed of
  // another page stops only itself, and the page holding it keeps answering.
  var lastPingAt = 0;
  function answerPing(to, msg) {
    var mem = window.performance && performance.memory;
    var heap = mem && mem.jsHeapSizeLimit ? mem.usedJSHeapSize / mem.jsHeapSizeLimit : null;
    try { to.postMessage({ quire: 1, type: "pong", seq: msg.seq, page: pagePath(), heap: heap }, "*"); } catch (e) { /* gone */ }
    watchEmbeds(Number(msg.unresponsive) || 5);
    relayToEmbeds(msg);
  }

  function watchEmbeds(seconds) {
    var now = Date.now();
    var gap = lastPingAt ? now - lastPingAt : 0;
    lastPingAt = now;
    embedFrames().forEach(function (f) {
      // We were stuck ourselves (or hidden): start every embed's clock again.
      if (gap > 2500) {
        if (f.__lastPong) f.__lastPong = now;
        return;
      }
      if (!f.__lastPong || f.__stuck) return; // only embeds that have answered once
      if (now - f.__lastPong > seconds * 1000) showEmbedStuck(f);
    });
  }

  function showEmbedStuck(frame) {
    var embed = frame.parentNode;
    if (!embed) return;
    frame.__stuck = true;
    frame.style.display = "none";
    var card = document.createElement("div");
    card.className = "q-embed-stuck";
    card.setAttribute("data-q-ui", "");
    var text = document.createElement("span");
    text.textContent = (frame.getAttribute("title") || "This embed") + " stopped responding";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Reload";
    btn.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      var path = resolvePagePath(embed.getAttribute("src") || "");
      // The app ends the embed's hung process (never this page's), then a new load gets a new one.
      rpcEmbedKill(path).then(function () {
        frame.__lastPong = 0;
        frame.src = pageUrl(path) + "?reload=" + Date.now();
        hideEmbedStuck(frame);
      });
    });
    card.appendChild(text);
    card.appendChild(btn);
    embed.insertBefore(card, frame);
  }

  function hideEmbedStuck(frame) {
    frame.__stuck = false;
    frame.style.display = "";
    var card = frame.parentNode && frame.parentNode.querySelector(".q-embed-stuck");
    if (card) card.remove();
  }

  function rpcEmbedKill(path) {
    return new Promise(function (resolve) {
      try { appWin.postMessage({ quire: 1, type: "embed-kill", page: path, from: pagePath() }, "*"); } catch (e) { /* gone */ }
      setTimeout(resolve, 1200);
    });
  }

  /* ------------------------------------------------------------------ find in page */

  // ⌘F (renderer/src/FindBar.jsx) asks the top page frame; every runtime searches its own
  // document and asks its own embeds, so the count and the order follow the page, embeds
  // included, and never the app around it. Matches are CSS Custom Highlights (::highlight(q-find)
  // in theme.css): the document is never touched, so nothing of a search can be saved.
  // Messages (all `quire: 1`), parent → child, each answered to event.source with the same seq:
  //   {type:"find", seq, query, matchCase} → {type:"find-count", seq, count}
  //   {type:"find-active", seq, index} (-1 clears) → {type:"find-shown", seq, rect}
  //   {type:"find-selection", seq} → {type:"find-selection", seq, text}   (top page only)
  //   {type:"find-clear", restore} (no answer; restore puts focus and caret back)
  // and page → top {type:"find-escape"} when Esc is pressed in a page while a search is up.
  var FIND_SKIP = tagSet("SCRIPT STYLE TEMPLATE NOSCRIPT HEAD TITLE TEXTAREA INPUT SELECT OPTION SVG CANVAS VIDEO AUDIO OBJECT EMBED");
  var FIND_WAIT = 500;
  var findState = { items: [], total: 0, active: null, on: false, saved: null };
  var findReplies = [];

  /** The "/query" or "[[query" the caret is at the end of, or null. Pure. A "/" counts only at
   * the start of the text or after white space, so a/b and http://x never do. */
  function findEditorToken(text, caret) {
    var before = String(text).slice(0, caret == null ? String(text).length : caret);
    var clean = function (q) { return q.replace(/[\u200b\ufeff]/g, "").replace(/\u00a0/g, " "); };
    var fits = function (q) { return q.length <= 40 && !/\n/.test(q) && !/^[\s\u00a0]/.test(q); };
    var at = before.lastIndexOf("[[");
    if (at !== -1) {
      var name = before.slice(at + 2);
      if (fits(name) && !/[\[\]]/.test(name)) return { kind: "link", start: at, end: before.length, query: clean(name) };
    }
    at = before.lastIndexOf("/");
    if (at === -1 || (at > 0 && !/[\s\u00a0\u200b\ufeff]/.test(before.charAt(at - 1)))) return null;
    var q = before.slice(at + 1);
    return fits(q) ? { kind: "slash", start: at, end: before.length, query: clean(q) } : null;
  }

  /** A relative link from one page to another page's folder URL (docs/contract.md, Links). Pure.
   * A page is served at its own folder, so the way out starts from the page itself. */
  function pageLinkHref(from, target) {
    var a = String(from || "").split("/").filter(Boolean);
    var b = String(target || "").split("/").filter(Boolean);
    var common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    return "../".repeat(a.length - common) + b.slice(common).map(encodeURIComponent).join("/") + "/";
  }

  /** The page in a flattened tree called exactly `name` (title or vault path), or null. Pure.
   * Exact case first, then ignoring case. */
  function matchPageByName(nodes, name) {
    name = String(name || "").trim();
    if (!name) return null;
    var pageNodes = (nodes || []).filter(function (n) { return n && n.path && n.kind !== "folder" && n.kind !== "file"; });
    var called = function (n, same) {
      var title = n.title || n.path.split("/").pop();
      return same(title) || same(n.path);
    };
    var lower = name.toLowerCase();
    return pageNodes.filter(function (n) { return called(n, function (s) { return s === name; }); })[0] ||
      pageNodes.filter(function (n) { return called(n, function (s) { return s.toLowerCase() === lower; }); })[0] ||
      null;
  }

  function findSupported() { return typeof Highlight === "function" && window.CSS && CSS.highlights; }

  /** [start, end) of every match of query in text, non-overlapping, in order. Pure. */
  function findIn(text, query, matchCase) {
    var out = [];
    var q = String(query || "").replace(/\s+/g, " ");
    if (!q.trim()) return out;
    var hay = text;
    if (!matchCase) {
      var low = text.toLowerCase();
      // Lowercasing can change a string's length (İ): fold char by char then, keeping offsets.
      hay = low.length === text.length ? low : text.split("").map(function (c) { var l = c.toLowerCase(); return l.length === 1 ? l : c; }).join("");
      var ql = q.toLowerCase();
      q = ql.length === q.length ? ql : q.split("").map(function (c) { var l = c.toLowerCase(); return l.length === 1 ? l : c; }).join("");
    }
    var at = hay.indexOf(q);
    while (at !== -1) {
      out.push([at, at + q.length]);
      at = hay.indexOf(q, at + q.length);
    }
    return out;
  }

  function findBlockOf(node) {
    for (var el = node.parentElement; el && el !== document.body; el = el.parentElement) {
      if (BLOCKS[el.tagName]) return el;
    }
    return document.body;
  }

  /**
   * This document's matches in reading order: {range} for text here, {frame} for an embed
   * (searched by asking it). Text is read as it renders: hidden elements, editor UI and form
   * fields are skipped, runs of white space count as one space, and a match never spans blocks.
   */
  function collectFind(query, matchCase) {
    var items = [];
    if (!document.body) return items;
    var chars = [];
    var nodes = [];
    var offs = [];
    var lastBlock = null;
    function flush() {
      if (!chars.length) return;
      var text = chars.join("");
      findIn(text, query, matchCase).forEach(function (m) {
        var s = m[0];
        var e = m[1] - 1;
        while (s < e && !nodes[s]) s++;
        while (e > s && !nodes[e]) e--;
        if (!nodes[s] || !nodes[e]) return;
        var r = document.createRange();
        r.setStart(nodes[s], offs[s]);
        r.setEnd(nodes[e], offs[e] + 1);
        items.push({ range: r });
      });
      chars = [];
      nodes = [];
      offs = [];
    }
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        var tag = n.tagName;
        if (FIND_SKIP[tag] || n.hasAttribute("data-q-ui") || (n.classList && (n.classList.contains("q-ui") || n.classList.contains("q-embed-head") || n.classList.contains("q-embed-more")))) return NodeFilter.FILTER_REJECT;
        if (tag === "IFRAME") return NodeFilter.FILTER_ACCEPT;
        if (n.checkVisibility && !n.checkVisibility({ visibilityProperty: true })) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        // Only Quire's own embed frames answer; a page's other iframes are someone else's.
        flush();
        lastBlock = null;
        if (n.classList.contains("q-embed-frame") && !n.__stuck && n.contentWindow && (!n.checkVisibility || n.checkVisibility())) items.push({ frame: n });
        continue;
      }
      var v = n.nodeValue;
      if (!v) continue;
      var block = findBlockOf(n);
      if (block !== lastBlock) {
        if (chars.length) { chars.push("\n"); nodes.push(null); offs.push(0); }
        lastBlock = block;
      }
      for (var i = 0; i < v.length; i++) {
        var c = v.charAt(i);
        if (c === " " || /\s/.test(c)) {
          var prev = chars.length ? chars[chars.length - 1] : "\n";
          if (prev === " " || prev === "\n") continue;
          c = " ";
        }
        chars.push(c);
        nodes.push(n);
        offs.push(i);
      }
    }
    flush();
    return items;
  }

  /** Wait for one answer of `type`/`seq` from frame's window (null after FIND_WAIT). */
  function findAsk(frame, msg, type) {
    return new Promise(function (resolve) {
      var win = frame.contentWindow;
      if (!win) return resolve(null);
      var entry = { win: win, type: type, seq: msg.seq, resolve: resolve };
      findReplies.push(entry);
      var timer = setTimeout(function () { settle(null); }, FIND_WAIT);
      entry.resolve = settle;
      function settle(v) {
        clearTimeout(timer);
        var i = findReplies.indexOf(entry);
        if (i !== -1) findReplies.splice(i, 1);
        resolve(v);
      }
      try { win.postMessage(msg, "*"); } catch (e) { settle(null); }
    });
  }

  /** A child's answer to findAsk: true when it was one. */
  function findReply(event, msg) {
    for (var i = 0; i < findReplies.length; i++) {
      var r = findReplies[i];
      if (r.win === event.source && r.type === msg.type && r.seq === msg.seq) {
        r.resolve(msg);
        return true;
      }
    }
    return false;
  }

  function findPaint() {
    if (!findSupported()) return;
    var ranges = findState.items.filter(function (it) { return it.range; }).map(function (it) { return it.range; });
    if (ranges.length) {
      var all = new Highlight();
      ranges.forEach(function (r) { all.add(r); });
      CSS.highlights.set("q-find", all);
    } else CSS.highlights.delete("q-find");
    if (findState.active) {
      var h = new Highlight(findState.active);
      h.priority = 1;
      CSS.highlights.set("q-find-active", h);
    } else CSS.highlights.delete("q-find-active");
  }

  function runFind(msg) {
    var seq = msg.seq;
    var items = msg.query ? collectFind(String(msg.query), !!msg.matchCase) : [];
    findState.items = items;
    findState.active = null;
    findState.on = !!msg.query;
    findPaint();
    var asks = items.filter(function (it) { return it.frame; }).map(function (it) {
      return findAsk(it.frame, { quire: 1, type: "find", seq: seq, query: msg.query, matchCase: !!msg.matchCase }, "find-count").then(function (a) {
        it.count = a && typeof a.count === "number" ? a.count : 0;
      });
    });
    return Promise.all(asks).then(function () {
      var total = 0;
      items.forEach(function (it) { total += it.range ? 1 : it.count || 0; });
      findState.total = total;
      return total;
    });
  }

  /** rect (this viewport's coordinates) on screen, scrolling this document when it isn't. */
  function findReveal(rect, el) {
    var top = isTopPage ? 64 : 0; // the find bar sits over the top of the page
    var bottom = window.innerHeight - 24;
    if (rect.top >= top && rect.bottom <= bottom) return rect;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    return null;
  }

  function plainRect(r) {
    return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
  }

  function showFind(index, seq) {
    var at = 0;
    var target = null;
    var local = -1;
    for (var i = 0; i < findState.items.length && index >= 0; i++) {
      var it = findState.items[i];
      var n = it.range ? 1 : it.count || 0;
      if (!target && index < at + n) {
        target = it;
        local = index - at;
      }
      at += n;
    }
    // Every other embed drops its active match.
    findState.items.forEach(function (it) {
      if (it.frame && it !== target && it.count) {
        try { it.frame.contentWindow.postMessage({ quire: 1, type: "find-active", seq: seq, index: -1 }, "*"); } catch (e) { /* gone */ }
      }
    });
    if (!target) {
      findState.active = null;
      findPaint();
      return Promise.resolve(null);
    }
    if (target.range) {
      findState.active = target.range;
      findPaint();
      var r = target.range.getBoundingClientRect();
      var node = target.range.startContainer;
      var el = node.nodeType === 1 ? node : node.parentElement;
      if (!findReveal(r, el)) r = target.range.getBoundingClientRect();
      return Promise.resolve(plainRect(r));
    }
    findState.active = null;
    findPaint();
    return findAsk(target.frame, { quire: 1, type: "find-active", seq: seq, index: local }, "find-shown").then(function (a) {
      var rr = a && a.rect;
      function inFrame() {
        var fr = target.frame.getBoundingClientRect();
        var x = fr.left + target.frame.clientLeft;
        var y = fr.top + target.frame.clientTop;
        return rr ? { top: y + rr.top, bottom: y + rr.bottom, left: x + rr.left, right: x + rr.right } : { top: fr.top, bottom: Math.min(fr.bottom, fr.top + 40), left: fr.left, right: fr.right };
      }
      var rect = inFrame();
      if (!findReveal(rect, null)) {
        // Scroll by hand: the frame element itself may be far taller than the match.
        window.scrollBy({ top: (rect.top + rect.bottom) / 2 - window.innerHeight / 2, behavior: "instant" });
        rect = inFrame();
      }
      return rect;
    });
  }

  function clearFind(restore) {
    findState.items.forEach(function (it) {
      if (it.frame) {
        try { it.frame.contentWindow.postMessage({ quire: 1, type: "find-clear" }, "*"); } catch (e) { /* gone */ }
      }
    });
    findState.items = [];
    findState.active = null;
    findState.total = 0;
    findState.on = false;
    if (findSupported()) {
      CSS.highlights.delete("q-find");
      CSS.highlights.delete("q-find-active");
    }
    var saved = findState.saved;
    findState.saved = null;
    if (restore && saved) {
      // Back where the caret was when the bar opened, without jumping to it.
      try {
        if (saved.focus && saved.focus.isConnected && saved.focus.focus) saved.focus.focus({ preventScroll: true });
        var sel = window.getSelection();
        if (saved.range && saved.range.startContainer.isConnected) {
          sel.removeAllRanges();
          sel.addRange(saved.range);
        }
      } catch (e) { /* the page moved on */ }
    }
  }

  /** The bar opened: remember focus and caret, and hand over the selected text. */
  function findSelection() {
    var sel = window.getSelection();
    if (!findState.saved || document.hasFocus()) {
      findState.saved = {
        focus: document.activeElement && document.activeElement !== document.body ? document.activeElement : null,
        range: sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null,
      };
    }
    return sel ? String(sel.toString()) : "";
  }

  function onFindMessage(event, msg) {
    var to = event.source;
    function answer(m) {
      try { to.postMessage(m, "*"); } catch (e) { /* gone */ }
    }
    if (msg.type === "find") {
      runFind(msg).then(function (count) { answer({ quire: 1, type: "find-count", seq: msg.seq, count: count }); });
    } else if (msg.type === "find-active") {
      showFind(Number(msg.index), msg.seq).then(function (rect) { answer({ quire: 1, type: "find-shown", seq: msg.seq, rect: rect }); });
    } else if (msg.type === "find-selection") {
      answer({ quire: 1, type: "find-selection", seq: msg.seq, text: findSelection() });
    } else if (msg.type === "find-clear") {
      clearFind(!!msg.restore);
    }
  }

  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !findState.on || e.defaultPrevented) return;
    try { appWin.postMessage({ quire: 1, type: "find-escape" }, "*"); } catch (x) { /* gone */ }
  });

  /* ------------------------------------------------------------------ mode */

  var editing = false;
  var focusedOnce = false;
  var modeSeen = false;

  function applyMode(msg) {
    modeSeen = true;
    if (isEmbedded) {
      // Embeds are never editable; read-only only when their own page is locked.
      if (msg.page != null && msg.page === pagePath()) {
        setReadOnly(!!msg.readOnly);
      } else {
        pages().then(function (tree) {
          var node = findNode(tree, pagePath());
          setReadOnly(!!(node && node.lock));
        }, function () {});
      }
      setEditing(false);
      return;
    }
    manualSave = !!msg.manualSave;
    setReadOnly(!!msg.readOnly);
    setEditing(!!msg.edit && !msg.readOnly && isTopPage);
  }

  function setReadOnly(ro) {
    page.readOnly = ro;
    document.documentElement.classList.toggle("q-readonly", ro);
  }

  /* ------------------------------------------------------------------ embeds */

  function hydrateEmbed(el) {
    if (el.__quireEmbed) return;
    el.__quireEmbed = true;
    var src = el.getAttribute("src") || "";
    var path = resolvePagePath(src);
    el.classList.add("q-embed");
    el.setAttribute("contenteditable", "false");
    el.textContent = "";

    var head = document.createElement("div");
    head.className = "q-embed-head";
    var title = document.createElement("span");
    title.className = "q-embed-title";
    title.textContent = path.split("/").pop() || src;
    var open = document.createElement("a");
    open.className = "q-embed-open";
    open.href = "#";
    open.textContent = "Open";
    open.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      quire.navigate("/" + path);
    });
    open.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    head.appendChild(title);
    head.appendChild(open);
    el.appendChild(head);

    if (!path || standalone) {
      if (standalone) open.remove();
      var missing = document.createElement("div");
      missing.className = "q-embed-missing";
      missing.textContent = standalone ? "This embedded page isn't published." : "No page to embed";
      el.appendChild(missing);
      return;
    }
    var frame = document.createElement("iframe");
    frame.className = "q-embed-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-pointer-lock");
    // `*`: the src is quire://vault/…, which redirects to the page's own origin, so the default
    // (src-origin) allowlist would not reach the embedded page.
    frame.setAttribute("allow", "fullscreen *; autoplay *");
    frame.setAttribute("title", title.textContent);
    if (embedHeight(el)) fixFrameHeight(frame, embedHeight(el));
    frame.src = pageUrl(path);
    el.appendChild(frame);
    wireEmbedEditing(el, head, frame);

    ready.then(function () {
      var node = findNode(treeCache, path);
      if (node && node.title) {
        title.textContent = node.title;
        frame.setAttribute("title", node.title);
      }
      // The embedded page's own .noteblock can say how tall it is when embedded.
      if (node && node.embedHeight && !embedHeight(el)) fixFrameHeight(frame, node.embedHeight);
    });
  }

  function fixFrameHeight(frame, h) {
    frame.__fixedHeight = h || 0;
    if (h) {
      frame.style.height = h + "px";
      setEmbedCapped(frame, false);
    } else if (frame.__reportedHeight != null) {
      applyAutoHeight(frame);
    }
  }

  /* Auto-sized embeds stop at min(70vh, 900px) and scroll inside; explicit heights win. */
  var EMBED_CAP_PX = 900;
  function embedCap() {
    // A nested embed's viewport is its own auto-sized frame, so vh means nothing there.
    if (isEmbedded) return EMBED_CAP_PX;
    return Math.max(EMBED_MIN, Math.min(Math.round(window.innerHeight * 0.7), EMBED_CAP_PX));
  }

  function applyAutoHeight(frame) {
    var h = frame.__reportedHeight;
    if (h == null) return;
    var cap = embedCap();
    frame.style.height = Math.min(h, cap) + "px";
    setEmbedCapped(frame, h > cap);
  }

  function setEmbedCapped(frame, on) {
    var embed = frame.parentNode;
    if (!embed || !embed.classList) return;
    embed.classList.toggle("q-embed-capped", !!on);
    var more = embed.querySelector(".q-embed-more");
    if (on && !more) {
      more = document.createElement("a");
      more.className = "q-embed-more";
      more.href = "#";
      more.textContent = "Open";
      more.title = "Open the full page";
      more.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        quire.navigate("/" + resolvePagePath(embed.getAttribute("src") || ""));
      });
      more.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      embed.appendChild(more);
    }
  }

  window.addEventListener("resize", function () {
    embedFrames().forEach(function (f) { if (!f.__fixedHeight && !f.__dragging) applyAutoHeight(f); });
  });

  /** A `height` attribute written on this one embed (by hand), or 0. */
  function embedHeight(embed) {
    var h = embed && embed.getAttribute ? Number(embed.getAttribute("height")) : 0;
    return h > 0 ? h : 0;
  }

  /* ---- selecting, resizing and deleting embeds (edit mode only) */

  var selectedEmbed = null;
  var EMBED_MIN = 80;
  var EMBED_MAX = 2000;

  function canEditEmbeds() { return editing && !page.readOnly; }

  function selectEmbed(embed) {
    if (selectedEmbed === embed) return;
    if (selectedEmbed) selectedEmbed.classList.remove("q-embed-selected");
    selectedEmbed = embed;
    if (embed) {
      aiSelect(null);
      embed.classList.add("q-embed-selected");
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      hideToolbar();
    }
  }

  /**
   * An embed that sits at the top level of the file isn't part of any text region, so a
   * change to it wouldn't be saved. Give it a region of its own (holding just it).
   */
  function adoptEmbed(embed) {
    if (embed.parentNode !== document.body || qi(embed) === null) return;
    var r = document.createElement("div");
    r.setAttribute("data-q-region", "");
    document.body.insertBefore(r, embed);
    r.appendChild(embed);
    embed.removeAttribute("data-q-atomic");
    regions.push({ el: r, replace: [qi(embed)] });
    syncHistory();
  }

  function deleteEmbed(embed) {
    if (!canEditEmbeds()) return;
    adoptEmbed(embed);
    if (selectedEmbed === embed) selectEmbed(null);
    mutate(function () {
      var region = regionOf(embed);
      embed.remove();
      // An adopted region left empty saves as "remove this element"; hide it.
      if (region && !region.textContent.trim() && !region.querySelector("img,hr,quire-embed,iframe")) region.style.display = "none";
    });
  }

  /**
   * Dragged sizes are kept in the embedded page's .noteblock (`embed.height`), so they last in
   * markdown pages too and apply wherever that page is embedded. A hand-written `height`
   * attribute on one embed still wins for that embed.
   */
  function setEmbedHeight(embed, h, frame) {
    var target = resolvePagePath(embed.getAttribute("src") || "");
    h = h ? Math.round(h) : 0;
    if (embed.hasAttribute("height")) {
      adoptEmbed(embed);
      if (h) embed.setAttribute("height", String(h));
      else embed.removeAttribute("height");
      scheduleSave();
    } else {
      rpc("embed.setHeight", { page: target, height: h }).catch(function (err) {
        console.error("[quire] could not save embed height:", err && err.message ? err.message : err);
      });
    }
    var node = findNode(treeCache, target);
    if (node) node.embedHeight = h || null;
    fixFrameHeight(frame, h);
    // Back to auto: the embedded page reports its height again once it reloads.
    if (!h) { try { frame.contentWindow.location.reload(); } catch (e) { /* gone */ } }
  }

  function wireEmbedEditing(embed, head, frame) {
    head.addEventListener("mousedown", function (e) {
      if (!canEditEmbeds() || e.button !== 0) return;
      e.preventDefault();
      selectEmbed(embed);
    });

    var grip = document.createElement("div");
    grip.className = "q-embed-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.title = "Drag to resize, double-click for automatic height";
    embed.appendChild(grip);
    grip.addEventListener("pointerdown", function (e) {
      if (!canEditEmbeds() || e.button !== 0 || frame.__dragging) return;
      e.preventDefault();
      e.stopPropagation();
      selectEmbed(embed);
      var id = e.pointerId;
      var startY = e.clientY;
      var startH = frame.getBoundingClientRect().height;
      var h = startH;
      // Heights the page reports mid-drag are ignored, so the frame doesn't jump.
      frame.__dragging = true;
      setEmbedCapped(frame, false);
      // Captured, the grip keeps getting moves (and the up) even outside the window.
      try { grip.setPointerCapture(id); } catch (err) { /* no capture */ }
      // Frames would swallow pointermove while the pointer is over them.
      document.documentElement.classList.add("q-resizing");
      var move = function (ev) {
        if (ev.pointerId !== id) return;
        h = Math.min(EMBED_MAX, Math.max(EMBED_MIN, Math.round(startH + ev.clientY - startY)));
        frame.style.height = h + "px";
      };
      var done = false;
      var up = function (ev) {
        if (done || (ev && ev.pointerId != null && ev.pointerId !== id)) return;
        done = true;
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        grip.removeEventListener("lostpointercapture", up);
        window.removeEventListener("blur", up);
        try { if (grip.hasPointerCapture(id)) grip.releasePointerCapture(id); } catch (err) { /* gone */ }
        document.documentElement.classList.remove("q-resizing");
        frame.__dragging = false;
        setEmbedHeight(embed, h, frame);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
      grip.addEventListener("lostpointercapture", up);
      window.addEventListener("blur", up);
    });
    grip.addEventListener("dblclick", function (e) {
      if (!canEditEmbeds()) return;
      e.preventDefault();
      setEmbedHeight(embed, 0, frame);
    });

    embed.addEventListener("contextmenu", function (e) {
      var target = function () { return resolvePagePath(embed.getAttribute("src") || ""); };
      // Inspect: a DevTools window for just this embed (app/main/page-devtools.mjs).
      var inspect = { label: "Inspect", run: function () { rpc("devtools.inspectEmbed", { page: target() }).catch(function () {}); } };
      if (!canEditEmbeds()) {
        if (standalone) return;
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [{ label: "Open page", run: function () { quire.navigate("/" + target()); } }, inspect]);
        return;
      }
      e.preventDefault();
      selectEmbed(embed);
      var items = [{ label: "Open page", run: function () { quire.navigate("/" + target()); } }];
      if (embedHeight(embed) || frame.__fixedHeight) items.push({ label: "Automatic height", run: function () { setEmbedHeight(embed, 0, frame); } });
      items.push(inspect);
      items.push({ label: "Delete", danger: true, run: function () { deleteEmbed(embed); } });
      showMenu(e.clientX, e.clientY, items);
    });
  }

  var menuEl = null;
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }
  /** A small menu at (x, y): items = [{label, run, danger?}]. */
  function showMenu(x, y, items) {
    closeMenu();
    menuEl = document.createElement("div");
    menuEl.setAttribute("data-q-ui", "");
    menuEl.className = "q-ui q-menu";
    menuEl.setAttribute("role", "menu");
    items.forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.className = "q-menu-item" + (it.danger ? " is-danger" : "");
      b.textContent = it.label;
      b.addEventListener("mousedown", function (e) { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener("click", function () { closeMenu(); it.run(); });
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    var r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
    menuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
  }

  document.addEventListener("mousedown", function (e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    if (selectedEmbed && !selectedEmbed.contains(e.target)) selectEmbed(null);
  }, true);
  /* ---- keys typed into the page's own text, in the editor */

  // In edit mode a key pressed in text Quire made editable belongs to the editor, not the page:
  // a page-wide shortcut (a game's F for full screen, Space to jump) must not fire while someone
  // types a paragraph. This capture listener on window is added before any page script runs, so
  // it sees the event first; it runs the editor's own keydown handlers itself and stops the event
  // there. Escape always reaches the page, and so does every key in the page's own inputs, its own
  // contenteditable and anything its code drew. Rendered view is untouched. See docs/contract.md.
  var editorKeydown = [];
  function runEditorKeydown(e) {
    if (e.__qEditorRan) return;
    e.__qEditorRan = true;
    for (var i = 0; i < editorKeydown.length && !e.__qHandled; i++) editorKeydown[i](e);
  }
  function typingInPageText(e) {
    if (!editing || e.key === "Escape") return false;
    var t = e.target;
    if (!t || t.nodeType !== 1 || !t.closest) return false;
    var r = t.closest("[data-q-region]");
    return !!r && r.getAttribute("contenteditable") === "true" && !t.closest("[data-q-made],[data-q-ui],input,textarea,select");
  }
  ["keydown", "keypress", "keyup"].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!typingInPageText(e)) return;
      if (type === "keydown") runEditorKeydown(e);
      lastAct = Date.now(); // what noteAct would have done; it never sees this event
      e.stopImmediatePropagation();
    }, true);
  });
  document.addEventListener("keydown", runEditorKeydown, true);

  editorKeydown.push(function (e) {
    if (menuEl && e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
    if (!selectedEmbed || !canEditEmbeds()) return;
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      deleteEmbed(selectedEmbed);
    } else if (e.key === "Escape") {
      e.preventDefault();
      selectEmbed(null);
    }
  });
  window.addEventListener("blur", closeMenu);

  function hydrateEmbeds(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll("quire-embed"), hydrateEmbed);
  }

  /* ------------------------------------------------------------------ links */

  // Clicking a link follows it, in the editor too (a click that ends a text selection doesn't).
  // Web and mail links open in the browser. A link into the vault (any quire:// URL but the
  // runtime: another page, a page's file, or a plain file in a folder; the path after the host
  // is always the vault path) opens it in Quire instead of inside this frame. In-page anchors
  // (#…) keep their default.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || e.defaultPrevented || e.button !== 0) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;
    if (a.isContentEditable) {
      var sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed) return;
    }
    var url;
    try { url = new URL(href, location.href); } catch (err) { return; }
    if (url.protocol === "quire:" && url.host !== "runtime") {
      var segs;
      try { segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch (err) { return; }
      var target = segs.join("/");
      if (!target || target === pagePath()) return;
      e.preventDefault();
      quire.navigate("/" + target);
      return;
    }
    if (/^(https?|mailto|tel):$/.test(url.protocol)) {
      e.preventDefault();
      // The app catches a frame leaving for the web and hands the link to the browser.
      location.assign(url.href);
    }
  }, true);

  /* ------------------------------------------------------------------ auto height (embedded) */

  function startResizeReporting() {
    if (!isEmbedded || typeof ResizeObserver === "undefined") return;
    document.documentElement.classList.add("q-embedded");
    var last = -1;
    var post = function () {
      var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (h === last) return;
      last = h;
      try { window.parent.postMessage({ quire: 1, type: "resize", height: h }, "*"); } catch (e) { /* gone */ }
    };
    var ro = new ResizeObserver(post);
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
    window.addEventListener("load", post);
    post();
  }

  /* ------------------------------------------------------------------ edit mode: regions */

  var isMarkdown = false;
  var regions = []; // [{el, replace: number[]}]
  var saveTimer = null;
  var saving = false;
  var dirtyWhileSaving = false;

  function isUi(el) { return el.nodeType === 1 && el.hasAttribute("data-q-ui"); }
  function isTextBlock(el) {
    return TEXT_TAGS.indexOf(el.tagName) !== -1 && !el.hasAttribute("data-app");
  }
  function qi(el) {
    var v = el.getAttribute && el.getAttribute("data-q-i");
    return v == null || v === "" ? null : Number(v);
  }

  function buildRegions() {
    if (regions.length || !document.body) return;
    var body = document.body;
    var kids = Array.prototype.slice.call(body.children).filter(function (el) { return !isUi(el); });
    var run = null;
    var hasVisible = false;
    var editableText = 0;

    kids.forEach(function (el) {
      if (qi(el) === null && el.tagName === "P" && !el.attributes.length && !el.firstChild) {
        // A stray </p> in the file: the browser makes an empty <p> the server never indexed.
        // As a script-made block it would split the text around it into two regions the caret
        // can't cross, so it goes, and the text on both sides stays one region.
        el.remove();
        return;
      }
      if (qi(el) === null) {
        // Added at runtime (not in the file): leave it alone and never serialize it.
        run = null;
        if (INVISIBLE_TAGS.indexOf(el.tagName) === -1) markMade(el, "");
        return;
      }
      if (el.__qBase == null) el.__qBase = normHtml(el); // saved in its place if a script redraws it later
      if (isTextBlock(el) && !scriptTouched(el)) {
        hasVisible = true;
        editableText++;
        if (!run) {
          var r = document.createElement("div");
          r.setAttribute("data-q-region", "");
          body.insertBefore(r, el);
          run = { el: r, replace: [] };
          regions.push(run);
        }
        run.replace.push(qi(el));
        run.el.appendChild(el);
      } else {
        run = null;
        if (INVISIBLE_TAGS.indexOf(el.tagName) === -1) {
          el.setAttribute("data-q-atomic", "");
          hasVisible = true;
          if (scriptTouched(el)) markMade(el, srcBlocks[qi(el)]);
        }
      }
    });

    if (!hasVisible) {
      var empty = document.createElement("div");
      empty.setAttribute("data-q-region", "");
      empty.innerHTML = "<p><br></p>";
      var first = Array.prototype.find.call(body.children, function (el) { return !isUi(el); }) || null;
      body.insertBefore(empty, first);
      regions.push({ el: empty, replace: [] });
    }
    drawnByCode = !editableText && !!document.querySelector("[data-q-made]");
  }

  function regionOf(node) {
    while (node && node !== document.body) {
      if (node.nodeType === 1 && node.hasAttribute("data-q-region")) return node;
      node = node.parentNode;
    }
    return null;
  }

  /* ------------------------------------------------------------------ edit mode: script-made content */

  // The editor edits only what is in the file. Anything the page's own code drew (a React
  // root, a list filled from an API, an error message shown later) is marked data-q-made:
  // not editable, and saved as the file had it, since the next render would wipe an edit.
  var srcBlocks = null; // data-q-i -> normalized outerHTML of that block in the served file
  var srcLoad = null;
  var wantEdit = false;
  var madeSrc = {};
  var madeSeq = 0;
  var drawnByCode = false;
  var noticeDismissed = false;
  var noticeTimer = null;
  var madeObs = null;
  var madeWired = false;
  var lastAct = 0;
  var USER_ACT_MS = 300;

  function loadSource() {
    if (srcLoad) return srcLoad;
    srcLoad = fetch(location.href).then(function (r) { return r.ok ? r.text() : null; }).then(function (text) {
      var map = {};
      if (text != null) {
        var doc = new DOMParser().parseFromString(text, "text/html");
        Array.prototype.forEach.call(doc.body ? doc.body.children : [], function (el) {
          var i = qi(el);
          if (i !== null) map[i] = normHtml(el);
        });
        map.known = true;
      }
      srcBlocks = map;
    }, function () { srcBlocks = {}; });
    return srcLoad;
  }

  // outerHTML minus the editor's own marks, comparable between the live DOM and the file.
  function normHtml(node) {
    var w = node.ownerDocument.createElement("div");
    w.appendChild(node.cloneNode(true));
    cleanTree(w);
    Array.prototype.forEach.call(w.querySelectorAll("quire-embed"), function (e) {
      Array.prototype.slice.call(e.attributes).forEach(function (a) { if (a.name !== "src") e.removeAttribute(a.name); });
    });
    return w.innerHTML;
  }

  // A file block whose live DOM no longer matches the file: a script rendered into it.
  function scriptTouched(el) {
    if (!srcBlocks || !srcBlocks.known || el.tagName === "QUIRE-EMBED") return false;
    var src = srcBlocks[qi(el)];
    return src == null || normHtml(el) !== src;
  }

  // src: what to save in its place ("" = nothing; it was never in the file).
  function markMade(el, src) {
    if (el.hasAttribute("data-q-made")) return;
    var id = String(++madeSeq);
    madeSrc[id] = src || "";
    el.setAttribute("data-q-made", id);
    el.setAttribute("data-q-atomic", "");
    el.setAttribute("contenteditable", "false");
  }

  function restoreMade(root) {
    Array.prototype.slice.call(root.querySelectorAll("[data-q-made]")).forEach(function (n) {
      if (!n.parentNode || !root.contains(n)) return;
      var t = document.createElement("template");
      t.innerHTML = madeSrc[n.getAttribute("data-q-made")] || "";
      n.parentNode.replaceChild(t.content, n);
    });
  }

  function noteAct() { lastAct = Date.now(); }

  // The block a mutation belongs to: a child of a region, or of <body>.
  function blockOf(node) {
    while (node && node.parentNode && node.parentNode !== document.body && !(node.parentNode.hasAttribute && node.parentNode.hasAttribute("data-q-region"))) {
      node = node.parentNode;
    }
    return node && node.nodeType === 1 && node.parentNode ? node : null;
  }

  function onMutations(records) {
    // Typing, toolbar, paste and the editor's own commands all follow a user event.
    if (!editing || Date.now() - lastAct < USER_ACT_MS) return;
    // So does an async insert at the caret (an uploaded image, say).
    var sel = window.getSelection();
    var at = sel && sel.rangeCount ? sel.anchorNode : null;
    records.forEach(function (r) {
      var t = r.target.nodeType === 1 ? r.target : r.target.parentNode;
      if (!t || !t.closest || t.closest("[data-q-ui],quire-embed,[data-q-made],[data-q-ai]")) return;
      if (t === document.body || t.hasAttribute("data-q-region")) {
        Array.prototype.forEach.call(r.addedNodes, function (n) {
          if (at && n.contains(at)) return;
          if (n.nodeType === 1 && !isUi(n) && !n.hasAttribute("data-q-region") && !n.hasAttribute("data-q-ai") && n.tagName !== "QUIRE-EMBED" && INVISIBLE_TAGS.indexOf(n.tagName) === -1) markMade(n, "");
        });
        return;
      }
      var b = blockOf(t);
      if (!b || isUi(b) || b.hasAttribute("data-q-region") || (at && b.contains(at))) return;
      markMade(b, b.__qBase || "");
    });
  }

  function watchMade(on) {
    if (!on) {
      if (madeObs) { madeObs.disconnect(); madeObs = null; }
      var n = document.querySelector(".q-made-notice");
      if (n) n.hidden = true;
      return;
    }
    if (!madeWired) {
      madeWired = true;
      ["keydown", "beforeinput", "input", "paste", "cut", "drop", "pointerdown", "mousedown", "click", "compositionend"].forEach(function (t) {
        window.addEventListener(t, noteAct, true);
      });
      window.addEventListener("keydown", onMadeKey, true);
    }
    if (!madeObs && document.body) {
      madeObs = new MutationObserver(onMutations);
      madeObs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  // Typing where the editor can't put it (the caret is in code-made content, or nowhere
  // editable at all) gets a short note at the top; entering edit mode alone shows nothing.
  function onMadeKey(e) {
    if (!editing || noticeDismissed || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== "Backspace" && e.key !== "Delete" && e.key !== "Enter") return;
    var t = e.target;
    if (t && t.closest && t.closest("input,textarea,select,[data-q-ui]")) return;
    var sel = window.getSelection();
    var at = sel && sel.rangeCount ? sel.anchorNode : null;
    if (at && at.nodeType !== 1) at = at.parentNode;
    if (at && at.closest && at.closest('[contenteditable="true"]') && !at.closest("[data-q-made]")) return;
    if (!drawnByCode && !(at && at.closest && at.closest("[data-q-made]"))) return;
    showMadeNotice();
  }

  /* ------------------------------------------------------------------ edit mode: dropped + resized images */

  // An image file dragged in from Finder lands where it's dropped: main copies it into the
  // page's images/ folder (files.addImage) and the editor puts it in its own paragraph next
  // to the block under the pointer. A clicked image gets a corner handle that sets its width.
  var IMG_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|heic)$/i;
  var dropMark = null;
  var imgBox = null; // {img, box}

  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, "Files") !== -1;
  }
  // The top-level block under the pointer and whether the drop goes before it.
  function dropSpot(e) {
    var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    var node = r ? r.startContainer : e.target;
    if (!regionOf(node)) {
      var t = e.target && e.target.closest && e.target.closest("[data-q-region] > *");
      node = t || null;
    }
    var block = node && regionOf(node) ? blockOf(node) : null;
    if (!block || isUi(block) || block.hasAttribute("data-q-region")) return null;
    var rect = block.getBoundingClientRect();
    return { block: block, before: e.clientY < rect.top + rect.height / 2, rect: rect };
  }
  function showDropMark(spot) {
    if (!spot) { if (dropMark) dropMark.hidden = true; return; }
    if (!dropMark) {
      dropMark = el("div", { "data-q-ui": "", class: "q-ui q-drop-mark", "aria-hidden": "true" });
      document.body.appendChild(dropMark);
    }
    var y = (spot.before ? spot.rect.top : spot.rect.bottom) + window.scrollY;
    dropMark.style.top = y - 1 + "px";
    dropMark.style.left = spot.rect.left + window.scrollX + "px";
    dropMark.style.width = spot.rect.width + "px";
    dropMark.hidden = false;
  }
  function onDragOverFiles(e) {
    if (!editing || !hasFiles(e)) return;
    e.preventDefault();
    var spot = page.readOnly ? null : dropSpot(e);
    e.dataTransfer.dropEffect = spot ? "copy" : "none";
    showDropMark(spot);
  }
  function onDragLeaveFiles(e) {
    if (!e.relatedTarget) showDropMark(null);
  }
  function readDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || "")); };
      fr.onerror = function () { reject(fr.error || new Error("Couldn't read " + file.name)); };
      fr.readAsDataURL(file);
    });
  }
  function onDropFiles(e) {
    if (!editing || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    var spot = dropSpot(e);
    showDropMark(null);
    if (page.readOnly || !spot) return;
    var files = Array.prototype.filter.call(e.dataTransfer.files || [], function (f) { return /^image\//.test(f.type) || IMG_FILE.test(f.name); });
    if (!files.length) return;
    var added = [];
    files.reduce(function (chain, f) {
      return chain.then(function () {
        return readDataUrl(f).then(function (data) {
          return rpc("files.addImage", { name: f.name, data: data });
        }).then(function (src) { added.push({ src: src, alt: f.name.replace(/\.[^.]+$/, "") }); }, function (err) {
          showImageError(err);
        });
      });
    }, Promise.resolve()).then(function () {
      if (!added.length || !spot.block.isConnected) return;
      mutate(function () {
        var region = regionOf(spot.block);
        var emptyP = spot.block.tagName === "P" && !spot.block.textContent.trim() && !spot.block.querySelector("img");
        var ref = spot.before ? spot.block : spot.block.nextSibling;
        var last = null;
        added.forEach(function (a) {
          var img = document.createElement("img");
          img.setAttribute("src", a.src);
          img.setAttribute("alt", "");
          var p = document.createElement("p");
          p.appendChild(img);
          region.insertBefore(p, ref);
          last = p;
        });
        if (emptyP) spot.block.remove();
        if (last) {
          var sel = window.getSelection();
          var r = document.createRange();
          r.setStartAfter(last.lastChild);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      });
      updatePlaceholder();
    });
  }
  var imgErrTimer = null;
  function showImageError(err) {
    var n = document.querySelector(".q-img-error");
    if (!n) {
      n = el("div", { "data-q-ui": "", class: "q-ui q-made-notice q-img-error", role: "status" });
      n.appendChild(el("span"));
      var x = el("button", { type: "button", "aria-label": "Dismiss" }, "×");
      x.addEventListener("click", function () { n.hidden = true; });
      n.appendChild(x);
      document.body.appendChild(n);
    }
    n.firstChild.textContent = String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
    n.hidden = false;
    clearTimeout(imgErrTimer);
    imgErrTimer = setTimeout(function () { n.hidden = true; }, 5000);
  }

  function hideImgBox() {
    if (!imgBox) return;
    imgBox.box.remove();
    imgBox = null;
  }
  function placeImgBox() {
    if (!imgBox) return;
    if (!imgBox.img.isConnected) return hideImgBox();
    var r = imgBox.img.getBoundingClientRect();
    var b = imgBox.box.style;
    b.top = r.top + window.scrollY + "px";
    b.left = r.left + window.scrollX + "px";
    b.width = r.width + "px";
    b.height = r.height + "px";
  }
  function showImgBox(img) {
    hideImgBox();
    var box = el("div", { "data-q-ui": "", class: "q-ui q-img-box", "aria-hidden": "true" });
    var handle = el("div", { class: "q-img-handle", title: "Drag to resize" });
    box.appendChild(handle);
    document.body.appendChild(box);
    imgBox = { img: img, box: box };
    placeImgBox();
    handle.addEventListener("pointerdown", function (e) {
      if (page.readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      var startX = e.clientX;
      var startW = img.getBoundingClientRect().width;
      var region = regionOf(img);
      var maxW = region ? region.getBoundingClientRect().width : 2000;
      var w = startW;
      function move(ev) {
        w = Math.round(Math.max(40, Math.min(maxW, startW + ev.clientX - startX)));
        img.style.width = w + "px";
        placeImgBox();
      }
      function up() {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        img.style.removeProperty("width");
        if (!img.getAttribute("style")) img.removeAttribute("style");
        if (Math.abs(w - startW) < 2) return placeImgBox();
        mutate(function () { img.setAttribute("width", String(w)); });
        placeImgBox();
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }
  function onImgMouseDown(e) {
    if (imgBox && imgBox.box.contains(e.target)) return;
    var img = editing && e.target && e.target.tagName === "IMG" && regionOf(e.target) ? e.target : null;
    if (img) showImgBox(img);
    else hideImgBox();
  }
  // Backspace / Delete with an image picked: the image goes (and its paragraph, when that was all).
  function onImgKey(e) {
    if (!imgBox || page.readOnly) return;
    if (e.key === "Escape") return hideImgBox();
    if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
    if (e.key !== "Backspace" && e.key !== "Delete") return hideImgBox();
    e.preventDefault();
    e.__qHandled = true; // the text editor's own Backspace handling skips this one
    var img = imgBox.img;
    hideImgBox();
    mutate(function () {
      var p = img.parentElement;
      img.remove();
      if (p && p.tagName === "P" && !p.textContent.trim() && !p.querySelector("img,br")) p.appendChild(document.createElement("br"));
    });
    updatePlaceholder();
  }

  function showMadeNotice() {
    var n = document.querySelector(".q-made-notice");
    if (!n) {
      n = el("div", { "data-q-ui": "", class: "q-ui q-made-notice", role: "status" });
      n.appendChild(el("span", null, "This text comes from the page’s code. Edit it in Source."));
      var x = el("button", { type: "button", "aria-label": "Dismiss" }, "×");
      x.addEventListener("click", function () { noticeDismissed = true; n.hidden = true; });
      n.appendChild(x);
      document.body.appendChild(n);
    }
    n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { n.hidden = true; }, 4000);
  }

  // The user's Spellcheck setting, injected by the app (and updated live by it).
  function spellcheckOn() {
    var m = document.querySelector('meta[name="quire-spellcheck"]');
    return !m || m.getAttribute("content") !== "off";
  }

  function setEditing(on) {
    wantEdit = on;
    // Regions are chosen against the file as served, so wait for it the first time.
    if (on && !regions.length && srcBlocks === null) {
      loadSource().then(function () { if (wantEdit) setEditing(true); });
      return;
    }
    if (on) {
      buildRegions();
      ensureUi();
      try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) { /* ignore */ }
      regions.forEach(function (r) { r.el.setAttribute("contenteditable", "true"); r.el.spellcheck = spellcheckOn(); });
      document.documentElement.classList.add("q-edit");
      var first = !editing && !focusedOnce;
      editing = true;
      regions.forEach(function (r) { learnSpans(r.el); });
      if (!hist.cur) hist.cur = snapshot();
      headerTick(false);
      if (first) { focusedOnce = true; focusIfBlank(); }
      watchMade(true);
      aiRecheck();
    } else {
      if (editing) aiLinesToText();
      watchMade(false);
      if (editing && !page.readOnly) flushSave();
      if (page.readOnly) { clearTimeout(saveTimer); saveTimer = null; }
      regions.forEach(function (r) { r.el.removeAttribute("contenteditable"); });
      document.documentElement.classList.remove("q-edit");
      editing = false;
      hideToolbar();
      closeSlash();
      clearPlaceholder();
    }
  }

  /* ---- cleaning */

  function cleanTree(root) {
    // An unsent AI line (docs/ai.md) is saved, copied and compared as the plain text it stands
    // for, "/ai <request>": the field look is CSS on the block, so only "/ai " needs adding back.
    Array.prototype.slice.call(root.querySelectorAll("[data-q-ai-line]")).forEach(function (n) {
      var doc = n.ownerDocument || document;
      n.insertBefore(doc.createTextNode(aiPrefixFor(n)), n.firstChild);
    });
    Array.prototype.slice.call(root.querySelectorAll("[data-q-ui]")).forEach(function (n) { n.remove(); });
    Array.prototype.slice.call(root.querySelectorAll("quire-embed")).forEach(function (n) {
      var fresh = document.createElement("quire-embed");
      var src = n.getAttribute("src");
      if (src != null) fresh.setAttribute("src", src);
      Array.prototype.forEach.call(n.attributes, function (a) {
        if (a.name !== "src" && a.name !== "class" && a.name !== "contenteditable" && a.name.indexOf("data-q-") !== 0) {
          fresh.setAttribute(a.name, a.value);
        }
      });
      var cls = (n.getAttribute("class") || "").split(/\s+/).filter(function (c) { return c && c.indexOf("q-embed") !== 0; });
      if (cls.length) fresh.setAttribute("class", cls.join(" "));
      n.parentNode.replaceChild(fresh, n);
    });
    Array.prototype.slice.call(root.querySelectorAll("[data-q-region]")).forEach(function (r) {
      while (r.firstChild) r.parentNode.insertBefore(r.firstChild, r);
      r.remove();
    });
    var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
    all.forEach(function (el) {
      // A Noteblock AI marker keeps its two attributes: they are the file's, not the editor's.
      var aiMarker = el.hasAttribute("data-q-ai");
      Array.prototype.slice.call(el.attributes).forEach(function (a) {
        if (aiMarker && (a.name === "data-q-ai" || a.name === "data-q-ai-target")) return;
        if (a.name.indexOf("data-q-") === 0 || a.name === "contenteditable" || a.name === "spellcheck") {
          el.removeAttribute(a.name);
        }
      });
    });
    return root;
  }

  // What goes to the file: no empty items, no stray <div>/<br>, no lists split in two.
  function cleanForSave(root) {
    normalizeBlocks(root, document, { dropEmpty: true, trimBr: true, wrapTop: true });
  }

  function regionHtml(el) {
    var clone = el.cloneNode(true);
    restoreMade(clone);
    cleanTree(clone);
    cleanForSave(clone);
    // One top-level block per line, so saved files (and their git diffs) stay readable.
    var parts = [];
    for (var n = clone.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) parts.push(n.outerHTML);
      else if (n.nodeType === 3 && n.textContent.trim()) parts.push(n.textContent.trim());
    }
    var html = parts.join("\n");
    if (/^\s*<p>(<br>)?<\/p>\s*$/i.test(html)) return "";
    return html;
  }

  function countTopElements(html) {
    var t = document.createElement("template");
    t.innerHTML = html;
    return t.content.children.length;
  }

  /* ---- saving */

  // Built pages save on ⌘S only: each save rebuilds the page.
  var manualSave = false;
  var dirty = false;
  function setDirty(d) {
    if (d === dirty) return;
    dirty = d;
    try { appWin.postMessage({ quire: 1, type: "dirty", page: pagePath(), dirty: d }, "*"); } catch (e) { /* gone */ }
  }

  // Every edit comes through here: it's recorded for undo, then saved.
  function scheduleSave(kind) {
    if (!editing) return;
    noteChange(kind);
    queueSave();
  }

  function queueSave() {
    if (!editing) return;
    if (manualSave) { setDirty(true); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!regions.length || page.readOnly) return;
    if (saving) { dirtyWhileSaving = true; return; }

    if (isMarkdown) {
      var body = document.body.cloneNode(true);
      restoreMade(body);
      Array.prototype.forEach.call(body.querySelectorAll("[data-q-region]"), cleanForSave);
      cleanTree(body);
      saving = true;
      rpc("save", { markdownBody: body.innerHTML.trim() }).then(doneSaving, failSaving);
      return;
    }

    var payload = regions.map(function (r) {
      var next = r.el.nextElementSibling;
      while (next && !next.hasAttribute("data-q-region") && qi(next) === null) next = next.nextElementSibling;
      var before = next && !next.hasAttribute("data-q-region") ? qi(next) : null;
      return { replace: r.replace.slice(), before: before, html: regionHtml(r.el) };
    });

    // What the file's top-level numbering will be after applyRegions + indexBody, so the
    // next save addresses the file as it is then, not as it was when the page loaded.
    var plan = [];
    var n = 0;
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (isUi(el)) return;
      if (el.hasAttribute("data-q-region")) {
        var idx = regions.findIndex(function (r) { return r.el === el; });
        var count = countTopElements(payload[idx].html);
        var range = [];
        for (var k = 0; k < count; k++) range.push(n++);
        plan.push({ region: regions[idx], range: range });
      } else if (qi(el) !== null) {
        plan.push({ el: el, i: n++ });
      }
    });

    saving = true;
    rpc("save", { regions: payload }).then(function (res) {
      plan.forEach(function (p) {
        if (p.region) p.region.replace = p.range;
        else p.el.setAttribute("data-q-i", String(p.i));
      });
      doneSaving(res);
    }, failSaving);
  }

  function doneSaving() {
    saving = false;
    if (manualSave && !dirtyWhileSaving) setDirty(false);
    if (dirtyWhileSaving) { dirtyWhileSaving = false; scheduleSave(); }
  }
  function failSaving(err) {
    saving = false;
    dirtyWhileSaving = false;
    console.error("[quire] save failed:", err && err.message ? err.message : err);
  }

  /* ---- the page's header names the page */

  // Leaving the first h1 of the first region with changed text renames the page, if that header
  // said the page's name before. The app does the rename (App.jsx, header-rename) and this frame
  // stays up through it: see usePageSwap's follow, and pageMoved below.
  // `text` is what the header said when the caret last left it (or when editing started), which is
  // what it said when the caret came back unless an undo changed it. An undo then counts as an
  // edit, so undoing a rename's text and leaving renames the page back.
  var headerWatch = { index: -1, text: "", inside: false, tied: false, busy: false, again: false };
  var composing = false;

  function headerOff() {
    return !editing || page.readOnly || manualSave || !regions.length || !isFramed || isEmbedded || nativeHost || nativeEditorHost() ||
      window.name === "q-floating";
  }
  function firstHeader() {
    var h = regions[0].el.querySelector(":scope > h1");
    return h && !h.closest("[data-q-made],[data-q-ai]") ? h : null;
  }
  function inUi(el) {
    return !!(el && el.closest && el.closest("[data-q-ui]"));
  }
  function pageName() {
    return pageTitle || pagePath().split("/").pop() || "";
  }

  function headerTick(blurred) {
    if (headerOff() || composing) return;
    var h = firstHeader();
    if (!h) { headerWatch.index = -1; headerWatch.inside = false; return; }
    // A different block is first now (the old one was turned into something else): start over.
    var index = Array.prototype.indexOf.call(h.parentNode.children, h);
    if (index !== headerWatch.index) {
      headerWatch.index = index;
      headerWatch.text = h.textContent;
      headerWatch.inside = false;
      headerWatch.tied = false;
    }
    // The link field and the slash menu's search are still working on the header.
    if (inUi(document.activeElement)) return;
    var sel = window.getSelection();
    if (!blurred && sel && sel.rangeCount && (h.contains(sel.anchorNode) || h.contains(sel.focusNode))) {
      headerWatch.inside = true;
      return;
    }
    if (!headerWatch.inside) return;
    headerWatch.inside = false;
    headerLeft(h.textContent);
  }

  function headerLeft(after) {
    // A header that was refused (empty, a name that's taken) is still this page's header.
    var before = headerWatch.tied ? pageName() : headerWatch.text;
    headerWatch.text = after;
    if (headerName(after) === headerName(pageName())) headerWatch.tied = false;
    if (headerName(before) === headerName(pageName()) && !headerName(after)) {
      headerWatch.tied = true;
      console.info("[noteblock] header rename skipped: the header is empty");
      return;
    }
    if (!shouldRenameFromHeader(pageName(), before, after)) return;
    if (headerWatch.busy) { headerWatch.again = true; return; }
    headerWatch.busy = true;
    var name = headerName(after);
    whenSaved(function () {
      try {
        window.parent.postMessage({ quire: 1, type: "header-rename", name: name }, "*");
      } catch (e) {
        headerWatch.busy = false;
      }
    });
  }

  // The page's typing on disk first: a rename carries the file as it is.
  function whenSaved(fn) {
    var t0 = Date.now();
    (function go() {
      if (saveTimer) flushSave();
      if ((!saving && !dirtyWhileSaving && !saveTimer) || Date.now() - t0 > 3000) return fn();
      setTimeout(go, 30);
    })();
  }

  function headerRenameDone(msg) {
    headerWatch.busy = false;
    if (msg.ok) {
      headerWatch.tied = false;
      if (typeof msg.path === "string" && msg.path) pageMoved(msg.path);
    } else {
      headerWatch.tied = true;
    }
    // They changed it again while the rename ran.
    if (headerWatch.again) {
      headerWatch.again = false;
      if (!headerOff() && firstHeader()) {
        var now = firstHeader().textContent;
        if (headerName(now) && headerName(now) !== headerName(pageName())) { headerWatch.tied = true; headerLeft(now); }
      }
    }
  }

  // This page's folder got a new name and this frame stays up: it now speaks for the new path, and
  // relative URLs resolve from there.
  function pageMoved(path) {
    var was = location.pathname;
    cachedPath = path;
    pageTitle = path.split("/").pop();
    var meta = document.querySelector('meta[name="quire-page"]');
    if (meta) meta.setAttribute("content", path);
    var next = "/" + path.split("/").map(encodeURIComponent).join("/") + "/";
    try {
      history.replaceState(history.state, "", next + location.search);
      var base = document.querySelector("base[href]");
      if (base && base.href.indexOf(location.origin + was) === 0) base.href = location.origin + next + base.href.slice((location.origin + was).length);
    } catch (e) {
      console.info("[noteblock] the page's address didn't follow its new name:", e && e.message);
    }
  }

  /* ---- undo */

  // ⌘Z / ⇧⌘Z replay snapshots of every region, taken after each change: the browser's and
  // the editor's own DOM work (lists, slash inserts, shortcuts, paste, embeds) alike. The
  // browser's undo stack never sees the DOM work, so it isn't used at all. A restore saves
  // like any edit, so the file follows.
  var HIST_MAX = 300;
  var hist = { undo: [], redo: [], cur: null, kind: "", at: 0, busy: 0, pre: null, keyAt: 0 };

  function pathTo(root, node) {
    var p = [];
    for (; node && node !== root; node = node.parentNode) {
      if (!node.parentNode) return null;
      p.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
    }
    return node ? p : null;
  }
  function nodeAt(root, path) {
    var n = root;
    for (var i = 0; n && path && i < path.length; i++) n = n.childNodes[path[i]];
    return path ? n || null : null;
  }
  function caretRec() {
    var r = currentRange();
    if (!r) return null;
    var region = regionOf(r.startContainer);
    var ri = regions.findIndex(function (x) { return x.el === region; });
    if (ri < 0 || regionOf(r.endContainer) !== region) return null;
    return { ri: ri, s: pathTo(region, r.startContainer), so: r.startOffset, e: pathTo(region, r.endContainer), eo: r.endOffset };
  }
  function setCaret(c) {
    if (!c || !regions[c.ri]) return false;
    var root = regions[c.ri].el;
    var s = nodeAt(root, c.s);
    var e = nodeAt(root, c.e);
    if (!s || !e) return false;
    var max = function (n) { return n.nodeType === 3 ? n.nodeValue.length : n.childNodes.length; };
    try {
      root.focus({ preventScroll: true });
      var r = document.createRange();
      r.setStart(s, Math.min(c.so, max(s)));
      r.setEnd(e, Math.min(c.eo, max(e)));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      var rect = rangeRect(r);
      if (rect && (rect.bottom < 0 || rect.top > window.innerHeight)) {
        var el0 = s.nodeType === 1 ? s : s.parentElement;
        if (el0 && el0.scrollIntoView) el0.scrollIntoView({ block: "nearest" });
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function htmlKey(n) { return n.outerHTML.replace(/ data-q-(ph|ai-changed)="[^"]*"/g, ""); }
  function snapshot() {
    // Strings shared with the last snapshot, so a long history of a big page stays small.
    var prev = new Map();
    if (hist.cur) hist.cur.regions.forEach(function (e) { e.kids.forEach(function (k) { if (typeof k === "string") prev.set(k, k); }); });
    return {
      regions: regions.map(function (r) {
        var ks = [];
        for (var n = r.el.firstChild; n; n = n.nextSibling) {
          // Live: an embed's frame stays loaded, an AI block keeps its card and its job.
          if (n.nodeType === 1 && (n.tagName === "QUIRE-EMBED" || n.hasAttribute("data-q-ai"))) ks.push(n);
          else if (n.nodeType === 1) { var h = htmlKey(n); ks.push(prev.get(h) || h); }
          else if (n.nodeType === 3) ks.push({ text: n.nodeValue });
        }
        return { kids: ks, hidden: r.el.style.display === "none" };
      }),
      caret: caretRec(),
    };
  }
  function sameSnap(a, b) {
    if (a.regions.length !== b.regions.length) return false;
    return a.regions.every(function (x, i) {
      var y = b.regions[i];
      if (x.hidden !== y.hidden || x.kids.length !== y.kids.length) return false;
      return x.kids.every(function (k, j) {
        var l = y.kids[j];
        return k === l || (k && l && k.text != null && k.text === l.text);
      });
    });
  }

  /** Records the page as it is now. Typing (and deleting) within a second joins one step. */
  function noteChange(kind) {
    if (hist.busy || !editing || !regions.length) return false;
    kind = kind || "op";
    var next = snapshot();
    if (!hist.cur) { hist.cur = next; return true; }
    if (sameSnap(hist.cur, next)) { hist.cur.caret = next.caret; return false; }
    var now = Date.now();
    var merge = (kind === "type" || kind === "delete") && kind === hist.kind && now - hist.at < 1000;
    if (!merge) {
      hist.cur.back = hist.pre || hist.cur.caret;
      hist.undo.push(hist.cur);
      if (hist.undo.length > HIST_MAX) hist.undo.shift();
    }
    hist.redo.length = 0;
    hist.cur = next;
    hist.kind = kind;
    hist.at = now;
    hist.pre = null;
    return true;
  }

  /** The page as it is now becomes the base, without an undo step (a region was added). */
  function syncHistory() {
    if (!hist.busy && editing) hist.cur = snapshot();
  }

  /** Runs a DOM change of the editor's own as one undo step, and saves it. */
  function mutate(fn) {
    if (!hist.busy) hist.pre = caretRec();
    hist.busy++;
    var out;
    try { out = fn(); } finally { hist.busy--; }
    if (!hist.busy) {
      hist.kind = "";
      if (noteChange("op")) queueSave();
    }
    return out;
  }

  function undo() {
    noteChange("op"); // anything not recorded yet is a step of its own
    if (!hist.undo.length) return;
    var s = hist.undo.pop();
    hist.redo.push(hist.cur);
    applySnap(s, s.back || s.caret);
  }
  function redo() {
    noteChange("op");
    if (!hist.redo.length) return;
    var s = hist.redo.pop();
    hist.undo.push(hist.cur);
    applySnap(s, s.caret);
  }

  function applySnap(s, caret) {
    hist.busy++;
    try {
      closeSlash();
      hideToolbar();
      clearPlaceholder();
      s.regions.forEach(function (e, i) {
        var r = regions[i];
        if (!r) return;
        var el = r.el;
        el.style.display = e.hidden ? "none" : "";
        // Nodes that are already right are kept, so embeds don't reload and text stays put.
        var pool = new Map();
        for (var n = el.firstChild; n; n = n.nextSibling) {
          if (n.nodeType !== 1 || n.tagName === "QUIRE-EMBED" || n.hasAttribute("data-q-ai")) continue;
          var h = htmlKey(n);
          if (!pool.has(h)) pool.set(h, []);
          pool.get(h).push(n);
        }
        var want = e.kids.map(function (k) {
          if (typeof k === "string") {
            var have = pool.get(k);
            if (have && have.length) return have.shift();
            var t = document.createElement("template");
            t.innerHTML = k;
            return t.content.firstChild || document.createTextNode("");
          }
          if (k && k.nodeType) return k;
          return document.createTextNode(k.text);
        });
        want.forEach(function (n, j) {
          if (el.childNodes[j] !== n) el.insertBefore(n, el.childNodes[j] || null);
        });
        while (el.childNodes.length > want.length) el.removeChild(el.lastChild);
        Array.prototype.forEach.call(el.querySelectorAll("[data-q-ph],[data-q-ai-changed]"), function (x) { x.removeAttribute("data-q-ph"); x.removeAttribute("data-q-ai-changed"); });
        Array.prototype.forEach.call(el.querySelectorAll(".q-embed-selected"), function (x) { if (x !== selectedEmbed) x.classList.remove("q-embed-selected"); });
        hydrateEmbeds(el);
        learnSpans(el);
      });
      if (!setCaret(caret)) {
        var live = regions.filter(function (r) { return r.el.isConnected && r.el.style.display !== "none"; })[0];
        if (live) { live.el.focus({ preventScroll: true }); placeCaret(live.el, true); }
      }
    } finally {
      hist.busy--;
    }
    hist.cur = s;
    hist.kind = "";
    hist.pre = null;
    queueSave();
    updatePlaceholder();
  }

  /* ---- spans the browser makes */

  // Chrome wraps merged text in <span style="…"> copying computed styles. Spans that were in the
  // file (or look exactly like one) are the author's and stay; the rest are unwrapped.
  var knownSpans = new WeakSet();
  var knownStyles = {};
  function learnSpans(root) {
    Array.prototype.forEach.call(root.querySelectorAll("span,font"), function (n) {
      var st = n.getAttribute("style");
      if (st && stampedStyle(st, true)) return; // one the browser made and an older save kept
      knownSpans.add(n);
      if (st) knownStyles[st] = true;
    });
  }
  function isKnownSpan(n) {
    return knownSpans.has(n) || !!knownStyles[n.getAttribute("style") || "\u0000"];
  }

  /** Repairs a region after an edit (see normalizeBlocks), keeping the caret where it is. */
  function tidyRegion(region, dropEmpty) {
    if (!region) return;
    var r = currentRange();
    var keep = r && region.contains(r.startContainer) ? r.startContainer : null;
    keepCaret(function () {
      return normalizeBlocks(region, document, { keepSpan: isKnownSpan, keep: keep, keepItem: wasEmptyItem, dropEmpty: !!dropEmpty, dropBrRuns: !!dropEmpty, wrapTop: true });
    });
  }

  // Bullets that were already empty before a delete stay: Backspace in one item mustn't take a
  // blank item further down. Only the items the delete itself emptied go.
  var emptyItems = new WeakSet();
  function wasEmptyItem(li) { return emptyItems.has(li); }
  function markEmptyItems(region) {
    emptyItems = new WeakSet();
    if (!region) return;
    var r = currentRange();
    Array.prototype.forEach.call(region.querySelectorAll("li"), function (li) {
      if (isEmptyNode(li) && !(r && !r.collapsed && r.intersectsNode(li))) emptyItems.add(li);
    });
  }

  /* ------------------------------------------------------------------ edit UI */

  var ui = null;

  var ICONS = {
    link: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.6.6M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.6-.6"/></svg>',
    bullets: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="3.5" cy="4.5" r=".6" fill="currentColor"/><circle cx="3.5" cy="8" r=".6" fill="currentColor"/><circle cx="3.5" cy="11.5" r=".6" fill="currentColor"/><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7"/></svg>',
    numbered: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7"/><path d="M2.5 3.5l1-.5v3" stroke-width="1.2"/><path d="M2.4 10h1.6l-1.6 2.2h1.7" stroke-width="1.2"/></svg>',
    text: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.5 4h9M8 4v9"/></svg>',
    h2: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 3.5v9M9 3.5v9M3 8h6M11.5 6.5l1.5-1v7"/></svg>',
    h3: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 4v8M8 4v8M3 8h5"/><path d="M10.5 5h3l-1.8 2.6c1.2 0 1.9.7 1.9 1.7S12.8 11 11.8 11c-.6 0-1.1-.2-1.4-.6" stroke-width="1.2"/></svg>',
    quote: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3v10M6.5 5h6M6.5 8h6M6.5 11h4"/></svg>',
    code: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/></svg>',
    divider: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 8h11"/><path d="M5 4.5h6M5 11.5h6" opacity=".4"/></svg>',
    embed: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6h11"/></svg>',
    page: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>',
    ai: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.5 1.5M10.5 10.5L12 12M12 4l-1.5 1.5M5.5 10.5L4 12"/></svg>',
    spinner: '<svg class="q-ai-spin" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    stop: '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor"/></svg>',
    warn: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3l5.5 10h-11z"/><path d="M8 7v2.5M8 11.2v.1"/></svg>',
  };

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (html != null) e.innerHTML = html;
    return e;
  }

  function ensureUi() {
    if (ui) return;
    var toolbar = el("div", { "data-q-ui": "", class: "q-ui q-toolbar", role: "toolbar", "aria-label": "Format", hidden: "" });
    var buttons = el("div", { style: "display:contents" });
    var mk = function (cmd, label, inner, cls) {
      var b = el("button", { type: "button", "aria-label": label, title: label, "data-cmd": cmd, class: cls || "" }, inner);
      buttons.appendChild(b);
      return b;
    };
    mk("bold", "Bold", "B", "q-tb-bold");
    mk("italic", "Italic", "I", "q-tb-italic");
    mk("link", "Link", ICONS.link);
    buttons.appendChild(el("span", { class: "q-tb-sep", "aria-hidden": "true" }));
    mk("h2", "Heading", "H2");
    mk("h3", "Subheading", "H3");
    mk("bullets", "Bullets", ICONS.bullets);

    var linkForm = el("form", { class: "q-tb-link-form", hidden: "" });
    var linkInput = el("input", { class: "q-tb-link-input", type: "text", placeholder: "Paste a link, Enter to apply", spellcheck: "false", autocomplete: "off" });
    var linkApply = el("button", { type: "submit", "aria-label": "Apply link", title: "Apply" }, "Apply");
    linkForm.appendChild(linkInput);
    linkForm.appendChild(linkApply);

    toolbar.appendChild(buttons);
    toolbar.appendChild(linkForm);

    var slash = el("div", { "data-q-ui": "", class: "q-ui q-slash", role: "listbox", "aria-label": "Insert block", hidden: "" });
    // The popup keeps its heading and the page search field across renders (rebuilding a
    // focused input would drop focus); only the list below them is redrawn.
    var slashHead = el("div", { class: "q-slash-group" });
    var slashSearch = el("input", { class: "q-slash-search", type: "search", placeholder: "Search pages", "aria-label": "Search pages to embed", autocomplete: "off", spellcheck: "false", hidden: "" });
    var slashList = el("div", { class: "q-slash-list" });
    slash.appendChild(slashHead);
    slash.appendChild(slashSearch);
    slash.appendChild(slashList);

    document.body.appendChild(toolbar);
    document.body.appendChild(slash);
    ui = { toolbar: toolbar, buttons: buttons, linkForm: linkForm, linkInput: linkInput, slash: slash, slashHead: slashHead, slashSearch: slashSearch, slashList: slashList };

    toolbar.addEventListener("mousedown", function (e) {
      // Keep the text selection; the link input still needs focus.
      if (e.target !== linkInput) e.preventDefault();
    });
    buttons.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-cmd]");
      if (!b) return;
      runToolbarCommand(b.getAttribute("data-cmd"));
    });
    linkForm.addEventListener("submit", function (e) {
      e.preventDefault();
      applyLink(linkInput.value);
    });
    linkInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLinkInput(true);
      }
    });
    slash.addEventListener("mousedown", function (e) { if (e.target !== slashSearch) e.preventDefault(); });
    slashSearch.addEventListener("input", function () {
      slashState.query = slashSearch.value;
      slashState.active = 0;
      renderSlash();
    });
    slash.addEventListener("mousemove", function (e) {
      var item = e.target.closest(".q-slash-item");
      if (!item) return;
      var i = Number(item.getAttribute("data-index"));
      if (i !== slashState.active) { slashState.active = i; renderSlashSelection(); }
    });
    slash.addEventListener("click", function (e) {
      var item = e.target.closest(".q-slash-item");
      if (!item) return;
      chooseSlash(Number(item.getAttribute("data-index")));
    });

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("selectionchange", function () { headerTick(false); });
    document.addEventListener("input", function () { headerTick(false); }, true);
    document.addEventListener("focusout", function (e) {
      if (!inUi(e.relatedTarget)) headerTick(true);
    }, true);
    window.addEventListener("blur", function () { headerTick(true); });
    document.addEventListener("compositionstart", function () { composing = true; }, true);
    document.addEventListener("compositionend", function () { composing = false; setTimeout(function () { headerTick(false); }, 0); }, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    document.addEventListener("input", onInput, true);
    editorKeydown.push(onKeyDown);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("dragover", onDragOverFiles, true);
    document.addEventListener("dragleave", onDragLeaveFiles, true);
    document.addEventListener("drop", onDropFiles, true);
    document.addEventListener("mousedown", onImgMouseDown, true);
    editorKeydown.unshift(onImgKey);
    window.addEventListener("resize", placeImgBox);
    window.addEventListener("scroll", placeImgBox, true);
    document.addEventListener("input", placeImgBox, true);
    document.addEventListener("cut", onCut, true);
    document.addEventListener("mousedown", onBlankMouseDown);
    document.addEventListener("mousedown", function (e) {
      if (ui.slash.contains(e.target) || ui.toolbar.contains(e.target)) return;
      closeSlash();
    }, true);
    window.addEventListener("scroll", function () {
      if (!ui.toolbar.hidden) positionToolbar();
      if (slashState.open) positionSlash();
    }, true);
    window.addEventListener("resize", function () {
      if (!ui.toolbar.hidden) positionToolbar();
      if (slashState.open) positionSlash();
    });
    window.addEventListener("pagehide", function () { if (saveTimer || dirty) flushSave(); });
    editorKeydown.push(function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (editing && !page.readOnly) flushSave();
      }
    });
  }

  /* ---- selection helpers */

  function currentRange() {
    var sel = window.getSelection();
    return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  }

  function selectionRegion() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var a = regionOf(sel.anchorNode);
    var f = regionOf(sel.focusNode);
    return a && a === f ? a : null;
  }

  function rangeRect(range) {
    var rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      var rects = range.getClientRects();
      if (rects.length) rect = rects[0];
      else {
        var node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        rect = node ? node.getBoundingClientRect() : null;
      }
    }
    return rect;
  }

  var BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div:not([data-q-region]),figure,figcaption,td,th";
  function caretBlock() {
    var r = currentRange();
    if (!r) return null;
    var region = regionOf(r.startContainer);
    if (!region) return null;
    var node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    var block = node && node.closest(BLOCK_SELECTOR);
    if (!block || !region.contains(block) || block === region) return null;
    return block;
  }

  function placeCaret(node, atEnd) {
    var range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(!atEnd);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ---- block structure */

  var CLOSES_P = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DETAILS|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|MAIN|MENU|NAV|OL|P|PRE|SECTION|TABLE|UL)$/;

  // Runs fn and puts the caret back where it was: nodes and offsets survive being moved,
  // the live selection doesn't.
  function keepCaret(fn) {
    var sel = window.getSelection();
    var r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    var at = r ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : null;
    if (fn() === false) return; // nothing moved
    if (!at || !at[0].isConnected || !at[2].isConnected) return;
    try {
      var next = document.createRange();
      next.setStart(at[0], at[1]);
      next.setEnd(at[2], at[3]);
      sel.removeAllRanges();
      sel.addRange(next);
    } catch (e) { /* offsets no longer fit */ }
  }

  // Chrome's list commands can leave a <ul> inside a <p>. The browser splits that on the next
  // load, so split it now: blocks move out, inline runs stay as paragraphs.
  function unnestParagraphs(root) {
    var bad = Array.prototype.filter.call(root.querySelectorAll("p"), function (p) {
      return Array.prototype.some.call(p.children, function (c) { return CLOSES_P.test(c.tagName); });
    });
    if (!bad.length) return;
    keepCaret(function () {
      bad.forEach(function (p) {
        if (!p.parentNode) return;
        var run = null;
        var runs = [];
        while (p.firstChild) {
          var c = p.firstChild;
          if (c.nodeType === 1 && CLOSES_P.test(c.tagName)) {
            run = null;
            p.parentNode.insertBefore(c, p);
          } else {
            if (!run) { run = p.cloneNode(false); p.parentNode.insertBefore(run, p); runs.push(run); }
            run.appendChild(c);
          }
        }
        p.remove();
        runs.forEach(function (r) {
          if (!r.textContent.trim() && !r.querySelector("img,iframe,quire-embed")) r.remove();
        });
      });
    });
  }

  function caretItem() {
    var r = currentRange();
    if (!r) return null;
    var node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    var li = node && node.closest("li");
    return li && regionOf(li) ? li : null;
  }

  // Whitespace that draws nothing (source indentation, zero-width) isn't text.
  function inkless(s) { return !String(s).replace(/[ \t\n\r\u200b\ufeff]/g, ""); }
  var SOLID_SEL = "img,hr,quire-embed,iframe";
  function inklessNode(n) {
    return n.nodeType === 3 ? inkless(n.nodeValue) : n.nodeType !== 1 || (inkless(n.textContent) && !n.matches(SOLID_SEL) && !n.querySelector(SOLID_SEL));
  }

  // Nothing but whitespace from the start of `block` to the start of range `r`.
  function fromLineStart(r, block) {
    var head = document.createRange();
    head.setStart(block, 0);
    head.setEnd(r.startContainer, r.startOffset);
    return inkless(String(head)) && !head.cloneContents().querySelector(SOLID_SEL);
  }
  // …and from the end of `r` to the end of the item's own line (its sub-lists don't count).
  function toLineEnd(r, block) {
    var tail = document.createRange();
    tail.setStart(r.endContainer, r.endOffset);
    tail.setEnd(block, block.childNodes.length);
    var frag = tail.cloneContents();
    Array.prototype.forEach.call(frag.querySelectorAll("ul,ol"), function (l) { l.remove(); });
    return inkless(frag.textContent) && !frag.querySelector(SOLID_SEL);
  }

  // Collapsed caret with nothing before it in `block`.
  function caretAtStart(block) {
    var r = currentRange();
    return !!(r && r.collapsed && block.contains(r.startContainer) && fromLineStart(r, block));
  }
  function caretAtLineEnd(li) {
    var r = currentRange();
    return !!(r && r.collapsed && li.contains(r.startContainer) && toLineEnd(r, li));
  }

  function firstItem(list) {
    for (var c = list.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === "LI") return c;
    return null;
  }
  function lastItem(list) {
    for (var c = list.lastElementChild; c; c = c.previousElementSibling) if (c.tagName === "LI") return c;
    return null;
  }
  function prevItem(li) {
    for (var c = li.previousElementSibling; c; c = c.previousElementSibling) if (c.tagName === "LI") return c;
    return null;
  }
  // The item drawn last inside li: its deepest last sub-item, or li itself.
  function lastLine(li) {
    for (;;) {
      var subs = ownLists(li);
      var last = subs.length ? lastItem(subs[subs.length - 1]) : null;
      if (!last) return li;
      li = last;
    }
  }
  // The line drawn above li's: the previous item's last line, or the item li is nested in.
  function lineAbove(li) {
    var prev = prevItem(li);
    if (prev) return lastLine(prev);
    var up = li.parentElement && li.parentElement.parentElement;
    return up && up.tagName === "LI" ? up : null;
  }
  // The line drawn below li's: its first sub-item, or the next item here or further out.
  function lineBelow(li) {
    var subs = ownLists(li);
    for (var i = 0; i < subs.length; i++) { var f = firstItem(subs[i]); if (f) return f; }
    for (var n = li; n && n.tagName === "LI"; n = n.parentElement && n.parentElement.parentElement) {
      for (var x = n.nextElementSibling; x; x = x.nextElementSibling) if (x.tagName === "LI") return x;
    }
    return null;
  }

  function caretAt(node, offset) {
    var r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  // Where a caret at the end of `li`'s own line goes: after its last text when there is some.
  function lineEndCaret(li) {
    var stop = ownLists(li)[0] || null;
    var end = stop ? stop.previousSibling : li.lastChild;
    while (end && end.nodeType === 3 && inkless(end.nodeValue) && end.previousSibling) end = end.previousSibling;
    if (end && end.nodeType === 3) return [end, end.nodeValue.length];
    if (end && end.nodeName === "BR") return [li, Array.prototype.indexOf.call(li.childNodes, end)];
    return [li, stop ? Array.prototype.indexOf.call(li.childNodes, stop) : li.childNodes.length];
  }

  // <li><p>a</p></li> (a loose markdown list, an outside writer) is left as it is until someone
  // edits that item's line: then its text joins other lines as text, not as a block in a block.
  function flattenItemParagraphs(li) {
    kids(li).forEach(function (c) { if (tagOf(c) === "P") flattenInto(c, document); });
  }

  /**
   * Joins an item's line onto the line above it (Backspace at its start, Delete at the end of
   * the line above), so the list stays one list. Its sub-items come along. False at the top.
   */
  function joinItemUp(li) {
    var list = li.parentElement;
    var prev = prevItem(li);
    var target = lineAbove(li);
    if (!target) return false;
    flattenItemParagraphs(li);
    flattenItemParagraphs(target);
    var line = Array.prototype.filter.call(li.childNodes, function (c) { return !isList(c); });
    var subs = ownLists(li);
    var empty = line.every(inklessNode);
    var stop = ownLists(target)[0] || null;
    // A lone <br> ending the line above is a placeholder (or draws nothing): text replaces it.
    var end = stop ? stop.previousSibling : target.lastChild;
    while (end && end.nodeType === 3 && inkless(end.nodeValue)) end = end.previousSibling;
    if (!empty && end && end.nodeName === "BR") end.remove();
    var at = lineEndCaret(target);
    if (!empty) line.forEach(function (c) { target.insertBefore(c, stop); });
    if (prev) subs.forEach(function (sub) { prev.appendChild(sub); });
    else {
      // li was the first under `target`: its sub-items move up into its place.
      subs.forEach(function (sub) {
        Array.prototype.slice.call(sub.children).forEach(function (x) { list.insertBefore(x, li); });
        sub.remove();
      });
    }
    li.remove();
    if (!list.querySelector("li")) list.remove();
    caretAt(at[0], at[1]);
    return true;
  }

  var LINE_SEL = "li,p,h1,h2,h3,h4,h5,h6";
  function lineOf(node, region) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    var b = el && el.closest(BLOCK_SELECTOR);
    if (!b || b === region || !region.contains(b) || !b.matches(LINE_SEL) || b.closest("pre,table,blockquote")) return null;
    return b;
  }

  /**
   * Backspace/Delete over a selection that spans list items: what's selected goes, the two
   * ends join into one line, and the list stays one list. Whole items selected end to end
   * go entirely. False when the browser's own delete is fine (no list item involved).
   */
  function deleteAcrossItems() {
    var sel = window.getSelection();
    var region = selectionRegion();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !region) return false;
    var r = sel.getRangeAt(0).cloneRange();
    var sb = lineOf(r.startContainer, region);
    var eb = lineOf(r.endContainer, region);
    if (!sb || !eb || sb === eb || (sb.tagName !== "LI" && eb.tagName !== "LI") || eb.contains(sb)) return false;
    var whole = sb.tagName === "LI" && eb.tagName === "LI" && fromLineStart(r, sb) && toLineEnd(r, eb);
    var above = whole ? lineAbove(sb) : null;
    markEmptyItems(region);
    mutate(function () {
      r.deleteContents();
      // deleteContents leaves the range in the list between the two items, not in sb: the
      // join goes at the end of sb's own line (before its sub-lists), at sb's level.
      var line = Array.prototype.filter.call(eb.childNodes, function (c) { return !isList(c); });
      var subs = ownLists(eb);
      var stop = sb.tagName === "LI" ? ownLists(sb)[0] || null : null;
      var join = lineEndCaret(sb);
      if (!line.every(inklessNode)) {
        // sb's placeholder <br> goes when text arrives.
        var last = stop ? stop.previousSibling : sb.lastChild;
        if (last && last.nodeName === "BR" && inkless(sb.textContent)) { last.remove(); join = lineEndCaret(sb); }
        line.forEach(function (c) { sb.insertBefore(c, stop); });
      }
      if (subs.length) {
        if (sb.tagName === "LI" && !sb.contains(eb)) subs.forEach(function (sub) { sb.appendChild(sub); });
        else {
          subs.forEach(function (sub) {
            Array.prototype.slice.call(sub.children).forEach(function (x) { eb.parentElement.insertBefore(x, eb); });
            sub.remove();
          });
        }
      }
      var lists = [];
      for (var a = eb.parentElement; a && a !== region; a = a.parentElement) if (isList(a)) lists.push(a);
      eb.remove();
      lists.forEach(function (l) { if (l.isConnected && !l.querySelector("li")) l.remove(); });
      var caret = join;
      if (whole && sb.isConnected && sb.tagName === "LI" && !ownLists(sb).length && Array.prototype.every.call(sb.childNodes, inklessNode)) {
        // Whole items went: no empty one is left behind.
        var list = sb.parentElement;
        var below = lineBelow(sb);
        sb.remove();
        if (above && above.isConnected) caret = lineEndCaret(above);
        else if (below && below.isConnected) caret = [below, 0];
        else if (!list.querySelector("li")) {
          var p = document.createElement("p");
          p.innerHTML = "<br>";
          list.parentNode.insertBefore(p, list);
          list.remove();
          caret = [p, 0];
        }
      }
      try { caretAt(caret[0], caret[1]); } catch (e) { /* node went */ }
      tidyRegion(region, true);
    });
    return true;
  }

  // Tab: the item moves under the one above it.
  function indentItem(li) {
    var prev = li.previousElementSibling;
    if (!prev || prev.tagName !== "LI") return;
    var tag = li.parentElement.tagName;
    var sub = prev.lastElementChild && prev.lastElementChild.tagName === tag ? prev.lastElementChild : null;
    keepCaret(function () {
      if (!sub) { sub = document.createElement(tag); prev.appendChild(sub); }
      sub.appendChild(li);
    });
  }

  // Shift-Tab: a nested item moves out a level. The items below it come along as its
  // children, so nothing changes order. False when the item is already at the top level.
  function outdentItem(li) {
    var list = li.parentElement;
    var parentItem = list.parentElement;
    if (!parentItem || parentItem.tagName !== "LI") return false;
    keepCaret(function () {
      var below = [];
      for (var n = li.nextElementSibling; n; n = n.nextElementSibling) below.push(n);
      if (below.length) {
        var sub = li.lastElementChild && li.lastElementChild.tagName === list.tagName ? li.lastElementChild : null;
        if (!sub) { sub = document.createElement(list.tagName); li.appendChild(sub); }
        below.forEach(function (n) { sub.appendChild(n); });
      }
      parentItem.parentNode.insertBefore(li, parentItem.nextSibling);
      if (!list.children.length) list.remove();
    });
    return true;
  }

  // Backspace at the start of a top-level item: the bullet goes and its text stays, as a
  // paragraph between the items above and below.
  function itemToParagraph(li) {
    flattenItemParagraphs(li);
    var list = li.parentElement;
    var p = document.createElement("p");
    var after = [];
    while (li.firstChild) {
      var c = li.firstChild;
      if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) { li.removeChild(c); after.push(c); }
      else p.appendChild(c);
    }
    var rest = [];
    for (var n = li.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
    if (rest.length) {
      var tail = list.cloneNode(false);
      rest.forEach(function (x) { tail.appendChild(x); });
      after.push(tail);
    }
    var anchor = list;
    if (!li.previousElementSibling) {
      list.parentNode.insertBefore(p, list);
      li.remove();
      list.remove();
      anchor = p;
    } else {
      li.remove();
      list.parentNode.insertBefore(p, list.nextSibling);
      anchor = p;
    }
    after.forEach(function (x) { anchor.parentNode.insertBefore(x, anchor.nextSibling); anchor = x; });
    if (!p.firstChild || (!p.textContent && !p.querySelector("br,img"))) p.innerHTML = "<br>";
    placeCaret(p, false);
  }

  // Turns a top-level paragraph into another block, keeping its content. Lists join a list
  // of the same kind right above.
  function convertBlock(block, tag, start) {
    var inner;
    if (tag === "UL" || tag === "OL") {
      var prev = block.previousElementSibling;
      var list = prev && prev.tagName === tag ? prev : null;
      if (!list) {
        list = document.createElement(tag);
        if (tag === "OL" && start > 1) list.setAttribute("start", String(start));
        block.parentNode.insertBefore(list, block);
      }
      inner = document.createElement("li");
      list.appendChild(inner);
    } else {
      inner = document.createElement(tag);
      block.parentNode.insertBefore(inner, block);
    }
    while (block.firstChild) inner.appendChild(block.firstChild);
    block.remove();
    if (!inner.textContent && !inner.querySelector("br,img")) inner.innerHTML = "<br>";
    placeCaret(inner, false);
    return inner;
  }

  var MD_SHORTCUTS = [
    [/^[*+-]$/, "UL"],
    [/^(\d+)[.)]$/, "OL"],
    [/^#$/, "H1"],
    [/^##$/, "H2"],
    [/^###$/, "H3"],
    [/^>$/, "BLOCKQUOTE"],
  ];

  // "* ", "1. ", "## ", "> " typed at the start of a paragraph make it that block.
  function markdownShortcut(e) {
    if (e.inputType !== "insertText" || e.data !== " ") return false;
    var r = currentRange();
    var block = caretBlock();
    if (!r || !r.collapsed || !block || block.tagName !== "P" || block.parentElement !== regionOf(block)) return false;
    var head = document.createRange();
    head.setStart(block, 0);
    head.setEnd(r.startContainer, r.startOffset);
    var typed = String(head).replace(/\u00a0/g, " ");
    if (typed.slice(-1) !== " ") return false;
    var marker = typed.slice(0, -1);
    for (var i = 0; i < MD_SHORTCUTS.length; i++) {
      var m = MD_SHORTCUTS[i][0].exec(marker);
      if (!m) continue;
      // Undo first gives back the typed "1. ", then the text before it.
      noteChange("type");
      var kind = MD_SHORTCUTS[i][1];
      var region = regionOf(block);
      mutate(function () {
        head.deleteContents();
        convertBlock(block, kind, m[1] ? Number(m[1]) : 1);
        tidyRegion(region, false);
      });
      return true;
    }
    return false;
  }

  // A click in the page's margins or below the last line puts the caret on the nearest
  // line, like a text editor, instead of leaving the page unfocused.
  function onBlankMouseDown(e) {
    if (!editing || page.readOnly || e.button !== 0 || e.shiftKey) return;
    if (e.target !== document.body && e.target !== document.documentElement) return;
    var live = regions.filter(function (r) { return r.el.isConnected && r.el.style.display !== "none"; });
    if (!live.length) return;
    var y = e.clientY;
    var best = null;
    var dist = Infinity;
    live.forEach(function (r) {
      var rect = r.el.getBoundingClientRect();
      var d = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      if (d < dist) { dist = d; best = { el: r.el, rect: rect }; }
    });
    e.preventDefault();
    var region = best.el;
    region.focus({ preventScroll: true });
    if (y > best.rect.bottom) {
      var last = region.lastElementChild;
      if (!last || !/^(P|H[1-6]|UL|OL|BLOCKQUOTE|PRE)$/.test(last.tagName)) {
        last = document.createElement("p");
        last.innerHTML = "<br>";
        region.appendChild(last);
      }
      // Into the last item of a list (or quote), not after it.
      while (/^(UL|OL|LI|BLOCKQUOTE)$/.test(last.tagName) && last.lastElementChild && /^(UL|OL|LI|P|BLOCKQUOTE)$/.test(last.lastElementChild.tagName)) last = last.lastElementChild;
      placeCaret(last, true);
      return;
    }
    if (y < best.rect.top) { placeCaret(region.firstElementChild || region, false); return; }
    var x = Math.max(best.rect.left + 2, Math.min(e.clientX, best.rect.right - 2));
    var at = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (at && regionOf(at.startContainer) === region) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(at);
    } else {
      placeCaret(region, true);
    }
  }

  // A new or empty page opens with the caret in it, ready to type (under the title if
  // that's all there is).
  function focusIfBlank() {
    if (!regions.length || document.querySelector("[data-q-atomic]")) return;
    var text = regions.map(function (r) { return r.el.textContent; }).join("").trim();
    var title = regions[0].el.querySelector("h1");
    if (text && !(title && text === title.textContent.trim())) return;
    var region = regions[regions.length - 1].el;
    var last = region.lastElementChild;
    if (last && title && last === title) {
      last = document.createElement("p");
      last.innerHTML = "<br>";
      region.appendChild(last);
    }
    try { window.focus(); } catch (e) { /* not allowed */ }
    region.focus({ preventScroll: true });
    placeCaret(last || region, true);
  }

  /* ---- toolbar */

  var savedRange = null;

  function onSelectionChange() {
    if (!editing || !ui) return;
    updatePlaceholder();
    if (document.activeElement === ui.linkInput || document.activeElement === ui.slashSearch) return;
    var sel = window.getSelection();
    var region = selectionRegion();
    if (!region || !sel || sel.isCollapsed || !String(sel).trim()) {
      hideToolbar();
    } else {
      showToolbar();
    }
    syncSlashToken();
  }

  function showToolbar() {
    if (nativeEditorHost()) return; // the phone's keyboard bar replaces it
    ui.toolbar.hidden = false;
    closeLinkInput(false);
    refreshToolbarState();
    positionToolbar();
  }

  function hideToolbar() {
    if (!ui) return;
    ui.toolbar.hidden = true;
    ui.linkForm.hidden = true;
    ui.buttons.style.display = "contents";
  }

  function positionToolbar() {
    var range = savedRange && !ui.linkForm.hidden ? savedRange : currentRange();
    if (!range) return;
    var rect = rangeRect(range);
    if (!rect) return;
    var tb = ui.toolbar;
    var w = tb.offsetWidth;
    var h = tb.offsetHeight;
    var left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    var top = rect.top - h - 10;
    if (top < 8) top = rect.bottom + 10;
    tb.style.left = Math.round(left) + "px";
    tb.style.top = Math.round(top) + "px";
  }

  function blockTagAtSelection() {
    var r = currentRange();
    if (!r) return "";
    var node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    var b = node && node.closest("h1,h2,h3,h4,p,li,blockquote,pre");
    return b ? b.tagName : "";
  }

  function inList(tag) {
    var r = currentRange();
    if (!r) return false;
    var node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    var l = node && node.closest("ul,ol");
    return !!(l && l.tagName === tag && regionOf(l));
  }

  function refreshToolbarState() {
    var set = function (cmd, on) {
      var b = ui.buttons.querySelector('[data-cmd="' + cmd + '"]');
      if (b) b.setAttribute("aria-pressed", on ? "true" : "false");
    };
    var q = function (c) { try { return document.queryCommandState(c); } catch (e) { return false; } };
    set("bold", q("bold"));
    set("italic", q("italic"));
    set("link", !!linkAtSelection());
    var tag = blockTagAtSelection();
    set("h2", tag === "H2");
    set("h3", tag === "H3");
    set("bullets", inList("UL"));
  }

  function linkAtSelection() {
    var r = currentRange();
    if (!r) return null;
    var node = r.commonAncestorContainer;
    node = node.nodeType === 1 ? node : node.parentElement;
    var a = node && node.closest("a");
    return a && regionOf(a) ? a : null;
  }

  function exec(cmd, value) {
    try { document.execCommand(cmd, false, value == null ? null : value); } catch (e) { /* ignore */ }
  }

  function runToolbarCommand(cmd) {
    if (!selectionRegion()) return;
    if (cmd === "link") { openLinkInput(); return; }
    mutate(function () {
      switch (cmd) {
        case "bold": exec("bold"); break;
        case "italic": exec("italic"); break;
        case "h2": exec("formatBlock", blockTagAtSelection() === "H2" ? "<p>" : "<h2>"); break;
        case "h3": exec("formatBlock", blockTagAtSelection() === "H3" ? "<p>" : "<h3>"); break;
        case "bullets": exec("insertUnorderedList"); break;
      }
      var region = selectionRegion();
      if (region) { unnestParagraphs(region); tidyRegion(region, false); }
    });
    refreshToolbarState();
    positionToolbar();
  }

  function openLinkInput() {
    var r = currentRange();
    if (!r) return;
    savedRange = r.cloneRange();
    var a = linkAtSelection();
    ui.linkInput.value = a ? a.getAttribute("href") || "" : "";
    ensureSlashPages(); // so a page name typed here resolves at once
    ui.buttons.style.display = "none";
    ui.linkForm.hidden = false;
    positionToolbar();
    ui.linkInput.focus();
    ui.linkInput.select();
  }

  function closeLinkInput(restore) {
    if (!ui || ui.linkForm.hidden) return;
    ui.linkForm.hidden = true;
    ui.buttons.style.display = "contents";
    if (restore && savedRange) {
      var region = regionOf(savedRange.startContainer);
      if (region) region.focus();
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    savedRange = null;
  }

  function normalizeUrl(v) {
    v = String(v || "").trim();
    if (!v) return "";
    if (/^(https?:|mailto:|tel:|quire:|#|\/|\.)/i.test(v)) return v;
    if (/^[^\s]+@[^\s]+\.[^\s]+$/.test(v)) return "mailto:" + v;
    if (/^[\w-]+(\.[\w-]+)+(\/|$|\?|#|:)/.test(v)) return "https://" + v;
    return v;
  }

  // A page's exact name, typed in the link field, links to that page. Anything that says it is a
  // URL stays one.
  var URLISH = /^(https?:|mailto:|tel:|quire:|#|\/|\.)/i;
  function pageHrefForName(name) {
    var node = matchPageByName(flatten(slashState.pages || []), name);
    return node ? pageLinkHref(pagePath(), node.path) : "";
  }

  function applyLink(value) {
    var range = savedRange;
    var url = normalizeUrl(value);
    closeLinkInput(true);
    if (!range) return;
    var go = function (href) {
      mutate(function () {
        if (href) exec("createLink", href);
        else exec("unlink");
      });
      hideToolbar();
    };
    var name = String(value || "").trim();
    if (!name || URLISH.test(name)) { go(url); return; }
    if (slashState.pages != null) { go(pageHrefForName(name) || url); return; }
    ensureSlashPages().then(function () {
      var region = regionOf(range.startContainer);
      if (!region) return;
      region.focus({ preventScroll: true });
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      go(pageHrefForName(name) || url);
    });
  }

  /* ---- placeholder on the empty focused block */

  var phEl = null;
  function clearPlaceholder() {
    if (phEl) { phEl.removeAttribute("data-q-ph"); phEl = null; }
  }
  function updatePlaceholder() {
    var block = editing ? caretBlock() : null;
    var empty = block && !block.textContent && !block.querySelector("img,hr,quire-embed,iframe");
    // The AI line draws its own placeholder.
    var target = empty && !block.hasAttribute("data-q-ai-line") && (block.tagName === "P" || /^H[1-4]$/.test(block.tagName)) ? block : null;
    if (target === phEl) return;
    clearPlaceholder();
    if (target) {
      var label = target.tagName === "P" ? (nativeEditorHost() ? "Write something" : "Type / for blocks") : target.tagName === "H1" ? "Title" : "Heading";
      target.setAttribute("data-q-ph", label);
      phEl = target;
    }
  }

  /* ---- input plumbing */

  function onBeforeInput(e) {
    var region = regionOf(e.target);
    if (!editing || !region) return;
    // Edit menu or context menu undo: ours, never the browser's (it doesn't know our changes).
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      if (Date.now() - hist.keyAt < 150) return; // the keydown already did it
      if (e.inputType === "historyUndo") undo();
      else redo();
      return;
    }
    if (!hist.busy) hist.pre = caretRec();
    if (/^delete/.test(e.inputType || "")) markEmptyItems(region);
    // Keep text inside a block: an emptied region gets a fresh <p> before typing lands.
    if (!region.firstElementChild && !region.textContent.trim() && /^insert/.test(e.inputType || "")) {
      region.innerHTML = "<p><br></p>";
      placeCaret(region.firstChild, false);
    }
  }

  function inputKind(e) {
    var t = e.inputType || "";
    if (/^insert(Text|CompositionText|ReplacementText)$/.test(t)) return "type";
    if (/^delete(Content|Word|SoftLine|HardLine)/.test(t)) return "delete";
    return "op";
  }

  function onInput(e) {
    var region = regionOf(e.target);
    if (!editing || !region) return;
    var kind = inputKind(e);
    if (!markdownShortcut(e) && !e.isComposing) {
      unnestParagraphs(region);
      tidyRegion(region, kind === "delete");
    }
    aiLinesRefresh(region);
    scheduleSave(kind);
    // A space ends the word: the next one is a new undo step.
    if (kind === "type" && /\s/.test(e.data || "") && hist.kind === "type") hist.kind = "type-end";
    if (aiLineFromInput(e)) closeSlash();
    else updateSlashFromInput(e);
    updatePlaceholder();
  }

  // Paste in: clipboard HTML is cut down to the editor's tags, plain text becomes paragraphs
  // (or blocks, when it's markdown). One undo step either way.
  function onPaste(e) {
    var region = regionOf(e.target);
    if (!editing || !region) return;
    var cd = e.clipboardData;
    if (!cd) return;
    var text = cd.getData("text/plain");
    var html = cd.getData("text/html");
    if (!text && !html) return; // files and images: the browser's own paste
    e.preventDefault();
    var block = caretBlock();
    var url = pastedUrl(text, html);
    if (url && !(block && block.closest("pre"))) {
      // A bare link: over a selection it links the selection, else it goes in as a link.
      var sel = window.getSelection();
      mutate(function () {
        if (sel && !sel.isCollapsed && String(sel).trim()) exec("createLink", url);
        else exec("insertHTML", '<a href="' + escapeAttr(url) + '">' + escapeText(url) + "</a>");
      });
      updatePlaceholder();
      return;
    }
    var plan = block && block.closest("pre") ? { text: text || htmlToPlain(sanitizeHtml(html)) } : pastePlan(html, text);
    mutate(function () {
      if (plan.html) exec("insertHTML", plan.html);
      else if (plan.text) exec("insertText", plan.text);
      var r = currentRange();
      var at = (r && regionOf(r.startContainer)) || region;
      unnestParagraphs(at);
      tidyRegion(at, false);
    });
    updatePlaceholder();
  }

  /**
   * The URL when the clipboard holds just one (an address bar copy, or a copied link whose text
   * is the URL itself), else null. Only schemes safeHref allows.
   */
  function pastedUrl(text, html) {
    var t = String(text || "").trim();
    if (!t || /\s/.test(t) || !/^(https?:\/\/|mailto:)\S+$/i.test(t) || !safeHref(t)) return null;
    if (html) {
      var plain = htmlToPlain(sanitizeHtml(html)).trim();
      if (plain && plain !== t) return null; // rich content that merely contains the URL
    }
    return t;
  }

  // Copy out: clean tags as text/html, readable text (list markers kept) as text/plain.
  function clipboardFor(range) {
    var box = document.createElement("div");
    box.appendChild(range.cloneContents());
    if (box.querySelector("[data-app]")) return null;
    cleanTree(box);
    var anc = range.commonAncestorContainer;
    anc = anc.nodeType === 1 ? anc : anc.parentElement;
    var list = anc && anc.closest("ul,ol");
    if (list && Array.prototype.some.call(box.children, function (c) { return c.tagName === "LI"; })) {
      // Items from inside one list: copy them as that list, numbered from where they start.
      var wrap = list.cloneNode(false);
      if (list.tagName === "OL") {
        var first = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        while (first && first.parentElement !== list) first = first.parentElement;
        var n = Number(list.getAttribute("start")) || 1;
        for (var c = first && first.previousElementSibling; c; c = c.previousElementSibling) if (c.tagName === "LI") n++;
        if (n > 1) wrap.setAttribute("start", String(n));
        else wrap.removeAttribute("start");
      }
      while (box.firstChild) wrap.appendChild(box.firstChild);
      box.appendChild(wrap);
    } else {
      // Part of one line: keep the bold/italic/link it sits in.
      for (var a = anc; a && a !== document.body && !a.hasAttribute("data-q-region") && !BLOCKS[a.tagName]; a = a.parentElement) {
        if (!/^(B|STRONG|I|EM|CODE|A)$/.test(a.tagName)) continue;
        var w = a.cloneNode(false);
        while (box.firstChild) w.appendChild(box.firstChild);
        box.appendChild(w);
      }
    }
    var clean = sanitizeHtml(box.innerHTML);
    return { html: clean, text: htmlToPlain(clean) };
  }

  function onCopy(e) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return false;
    var r = sel.getRangeAt(0);
    var t = r.commonAncestorContainer;
    t = t.nodeType === 1 ? t : t.parentElement;
    if (!t || t.closest("input,textarea,select,[data-app],[data-q-ui],[data-q-atomic],quire-embed")) return false;
    if (editing && !selectionRegion()) return false;
    var c = clipboardFor(r);
    if (!c || (!c.text.trim() && !/<img/i.test(c.html))) return false;
    e.clipboardData.setData("text/html", c.html);
    e.clipboardData.setData("text/plain", c.text);
    e.preventDefault();
    return true;
  }

  function onCut(e) {
    if (!editing || page.readOnly || !selectionRegion()) return;
    if (!onCopy(e)) return;
    markEmptyItems(selectionRegion());
    mutate(function () {
      if (!deleteAcrossItems()) exec("delete");
      var r = currentRange();
      if (r && regionOf(r.startContainer)) tidyRegion(regionOf(r.startContainer), true);
    });
    updatePlaceholder();
  }

  function onKeyDown(e) {
    if (!editing || e.__qAiLine) return;
    var mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && (e.key === "z" || e.key === "Z" || (e.ctrlKey && !e.metaKey && (e.key === "y" || e.key === "Y")))) {
      // Inputs inside app blocks keep their own undo.
      var tg = e.target;
      if (regionOf(tg) || tg === document.body || tg === document.documentElement) {
        e.preventDefault();
        hist.keyAt = Date.now();
        if (e.shiftKey || e.key === "y" || e.key === "Y") redo();
        else undo();
        return;
      }
    }
    if (slashState.open) {
      var n = slashState.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (n) { slashState.active = (slashState.active + 1) % n; renderSlashSelection(true); }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (n) { slashState.active = (slashState.active - 1 + n) % n; renderSlashSelection(true); }
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (n) {
          e.preventDefault();
          chooseSlash(slashState.active);
          return;
        }
        closeSlash();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (slashState.mode === "pages" && !slashState.typed) leaveSlashSearch();
        else closeSlash(); // the typed "/query" or "[[query" stays as text
        return;
      }
    }
    if (!regionOf(e.target)) return;
    if (e.key === "Escape" && ui && !ui.toolbar.hidden) { hideToolbar(); return; }
    // Tab stays in the editor: it nests list items (Shift-Tab un-nests) and indents code.
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      var item = caretItem();
      if (item) {
        mutate(function () {
          if (e.shiftKey) outdentItem(item);
          else indentItem(item);
          tidyRegion(regionOf(item), false);
        });
      } else if (!e.shiftKey) {
        var cb = caretBlock();
        if (cb && cb.closest("pre")) exec("insertText", "\t");
      }
      return;
    }
    // A quote is one block: ↵ ends it and the next line is plain text (⇧↵ stays in the quote), and
    // Backspace at its start takes the quote off the line instead of joining the line above.
    var bq = !mod && !e.altKey ? caretQuote() : null;
    if (bq && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      exec("insertParagraph");
      exec("formatBlock", "<p>");
      updatePlaceholder();
      return;
    }
    if (bq && e.key === "Backspace" && !e.shiftKey && caretAtQuoteStart(bq)) {
      e.preventDefault();
      exec("formatBlock", "<p>");
      updatePlaceholder();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      var s0 = window.getSelection();
      if (s0 && !s0.isCollapsed) {
        if (deleteAcrossItems()) { e.preventDefault(); updatePlaceholder(); return; }
      } else if (!mod && !e.altKey && !e.shiftKey) {
        var li = caretItem();
        var region = li && regionOf(li);
        // Backspace at the start of an item: a nested one moves out a level, any other joins
        // the line above (one list, numbering intact); the very first becomes a paragraph.
        if (li && e.key === "Backspace" && caretAtStart(li)) {
          e.preventDefault();
          mutate(function () {
            if (!outdentItem(li) && !joinItemUp(li)) itemToParagraph(li);
            tidyRegion(region, false);
          });
          updatePlaceholder();
          return;
        }
        // Delete at the end of an item's line pulls the line below up into it.
        var below = li && e.key === "Delete" && caretAtLineEnd(li) ? lineBelow(li) : null;
        if (below) {
          e.preventDefault();
          mutate(function () {
            joinItemUp(below);
            tidyRegion(region, false);
          });
          updatePlaceholder();
          return;
        }
      }
    }
    if (mod && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed && selectionRegion()) {
        e.preventDefault();
        showToolbar();
        openLinkInput();
      }
    }
  }

  // The caret is at the very start of the quote: nothing before it, not even a line break.
  function caretAtQuoteStart(q) {
    var r = currentRange();
    if (!r || !r.collapsed || !q.contains(r.startContainer)) return false;
    var head = document.createRange();
    head.setStart(q, 0);
    head.setEnd(r.startContainer, r.startOffset);
    return !String(head).replace(/[\u200b\ufeff]/g, "") && !head.cloneContents().querySelector("br,img");
  }

  // The blockquote the caret is in (not one inside a list item or code).
  function caretQuote() {
    var b = caretBlock();
    var q = b && b.closest("blockquote");
    return q && regionOf(q) && !q.closest("li,pre") ? q : null;
  }

  /* ------------------------------------------------------------------ slash menu */

  var BLOCK_ITEMS = [
    { id: "text", label: "Text", hint: "Plain paragraph", icon: "text", keys: "text paragraph p" },
    { id: "h2", label: "Heading", hint: "Section heading", icon: "h2", keys: "heading h2 title" },
    { id: "h3", label: "Subheading", hint: "Smaller heading", icon: "h3", keys: "subheading h3" },
    { id: "ul", label: "Bullet list", hint: "Simple bulleted list", icon: "bullets", keys: "bullet list ul unordered" },
    { id: "ol", label: "Numbered list", hint: "List with numbers", icon: "numbered", keys: "numbered list ol ordered" },
    { id: "quote", label: "Quote", hint: "Indented quotation", icon: "quote", keys: "quote blockquote" },
    { id: "code", label: "Code", hint: "Monospace block", icon: "code", keys: "code pre snippet" },
    { id: "hr", label: "Divider", hint: "Horizontal rule", icon: "divider", keys: "divider hr rule line separator" },
    { id: "embed", label: "Embed page…", hint: "Show another page here", icon: "embed", keys: "embed page app" },
    { id: "pagelink", label: "Link to page", hint: "Link to another page", icon: "link", keys: "link page wiki" },
  ];

  // kind/start/range: the "/query" or "[[query" in the text, a live Range so nothing is marked in
  // the page. whole: that token is all the block holds. pick: what a page picker does with its
  // choice ("embed" or "link"). typed: the picker filters from the text, not its search field.
  var slashState = { open: false, mode: "blocks", block: null, query: "", items: [], active: 0, pages: null, pagesLoading: null, kind: null, start: 0, range: null, whole: false, pick: null, typed: false };

  function blockText(block) { return (block.textContent || "").replace(/​/g, ""); }

  // The text of `block` up to the caret, and where each piece of it lives. A <br> or an image is
  // a line break here, so "/" right after one counts as the start of text.
  function textBeforeCaret(block, r) {
    var text = "";
    var map = [];
    var done = false;
    (function walk(p) {
      var i = 0;
      for (var n = p.firstChild; n && !done; n = n.nextSibling, i++) {
        if (p === r.startContainer && i === r.startOffset) { done = true; return; }
        if (n.nodeType === 3) {
          var v = n === r.startContainer ? n.nodeValue.slice(0, r.startOffset) : n.nodeValue;
          map.push({ node: n, at: text.length, len: v.length });
          text += v;
          if (n === r.startContainer) done = true;
        } else if (n.nodeType === 1 && !isUi(n)) {
          if (n.tagName === "BR" || n.matches(SOLID_SEL)) text += "\n";
          else walk(n);
        }
      }
      if (p === r.startContainer) done = true;
    })(block);
    return { text: text, map: map };
  }

  function rangeOfText(map, start, end) {
    var range = document.createRange();
    var from = null;
    var to = null;
    map.forEach(function (m) {
      if (!from && m.at <= start && start < m.at + m.len) from = m;
      if (m.at < end && end <= m.at + m.len) to = m;
    });
    if (!from || !to) return null;
    range.setStart(from.node, start - from.at);
    range.setEnd(to.node, end - to.at);
    return range;
  }

  function tokenIsWhole(block, range) {
    var before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(range.startContainer, range.startOffset);
    var after = document.createRange();
    after.selectNodeContents(block);
    after.setStart(range.endContainer, range.endOffset);
    return [before, after].every(function (x) {
      return inkless(String(x)) && !x.cloneContents().querySelector(SOLID_SEL);
    });
  }

  function tokenAtCaret(block) {
    var r = currentRange();
    if (!r || !r.collapsed) return null;
    var ctx = textBeforeCaret(block, r);
    var tok = findEditorToken(ctx.text, ctx.text.length);
    var range = tok && rangeOfText(ctx.map, tok.start, tok.end);
    if (!range) return null;
    tok.range = range;
    tok.whole = tokenIsWhole(block, range);
    return tok;
  }

  // Code is full of "/" and "[[": only "/" alone on an empty line opens anything there.
  function tokenMayOpen(block, tok) {
    if (block.closest("[data-q-ai],[data-q-ai-line],[data-q-ui]")) return false;
    var inCode = block.closest("pre") || tok.range.startContainer.parentElement.closest("code");
    return !inCode || (tok.kind === "slash" && tok.whole);
  }

  function updateSlashFromInput(e) {
    var block = caretBlock();
    if (!block) { closeSlash(); return; }
    if (slashState.open) { syncSlashToken(); return; }
    // Only the keystroke opens it: Esc means it stays shut for the rest of that token.
    if (e.isComposing || (e.data !== "/" && e.data !== "[")) return;
    var tok = tokenAtCaret(block);
    if (!tok || tok.query || tok.kind !== (e.data === "/" ? "slash" : "link") || !tokenMayOpen(block, tok)) return;
    openSlash(block, tok);
  }

  /** After an edit or a caret move: follow the token, or close when the caret has left it. */
  function syncSlashToken() {
    if (!slashState.open || (slashState.mode === "pages" && !slashState.typed)) return;
    var block = caretBlock();
    var tok = block && block === slashState.block ? tokenAtCaret(block) : null;
    if (!tok || tok.kind !== slashState.kind || tok.start !== slashState.start) { closeSlash(); return; }
    slashState.range = tok.range;
    slashState.whole = tok.whole;
    if (tok.query === slashState.query) return;
    slashState.query = tok.query;
    slashState.active = 0;
    renderSlash();
    // "/ai " never gets here at the start of a line: the space makes the AI line.
    var loaded = slashState.mode !== "pages" || slashState.pages != null;
    if (loaded && !slashState.items.length && /\s/.test(tok.query)) closeSlash();
  }

  function openSlash(block, tok) {
    if (nativeEditorHost()) return; // the phone's insert sheet replaces it
    var link = tok.kind === "link";
    slashState.open = true;
    slashState.mode = link ? "pages" : "blocks";
    slashState.pick = link ? "link" : null;
    slashState.typed = link;
    slashState.above = null;
    slashState.block = block;
    slashState.kind = tok.kind;
    slashState.start = tok.start;
    slashState.range = tok.range;
    slashState.whole = tok.whole;
    slashState.query = "";
    slashState.active = 0;
    if (link) ensureSlashPages();
    hideToolbar();
    renderSlash();
    ui.slash.hidden = false;
    positionSlash();
  }

  function closeSlash() {
    slashState.open = false;
    slashState.block = null;
    slashState.mode = "blocks";
    slashState.kind = null;
    slashState.range = null;
    slashState.pick = null;
    slashState.typed = false;
    if (ui) {
      if (document.activeElement === ui.slashSearch) ui.slashSearch.blur();
      ui.slashSearch.hidden = true;
      ui.slash.hidden = true;
    }
  }

  function caretToEndOf(range) {
    var at = range.cloneRange();
    at.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(at);
  }

  /** Esc in the page search: close the picker and put the caret back after the token. */
  function leaveSlashSearch() {
    var block = slashState.block;
    var range = slashState.range;
    closeSlash();
    if (!block || !block.isConnected) return;
    var region = regionOf(block);
    if (region) region.focus({ preventScroll: true });
    if (range) caretToEndOf(range);
    else placeCaret(block, false);
  }

  function ensureSlashPages() {
    if (slashState.pages != null) return Promise.resolve(slashState.pages);
    if (slashState.pagesLoading) return slashState.pagesLoading;
    var done = function (tree) {
      slashState.pages = tree || [];
      slashState.pagesLoading = null;
      if (slashState.open && slashState.mode === "pages") renderSlash();
      return slashState.pages;
    };
    slashState.pagesLoading = pages().then(done, function () { return done([]); });
    return slashState.pagesLoading;
  }

  /** From the block menu: the page picker with its own search field. */
  function openPagePicker(pick) {
    slashState.mode = "pages";
    slashState.pick = pick;
    slashState.typed = false;
    slashState.query = "";
    slashState.active = 0;
    ui.slashSearch.value = "";
    ui.slashSearch.setAttribute("aria-label", pick === "link" ? "Search pages to link to" : "Search pages to embed");
    renderSlash();
    ui.slashSearch.focus({ preventScroll: true });
    ensureSlashPages();
  }

  function matches(item, q) {
    q = q.trim().toLowerCase();
    if (!q) return true;
    var hay = (item.label + " " + (item.keys || "") + " " + (item.hint || "")).toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  /* Page picker: every page in every folder, built once per open, ranked per keystroke. */
  var SLASH_PAGE_LIMIT = 60;

  function pageCandidates() {
    if (slashState.pageItems && slashState.pageItemsFor === slashState.pages) return slashState.pageItems;
    var me = pagePath();
    var items = flatten(slashState.pages || [])
      .filter(function (n) { return n.kind !== "folder" && n.path && n.path !== me && !n.searchExcluded; })
      .map(function (n) {
        var parts = n.path.split("/");
        var label = n.title || parts[parts.length - 1];
        var folder = parts.slice(0, -1).join(" / ");
        return {
          id: "page", node: n, label: label, hint: folder, icon: "page",
          _title: label.toLowerCase(), _path: n.path.toLowerCase(),
        };
      });
    items.sort(function (a, b) { return a._title < b._title ? -1 : a._title > b._title ? 1 : 0; });
    slashState.pageItems = items;
    slashState.pageItemsFor = slashState.pages;
    return items;
  }

  // Higher is better; -1 is no match. Substring beats fuzzy; title beats folder path.
  function scoreText(hay, w) {
    var at = hay.indexOf(w);
    if (at === 0) return 100;
    if (at > 0) return /[\s\/_\-.]/.test(hay.charAt(at - 1)) ? 80 : 60 - Math.min(at, 20);
    // Fuzzy: every letter in order; tighter spans score more.
    var first = -1, j = 0;
    for (var i = 0; i < hay.length && j < w.length; i++) {
      if (hay.charAt(i) === w.charAt(j)) { if (first < 0) first = i; j++; }
      if (j === w.length) return Math.max(1, 30 - (i - first - w.length));
    }
    return -1;
  }

  function scorePage(it, words) {
    var total = 0;
    for (var k = 0; k < words.length; k++) {
      var t = scoreText(it._title, words[k]);
      var p = scoreText(it._path, words[k]);
      var s = Math.max(t >= 0 ? t + 20 : -1, p);
      if (s < 0) return -1;
      total += s;
    }
    return total;
  }

  function slashPageItems(q) {
    var all = pageCandidates();
    // A link goes to a page; a plain file has no page to open.
    if (slashState.pick === "link") all = all.filter(function (it) { return it.node.kind !== "file"; });
    var words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return all.slice(0, SLASH_PAGE_LIMIT);
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var s = scorePage(all[i], words);
      if (s >= 0) hits.push({ it: all[i], s: s, i: i });
    }
    hits.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
    return hits.slice(0, SLASH_PAGE_LIMIT).map(function (h) { return h.it; });
  }

  function slashItems() {
    if (slashState.mode === "pages") return slashPageItems(slashState.query);
    var q = slashState.query;
    var blocks = BLOCK_ITEMS.filter(function (it) { return matches(it, q); });
    if (!aiInSlash()) return blocks;
    // One AI item, "Ask AI" (docs/ai.md). First for "/ai…"; last when the query fits it; a query
    // nothing else matches: Ask AI with all of it as the request.
    var m = /^\s*ai(?:\s+([\s\S]*))?$/i.exec(q);
    if (m) return [aiSlashItem(m[1] || "")].concat(blocks);
    if (matches(AI_ITEM, q)) return blocks.concat([aiSlashItem("")]);
    // Mid-line the words after a "/" are usually just text: no catch-all there.
    if (!blocks.length && q.trim() && slashState.whole) return [aiSlashItem(q)];
    return blocks;
  }

  var AI_ITEM = { label: "Ask AI", keys: "ai ask build make generate" };
  function aiSlashItem(prompt) {
    prompt = String(prompt).replace(/\s+/g, " ").trim();
    return { id: "ai", prompt: prompt, group: "AI", label: "Ask AI", hint: prompt ? "“" + prompt + "”" : "", icon: "ai", keyFixed: "space ↵" };
  }

  function renderSlash() {
    var box = ui.slashList;
    var items = slashItems();
    slashState.items = items;
    if (slashState.active >= items.length) slashState.active = 0;
    box.innerHTML = "";
    var pagesHead = slashState.pick === "link" ? "Link to a page" : "Embed a page";
    var group = slashState.mode === "pages" ? pagesHead : (items[0] && items[0].group) || "Blocks";
    ui.slashHead.textContent = group;
    ui.slashSearch.hidden = slashState.mode !== "pages" || slashState.typed;
    if (slashState.mode === "pages" && slashState.pages == null) {
      box.appendChild(el("div", { class: "q-slash-empty" }, "Loading pages…"));
    } else if (!items.length) {
      box.appendChild(el("div", { class: "q-slash-empty" }, slashState.mode === "pages" ? "No pages match" : "No blocks match"));
    }
    items.forEach(function (it, i) {
      var g = slashState.mode === "pages" ? group : it.group || "Blocks";
      if (g !== group) {
        group = g;
        var gh = el("div", { class: "q-slash-group" });
        gh.textContent = g;
        box.appendChild(gh);
      }
      var row = el("div", { class: it.id === "page" ? "q-slash-item q-slash-page" : it.group === "AI" ? "q-slash-item q-slash-ai" : "q-slash-item", role: "option", "data-index": String(i), "aria-selected": "false" });
      if (it.keyAlt) row.setAttribute("data-key-alt", it.keyAlt);
      if (it.keyFixed) row.setAttribute("data-key-fixed", it.keyFixed);
      row.appendChild(el("span", { class: "q-slash-icon", "aria-hidden": "true" }, ICONS[it.icon] || ""));
      var txt = el("span", { class: "q-slash-text" });
      var label = el("span", { class: "q-slash-label" });
      label.textContent = it.label;
      txt.appendChild(label);
      if (it.hint) {
        var hint = el("span", { class: "q-slash-hint" });
        hint.textContent = it.hint;
        txt.appendChild(hint);
      }
      row.appendChild(txt);
      row.appendChild(el("span", { class: "q-slash-key", "aria-hidden": "true" }, it.keyFixed || (i === slashState.active ? "↵" : it.keyAlt || "")));
      box.appendChild(row);
    });
    renderSlashSelection(false);
    if (slashState.open) positionSlash();
  }

  function renderSlashSelection(scroll) {
    var rows = ui.slash.querySelectorAll(".q-slash-item");
    Array.prototype.forEach.call(rows, function (row, i) {
      var on = i === slashState.active;
      row.setAttribute("aria-selected", on ? "true" : "false");
      var key = row.querySelector(".q-slash-key");
      if (key) key.textContent = row.getAttribute("data-key-fixed") || (on ? "↵" : row.getAttribute("data-key-alt") || "");
      if (on && scroll) row.scrollIntoView({ block: "nearest" });
    });
  }

  function positionSlash() {
    // Anchor to the token itself: it holds still as the query grows, and once the page search
    // has focus there's no caret in the text.
    var r = slashState.range || (document.activeElement === ui.slashSearch ? null : currentRange());
    var rect = r ? rangeRect(r) : null;
    if (!rect && slashState.block) rect = slashState.block.getBoundingClientRect();
    if (!rect) return;
    var box = ui.slash;
    var w = box.offsetWidth || 320;
    // Pick above or below once per open, sized for the tallest the menu gets (its max-height),
    // so it doesn't jump sides as typing changes how many rows it has.
    if (slashState.above == null) {
      var maxH = parseFloat(getComputedStyle(box).maxHeight) || 340;
      slashState.above = rect.bottom + 6 + maxH > window.innerHeight - 8 && rect.top - maxH - 6 > 8;
    }
    var h = box.offsetHeight || 200;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    var top = slashState.above ? rect.top - h - 6 : rect.bottom + 6;
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(Math.max(8, top)) + "px";
  }

  function chooseSlash(index) {
    var item = slashState.items[index];
    var block = slashState.block;
    if (!item || !block || !block.isConnected) { closeSlash(); return; }

    if (item.id === "embed" || item.id === "pagelink") {
      openPagePicker(item.id === "embed" ? "embed" : "link");
      return;
    }

    var range = slashState.range;
    var whole = slashState.whole;
    var pick = slashState.pick;
    var fromSearch = document.activeElement === ui.slashSearch;
    closeSlash();
    if (fromSearch) {
      // Focus left the page for the search field; give the text region its focus back first.
      var region = regionOf(block);
      if (region) region.focus({ preventScroll: true });
      if (range) caretToEndOf(range);
    }

    if (pick === "link") {
      mutate(function () { insertPageLink(item.node, item.label, block, range); });
      updatePlaceholder();
      return;
    }

    // The token is the whole block: the block turns into the item. Otherwise the rest of the
    // line stays and the item goes in a new block after it.
    mutate(function () {
      var at = whole || !range ? block : emptyBlockAfter(block, range);
      if (item.id === "ai") {
        // The line becomes the AI line: the pill, then the request (sent with ↵ from there).
        aiLineMake(at, item.prompt);
        return null;
      }
      return insertSlashItem(item, at);
    });
    updatePlaceholder();
  }

  /** Removes the token and opens an empty paragraph, caret in it, after the block's top-level
   * parent (a list or table stays in one piece). */
  function emptyBlockAfter(block, range) {
    range.deleteContents();
    var region = regionOf(block);
    var top = block;
    while (top.parentElement !== region) top = top.parentElement;
    var p = document.createElement("p");
    p.innerHTML = "<br>";
    region.insertBefore(p, top.nextSibling);
    placeCaret(p, false);
    return p;
  }

  /** Replaces the token with a link to `node`, caret after it and outside it. Inside mutate(). */
  function insertPageLink(node, label, block, range) {
    if (!range || !block.isConnected) return;
    range.deleteContents();
    var around = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    var outer = around && around.closest("a");
    if (outer && block.contains(outer)) { range.setStartAfter(outer); range.collapse(true); }
    var a = document.createElement("a");
    a.setAttribute("href", pageLinkHref(pagePath(), node.path));
    a.textContent = label;
    range.insertNode(a);
    // Text typed right against a link joins it, so the caret lands past a space.
    var next = a.nextSibling;
    while (next && next.nodeType === 3 && !next.nodeValue) next = next.nextSibling;
    var caretNode;
    var caretAt;
    if (next && next.nodeType === 3 && /^[\s\u00a0]/.test(next.nodeValue)) {
      caretNode = next;
      caretAt = 1;
    } else {
      // A plain space at the end of a line draws nothing and the caret would sit in the link.
      caretNode = document.createTextNode(next && next.nodeName !== "BR" ? " " : "\u00a0");
      caretAt = 1;
      a.parentNode.insertBefore(caretNode, a.nextSibling);
    }
    var at = document.createRange();
    at.setStart(caretNode, caretAt);
    at.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(at);
    tidyRegion(regionOf(block), false);
  }

  function insertSlashItem(item, block) {
    var made = null;
    // Clear the "/query" text, leaving an empty block with the caret in it.
    block.removeAttribute("data-q-ai-line");
    block.removeAttribute("data-q-ai-empty");
    block.innerHTML = "<br>";
    placeCaret(block, false);

    switch (item.id) {
      case "text": exec("formatBlock", "<p>"); break;
      case "h2": exec("formatBlock", "<h2>"); break;
      case "h3": exec("formatBlock", "<h3>"); break;
      case "quote": exec("formatBlock", "<blockquote>"); break;
      case "code": exec("formatBlock", "<pre>"); break;
      case "ul":
      case "ol":
        if (block.tagName === "P" && block.parentElement === regionOf(block)) convertBlock(block, item.id.toUpperCase());
        else {
          exec(item.id === "ul" ? "insertUnorderedList" : "insertOrderedList");
          if (regionOf(block)) unnestParagraphs(regionOf(block));
        }
        break;
      case "hr": insertAfterBlock(block, document.createElement("hr")); break;
      case "page": {
        var embed = document.createElement("quire-embed");
        embed.setAttribute("src", embedSrcFor(item.node.path));
        insertAfterBlock(block, embed);
        hydrateEmbed(embed);
        break;
      }
      case "ai": {
        made = makeAiMarker(item.prompt);
        insertAfterBlock(block, made);
        aiAdopt(made, "running");
        break;
      }
    }
    var region = regionOf(currentRange() ? currentRange().startContainer : block);
    if (region) tidyRegion(region, false);
    return made;
  }

  // Pages in this page's folder (or below it) are embedded by relative path, others from the root.
  function embedSrcFor(target) {
    var folder = pagePath().split("/").slice(0, -1).join("/");
    if (!folder) return target;
    if (target.indexOf(folder + "/") === 0) return target.slice(folder.length + 1);
    return "/" + target;
  }

  // Replaces an empty block with `node` followed by a fresh paragraph holding the caret.
  // List items: the node goes after the whole list (and the empty item is dropped).
  function insertAfterBlock(block, node) {
    var region = regionOf(block);
    var anchor = block;
    if (block.tagName === "LI") {
      var list = block.parentElement;
      block.remove();
      anchor = list;
      if (!list.querySelector("li")) {
        // The list is now empty: put the node where it was.
        list.parentNode.insertBefore(node, list);
        list.remove();
        anchor = node;
        node = null;
      }
    }
    if (anchor === block && block.parentElement !== region) {
      // Nested empty block (e.g. inside a quote): drop it, insert after its top-level parent.
      anchor = block.parentElement;
      block.remove();
    }
    // Climb to the region's direct child so the inserted node is a top-level block.
    while (anchor.parentElement && anchor.parentElement !== region) anchor = anchor.parentElement;
    if (node) {
      if (anchor === block) {
        region.replaceChild(node, block);
      } else {
        region.insertBefore(node, anchor.nextSibling);
      }
      anchor = node;
    }
    var p = document.createElement("p");
    p.innerHTML = "<br>";
    region.insertBefore(p, anchor.nextSibling);
    placeCaret(p, false);
  }

  /* ------------------------------------------------------------------ Noteblock AI: /ai blocks */

  // "/ai <request>" (the AI line, then ↵) leaves a marker in the page, saved like any block (docs/ai.md):
  //   <div data-q-ai="ai_k3j9x2" data-q-ai-target="block">the request</div>
  // The window runs the job and main replaces the marker in the file with the result. Here the
  // marker is drawn as one line (pill, request, links): everything added is data-q-ui (or a
  // data-q-* attribute other than those two), so cleanTree leaves the file holding just the marker.
  var aiRecs = {}; // blockId -> { id, el, state, text, preview, message, seq }
  var aiObs = null;
  var aiSweepTimer = null;
  var aiSelected = null;
  var AI_BUSY = { checking: 1, running: 1, stopping: 1, done: 1 };

  // Someone to answer ai.*: the desktop app's window. Not the phone app, a browser or a published page.
  function aiWindow() {
    return isFramed && !nativeHost && !httpRpcUrl && location.protocol === "quire:";
  }
  function aiInSlash() { return aiWindow() && !isEmbedded && !isMarkdown && !page.readOnly; }

  function newAiId() {
    var s = "";
    while (s.length < 8) s += Math.random().toString(36).slice(2);
    return "ai_" + s.slice(0, 8);
  }

  function makeAiMarker(prompt) {
    var m = document.createElement("div");
    m.setAttribute("data-q-ai", newAiId());
    m.setAttribute("data-q-ai-target", "block");
    m.textContent = prompt;
    return m;
  }

  function aiPromptOf(m) {
    var s = "";
    for (var n = m.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1 && !isUi(n)) s += n.textContent;
    }
    return s.replace(/\s+/g, " ").trim();
  }
  // Every job is a block job since 0.3.3: an old data-q-ai-target="newpage" marker builds here too.
  function aiTarget() { return "block"; }

  /* ---- the AI line: "/ai " or the slash menu's Ask AI, before it is sent
   * <p data-q-ai-line [data-q-ai-empty]>the request</p>
   * The block itself is drawn as a field (theme.css): the "Ask AI" label sits in its left
   * padding and the placeholder / ↵ are pseudo-elements, so nothing non-editable is in the text
   * and the caret behaves as in any line. All of its state is the attributes, so undo/redo
   * (which restore outerHTML) bring it back whole. cleanTree saves the line as "/ai …". */

  // What the line stands for as plain text ahead of its request: "/ai " (a no-break space when
  // nothing follows, or it collapses).
  function aiPrefixFor(block) {
    var after = "";
    for (var n = block.firstChild; n; n = n.nextSibling) after += n.textContent || "";
    return inkless(after) ? "/ai\u00a0" : /^[\s\u00a0]/.test(after) ? "/ai" : "/ai ";
  }

  function aiLinePrompt(block) {
    var s = "";
    (function walk(p) {
      for (var n = p.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) s += n.nodeValue;
        else if (n.nodeType === 1 && !isUi(n)) walk(n);
      }
    })(block);
    return s.replace(/[\s\u200b\ufeff]+/g, " ").trim();
  }

  // The AI line the caret is in, if any.
  function aiLineAtCaret() {
    var b = caretBlock();
    return (b && b.closest("[data-q-ai-line]")) || null;
  }

  /** The line's state after an edit: empty or not (the placeholder shows while empty). */
  function aiLineRefresh(block) {
    // Pills from a 0.3.3 dev build: their text was the label, never the request.
    Array.prototype.forEach.call(block.querySelectorAll(".q-ai-pill"), function (x) { x.remove(); });
    var empty = !aiLinePrompt(block);
    if (empty) block.setAttribute("data-q-ai-empty", "");
    else block.removeAttribute("data-q-ai-empty");
    if (empty && !block.querySelector("br")) block.appendChild(document.createElement("br"));
  }
  function aiLinesRefresh(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll("[data-q-ai-line]"), aiLineRefresh);
  }

  /** Turns `block` into the AI line holding `prompt`, caret at the end. Inside mutate(). */
  function aiLineMake(block, prompt) {
    block.removeAttribute("data-q-ph");
    block.innerHTML = "";
    prompt = String(prompt || "");
    if (prompt) block.appendChild(document.createTextNode(prompt));
    block.setAttribute("data-q-ai-line", "");
    aiLineRefresh(block);
    placeCaret(block, !!prompt);
  }

  // "/ai" then a space at the start of a text block: the AI line, the rest of the line its request.
  function aiLineFromInput(e) {
    if (!aiInSlash() || e.isComposing || e.inputType !== "insertText" || !/^\s$/.test(e.data || "")) return false;
    var r = currentRange();
    var block = caretBlock();
    if (!r || !r.collapsed || !block || block.hasAttribute("data-q-ai-line") || block.closest("pre,[data-q-ai],[data-q-ui]")) return false;
    var head = document.createRange();
    head.setStart(block, 0);
    head.setEnd(r.startContainer, r.startOffset);
    if (!/^\/ai\s$/i.test(String(head)) || head.cloneContents().querySelector(SOLID_SEL)) return false;
    mutate(function () {
      head.deleteContents();
      var first = block.firstChild;
      if (first && first.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^[\s\u00a0]+/, "");
      block.removeAttribute("data-q-ph");
      block.setAttribute("data-q-ai-line", "");
      aiLineRefresh(block);
      placeCaret(block, false);
    });
    return true;
  }

  /** Back to plain text "/ai …". `toPrefix`: the caret goes right after "/ai " (Backspace). */
  function aiLineToText(block, toPrefix) {
    var t = document.createTextNode(aiPrefixFor(block));
    block.insertBefore(t, block.firstChild);
    Array.prototype.forEach.call(block.querySelectorAll(".q-ai-pill"), function (x) { x.remove(); });
    block.removeAttribute("data-q-ai-line");
    block.removeAttribute("data-q-ai-empty");
    if (toPrefix) {
      var r = document.createRange();
      r.setStart(t, t.nodeValue.length);
      r.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  // Leaving the editor: an unsent line is shown (and was saved) as its text.
  function aiLinesToText() {
    if (!document.body) return;
    var lines = document.querySelectorAll("[data-q-ai-line]");
    if (!lines.length) return;
    hist.busy++;
    try { Array.prototype.forEach.call(lines, function (b) { aiLineToText(b, false); }); } finally { hist.busy--; }
    syncHistory();
  }

  /** ↵ on the AI line: the marker in its place (saved first), then the block job. */
  function aiLineSend(block) {
    var prompt = aiLinePrompt(block);
    if (!prompt) return;
    var made = mutate(function () { return insertSlashItem({ id: "ai", prompt: prompt }, block); });
    updatePlaceholder();
    if (made) aiLaunch(made);
  }

  editorKeydown.push(function (e) {
    if (!editing || page.readOnly || e.isComposing || e.keyCode === 229) return;
    if (e.key !== "Enter" && e.key !== "Escape" && e.key !== "Backspace") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var block = aiLineAtCaret();
    if (!block) return;
    var take = function () { e.preventDefault(); e.stopPropagation(); e.__qAiLine = true; };
    if (e.key === "Enter") {
      take();
      if (!e.shiftKey) aiLineSend(block); // ⇧↵ does nothing: the request is one line
    } else if (e.key === "Escape") {
      take();
      mutate(function () { aiLineToText(block, false); });
      updatePlaceholder();
    } else {
      var r = currentRange();
      if (!r || !r.collapsed) return;
      var head = document.createRange();
      head.setStart(block, 0);
      head.setEnd(r.startContainer, r.startOffset);
      var frag = head.cloneContents();
      Array.prototype.forEach.call(frag.querySelectorAll("[data-q-ui]"), function (x) { x.remove(); });
      if (!inkless(frag.textContent) || frag.querySelector(SOLID_SEL)) return;
      take();
      mutate(function () { aiLineToText(block, true); });
      updatePlaceholder();
    }
  });

  /* ---- the marker, drawn as one line: pill, the request, links; reason or code peek below */

  function decorateAi(rec, m) {
    rec.el = m;
    m.setAttribute("contenteditable", "false");
    if (m.__qAiCard && m.__qAiCard.parentNode) m.__qAiCard.parentNode.removeChild(m.__qAiCard);
    var card = el("div", { "data-q-ui": "", class: "q-ui q-ai-card" });
    var line = el("div", { class: "q-ai-line" });
    var pill = el("span", { class: "q-ai-pill" });
    var icon = el("span", { class: "q-ai-pill-icon", "aria-hidden": "true" });
    var label = el("span", { class: "q-ai-pill-label" });
    pill.appendChild(icon);
    pill.appendChild(label);
    var prompt = el("span", { class: "q-ai-prompt" });
    var stop = el("button", { type: "button", class: "q-ai-link q-ai-stop" }, "Stop");
    var retry = el("button", { type: "button", class: "q-ai-link q-ai-retry" }, "Retry");
    var back = el("button", { type: "button", class: "q-ai-link q-ai-back" }, "Back to text");
    line.appendChild(pill);
    line.appendChild(prompt);
    line.appendChild(stop);
    line.appendChild(retry);
    line.appendChild(back);
    var status = el("div", { class: "q-ai-status", role: "status" });
    var preview = el("div", { class: "q-ai-preview", "aria-hidden": "true" });
    card.appendChild(line);
    card.appendChild(status);
    card.appendChild(preview);
    m.insertBefore(card, m.firstChild);
    m.__qAiCard = card;
    m.__qAiParts = { icon: icon, label: label, prompt: prompt, status: status, preview: preview, stop: stop, iconKey: "" };

    [stop, retry, back].forEach(function (b) {
      b.addEventListener("mousedown", function (e) { e.preventDefault(); e.stopPropagation(); });
    });
    stop.addEventListener("click", function () { aiStop(rec); });
    retry.addEventListener("click", function () { aiRun(rec); });
    back.addEventListener("click", function () { aiBackToText(rec); });
    // Like an embed: a click selects the block, and Backspace/Delete removes it.
    card.addEventListener("mousedown", function (e) {
      if (!canEditEmbeds() || e.button !== 0) return;
      e.preventDefault();
      aiSelect(m);
    });
    card.addEventListener("contextmenu", function (e) {
      if (!canEditEmbeds()) return;
      e.preventDefault();
      aiSelect(m);
      showMenu(e.clientX, e.clientY, [
        { label: "Back to text", run: function () { aiBackToText(rec); } },
        { label: "Delete", danger: true, run: function () { aiRemove(rec); } },
      ]);
    });
  }

  // The last lines of the code being written; the peek shows two and fades the top out.
  function aiTail(s) {
    return String(s).replace(/\s+$/, "").split("\n").slice(-3).map(function (l) { return l.length > 240 ? l.slice(0, 240) : l; }).join("\n");
  }

  function renderAi(rec) {
    var m = rec.el;
    var parts = m && m.__qAiParts;
    if (!parts) return;
    m.setAttribute("data-q-ai-state", rec.state);
    var busy = !!AI_BUSY[rec.state];
    var failed = rec.state === "error" || rec.state === "interrupted";
    var label = busy ? (rec.state === "stopping" ? "Stopping" : "Building") : failed ? "Couldn’t build" : rec.state === "stopped" ? "Stopped" : "Ask AI";
    var iconKey = busy ? "spinner" : failed ? "warn" : "ai";
    if (parts.iconKey !== iconKey) { parts.icon.innerHTML = ICONS[iconKey]; parts.iconKey = iconKey; }
    parts.label.textContent = label;
    parts.prompt.textContent = aiPromptOf(m);
    var status = "";
    switch (rec.state) {
      case "running": status = rec.preview ? "" : rec.text || ""; break; // the peek replaces it once code streams
      case "error": status = rec.message || "Something went wrong."; break;
      case "interrupted": status = "Interrupted: the job ended before it finished."; break;
      case "offline": status = "Builds in the Noteblock desktop app"; break;
    }
    parts.status.textContent = status;
    parts.status.hidden = !status;
    var showPreview = (rec.state === "running" || rec.state === "stopping" || rec.state === "done") && !!rec.preview;
    parts.preview.textContent = showPreview ? aiTail(rec.preview) : "";
    parts.preview.hidden = !showPreview;
    parts.stop.disabled = rec.state === "stopping";
  }

  // Back to text: the marker becomes a plain paragraph holding its request.
  function aiBackToText(rec) {
    var m = rec.el;
    if (!canEditEmbeds() || !m || !m.isConnected) return;
    var prompt = aiPromptOf(m);
    if (rec.state === "running" || rec.state === "checking" || rec.state === "stopping") rpc("ai.stop", { blockId: rec.id }).catch(function () {});
    rec.seq++;
    rec.state = "removed";
    if (aiSelected === m) aiSelect(null);
    adoptEmbed(m); // one that was in the file at the top level gets a region, so the change saves
    var p = document.createElement("p");
    if (prompt) p.textContent = prompt;
    else p.innerHTML = "<br>";
    var region = regionOf(m);
    mutate(function () {
      m.parentNode.replaceChild(p, m);
      if (region && region.getAttribute("contenteditable") !== "true") {
        region.setAttribute("contenteditable", "true");
        region.spellcheck = spellcheckOn();
      }
    });
    if (region) {
      region.focus({ preventScroll: true });
      placeCaret(p, true);
    }
    updatePlaceholder();
  }

  /**
   * A marker found in the page: decorated once, and asked about (ai.status) when it is new to
   * this runtime. `state` (from the slash menu) skips the question: the job is starting now.
   */
  function aiAdopt(m, state) {
    var id = m.getAttribute("data-q-ai");
    if (!id) return null;
    var rec = aiRecs[id];
    var fresh = !rec || rec.state === "removed";
    if (!rec) rec = aiRecs[id] = { id: id, el: m, state: "", text: "", preview: "", message: "", seq: 0 };
    if (rec.el !== m || !m.__qAiCard || !m.contains(m.__qAiCard)) decorateAi(rec, m);
    if (fresh) {
      rec.text = rec.preview = rec.message = "";
      rec.state = state || (aiWindow() ? "checking" : "offline");
      if (rec.state === "checking") aiCheck(rec);
    }
    renderAi(rec);
    return rec;
  }

  function aiCheck(rec) {
    var seq = ++rec.seq;
    rec.state = "checking";
    renderAi(rec);
    rpc("ai.status", { blockId: rec.id }).then(function (res) {
      if (rec.seq !== seq || rec.state !== "checking") return;
      rec.state = res && res.running ? "running" : "interrupted";
      renderAi(rec);
    }, function () {
      if (rec.seq !== seq || rec.state !== "checking") return;
      rec.state = "interrupted";
      renderAi(rec);
    });
  }

  // The editor started: markers left without a job get asked again (another window may run one).
  function aiRecheck() {
    if (!aiWindow()) return;
    aiSweep();
    Object.keys(aiRecs).forEach(function (id) {
      var rec = aiRecs[id];
      if (rec.state === "interrupted" && rec.el.isConnected) aiCheck(rec);
    });
  }

  /** A marker just inserted from the slash menu: onto disk first, then the job. */
  function aiLaunch(m) {
    var rec = aiRecs[m.getAttribute("data-q-ai")];
    if (!rec) return;
    if (!manualSave) flushSave(); // a built page saves on ⌘S; the window flushes before apply
    aiRun(rec);
  }

  function aiRun(rec) {
    var m = rec.el;
    var prompt = aiPromptOf(m);
    if (!aiWindow() || !prompt || !m.isConnected) return;
    var seq = ++rec.seq;
    rec.state = "running";
    rec.text = rec.preview = rec.message = "";
    renderAi(rec);
    rpc("ai.start", { prompt: prompt, target: aiTarget(), blockId: rec.id }).then(function (res) {
      if (rec.seq === seq && res && res.jobId) rec.jobId = res.jobId;
    }, function (err) {
      if (rec.seq !== seq || rec.state !== "running") return;
      rec.state = "error";
      rec.message = err && err.message ? err.message : String(err || "");
      renderAi(rec);
    });
  }

  function aiStop(rec) {
    if (rec.state !== "running" && rec.state !== "checking") return;
    var seq = ++rec.seq;
    rec.state = "stopping";
    renderAi(rec);
    rpc("ai.stop", { blockId: rec.id }).then(function () {
      // The stopped event usually beats this; without one, the job is gone all the same.
      if (rec.seq === seq && rec.state === "stopping") { rec.state = "stopped"; renderAi(rec); }
    }, function () {
      if (rec.seq === seq && rec.state === "stopping") { rec.state = "stopped"; renderAi(rec); }
    });
  }

  // Remove: the marker leaves the page (and the file, on the next save); a running job is stopped.
  function aiRemove(rec) {
    var m = rec.el;
    if (!canEditEmbeds() || !m || !m.isConnected) return;
    if (rec.state === "running" || rec.state === "checking" || rec.state === "stopping") rpc("ai.stop", { blockId: rec.id }).catch(function () {});
    rec.state = "removed";
    if (aiSelected === m) aiSelect(null);
    adoptEmbed(m); // one that was in the file at the top level gets a region, so the removal saves
    mutate(function () {
      var region = regionOf(m);
      m.remove();
      if (region && !region.textContent.trim() && !region.querySelector("img,hr,quire-embed,iframe,[data-q-ai]")) region.style.display = "none";
    });
  }

  function aiSelect(m) {
    if (aiSelected === m) return;
    if (aiSelected) aiSelected.removeAttribute("data-q-ai-selected");
    aiSelected = m;
    if (m) {
      selectEmbed(null);
      m.setAttribute("data-q-ai-selected", "");
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      hideToolbar();
    }
  }
  document.addEventListener("mousedown", function (e) {
    if (aiSelected && !aiSelected.contains(e.target)) aiSelect(null);
  }, true);
  editorKeydown.push(function (e) {
    if (!aiSelected || !canEditEmbeds()) return;
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      var rec = aiRecs[aiSelected.getAttribute("data-q-ai")];
      if (rec) aiRemove(rec);
    } else if (e.key === "Escape") {
      e.preventDefault();
      aiSelect(null);
    }
  });

  /**
   * Markers come and go with typing, undo and deletes. A marker gone from the page while its
   * job runs is a cancel (main also ends a job whose marker is missing from the file at apply);
   * one that appears (undo, redo) is decorated and asked about.
   */
  function aiSweep() {
    clearTimeout(aiSweepTimer);
    aiSweepTimer = null;
    if (!document.body) return;
    var live = {};
    Array.prototype.forEach.call(document.querySelectorAll("[data-q-ai]"), function (m) {
      var id = m.getAttribute("data-q-ai");
      if (id && !live[id] && !(m.parentNode && m.parentNode.closest && m.parentNode.closest("[data-q-ai],[data-q-ui]"))) live[id] = m;
    });
    Object.keys(aiRecs).forEach(function (id) {
      var rec = aiRecs[id];
      if (rec.state === "removed" || (live[id] && live[id] === rec.el)) return;
      if (live[id]) return; // the same block drawn anew: adopted below
      if (rec.state === "running" || rec.state === "checking" || rec.state === "stopping") rpc("ai.stop", { blockId: id }).catch(function () {});
      rec.seq++;
      rec.state = "removed";
      if (aiSelected === rec.el) aiSelect(null);
    });
    Object.keys(live).forEach(function (id) { aiAdopt(live[id]); });
  }

  function aiOnMutations(records) {
    var relevant = records.some(function (r) {
      var t = r.target.nodeType === 1 ? r.target : r.target.parentNode;
      return !(t && t.closest && t.closest("[data-q-ui]"));
    });
    if (relevant && !aiSweepTimer) aiSweepTimer = setTimeout(aiSweep, 60);
  }

  function startAi() {
    if (!document.body) return;
    aiSweep();
    if (!aiObs && typeof MutationObserver !== "undefined") {
      aiObs = new MutationObserver(aiOnMutations);
      aiObs.observe(document.body, { childList: true, subtree: true });
    }
    if (pendingAiChanged) {
      markAiChanged(pendingAiChanged);
      pendingAiChanged = null;
    }
  }

  // {type:"ai", event} from the window: progress, error, stopped, done for one marker.
  function onAiEvent(ev) {
    if (!ev || typeof ev !== "object" || !ev.blockId) return;
    var rec = aiRecs[ev.blockId];
    if (!rec || rec.state === "removed") return;
    switch (ev.type) {
      case "progress":
        if (rec.state === "checking" || rec.state === "interrupted") { rec.seq++; rec.state = "running"; }
        if (rec.state !== "running" && rec.state !== "stopping") return;
        if (ev.text != null) rec.text = String(ev.text);
        if (ev.preview != null) rec.preview = String(ev.preview);
        break;
      case "error":
        if (rec.state === "done") return;
        rec.seq++;
        rec.state = "error";
        rec.message = ev.message ? String(ev.message) : "";
        break;
      case "stopped":
        if (rec.state === "done") return;
        rec.seq++;
        rec.state = "stopped";
        break;
      case "done":
        // The window reloads the page with the result in the marker's place.
        rec.seq++;
        rec.state = "done";
        break;
      default:
        return;
    }
    renderAi(rec);
  }

  // {type:"ai-changed", indexes} after the reload: an accent rule beside each changed top-level block.
  var AI_CHANGED_MS = 3000;
  function markAiChanged(indexes) {
    if (!document.body || !indexes || typeof indexes.length !== "number") return;
    var want = {};
    Array.prototype.forEach.call(indexes, function (i) { want[String(i)] = true; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-q-i]"), function (n) {
      var p = n.parentElement;
      if (p !== document.body && !(p && p.hasAttribute("data-q-region") && p.parentElement === document.body)) return;
      if (!want[n.getAttribute("data-q-i")]) return;
      n.setAttribute("data-q-ai-changed", "");
      setTimeout(function () { n.removeAttribute("data-q-ai-changed"); }, AI_CHANGED_MS);
    });
  }

  /* ------------------------------------------------------------------ native editor commands */

  // The phone app's keyboard bar and insert sheet drive the editor through window.quire.editor
  // (called with evaluateJavaScript) and hear back through messageHandlers.quireEditor:
  // {type: "state", …state()} on selection and input changes, {type: "tap-edit"} when a tap in
  // reading mode turned the editor on. With that handler present the desktop's floating
  // toolbar and slash menu stay hidden; the native bar replaces them. Desktop is unchanged.
  function nativeEditorHost() {
    var h = window.webkit && window.webkit.messageHandlers;
    return h && h.quireEditor ? h.quireEditor : null;
  }

  var neLastRange = null;
  var neStateTimer = null;
  var neSavingTimer = null;
  var neLastSent = "";
  var neTapToEdit = false;
  var neTouch = null;

  // The selection as it was last inside a region: the insert sheet takes focus away from the
  // page, and its commands land where the caret was.
  function neRemember() {
    var r = currentRange();
    if (r && regionOf(r.startContainer)) neLastRange = r.cloneRange();
  }

  function neRestore() {
    var r = currentRange();
    if (r && regionOf(r.startContainer)) return true;
    var saved = neLastRange && neLastRange.startContainer.isConnected ? neLastRange : null;
    var region = saved ? regionOf(saved.startContainer) : null;
    if (!region) {
      // No caret yet: the end of the last region.
      var last = regions.length ? regions[regions.length - 1].el : null;
      if (!last) return false;
      last.focus({ preventScroll: true });
      placeCaret(last.lastElementChild || last, true);
      return true;
    }
    region.focus({ preventScroll: true });
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(saved);
    return true;
  }

  function neReady() { return editing && !page.readOnly && regions.length > 0; }

  function neChecklistItem(li) {
    var first = li && li.firstElementChild;
    return !!(first && first.tagName === "INPUT" && (first.getAttribute("type") || "").toLowerCase() === "checkbox");
  }

  function neAddCheckbox(li) {
    if (neChecklistItem(li)) return;
    var box = document.createElement("input");
    box.setAttribute("type", "checkbox");
    li.insertBefore(box, li.firstChild);
  }

  // A caret left before an item's box goes just after it.
  function neCaretPastBox() {
    var r = currentRange();
    var li = caretItem();
    if (!r || !r.collapsed || !neChecklistItem(li)) return;
    if (r.startContainer === li && r.startOffset === 0) caretAt(li, 1);
  }

  function neRemoveCheckbox(li) {
    if (!neChecklistItem(li)) return;
    li.firstElementChild.remove();
    if (!li.textContent && !li.querySelector("br,img")) li.innerHTML = "<br>";
  }

  // The list items the selection touches (top-level ones of the list the caret is in).
  function neSelectedItems() {
    var r = currentRange();
    var li = caretItem();
    if (!r || !li) return [];
    var list = li.parentElement;
    var items = Array.prototype.filter.call(list.children, function (c) {
      return c.tagName === "LI" && (c === li || r.intersectsNode(c));
    });
    return items.length ? items : [li];
  }

  function neBlock() {
    var tag = blockTagAtSelection();
    if (tag === "H1" || tag === "H2" || tag === "H3") return tag.toLowerCase();
    if (tag === "LI") {
      var li = caretItem();
      if (neChecklistItem(li)) return "checklist";
      return li && li.parentElement.tagName === "OL" ? "ol" : "ul";
    }
    if (tag === "BLOCKQUOTE") return "quote";
    if (tag === "PRE") return "code";
    return "p";
  }

  function neState() {
    var q = function (c) { try { return !!document.queryCommandState(c); } catch (e) { return false; } };
    var inText = editing && !!selectionRegion();
    return {
      editing: editing,
      bold: inText && q("bold"),
      italic: inText && q("italic"),
      block: inText ? neBlock() : "p",
      canUndo: editing && (hist.undo.length > 0 || saveTimer !== null),
      canRedo: editing && hist.redo.length > 0,
      saving: !!(saving || saveTimer !== null || dirtyWhileSaving),
      dirty: dirty,
    };
  }

  function nePost() {
    clearTimeout(neStateTimer);
    neStateTimer = null;
    var h = nativeEditorHost();
    if (!h || !isTopPage) return;
    var s = neState();
    var key = JSON.stringify(s);
    if (key !== neLastSent) {
      neLastSent = key;
      s.type = "state";
      try { h.postMessage(s); } catch (e) { /* gone */ }
    }
    // Saves finish without an event of their own: look again until the save is done.
    clearTimeout(neSavingTimer);
    neSavingTimer = s.saving ? setTimeout(nePost, 250) : null;
  }

  function neSchedule() {
    if (!nativeEditorHost()) return;
    clearTimeout(neStateTimer);
    neStateTimer = setTimeout(nePost, 60);
  }

  // One command from the bar: the caret comes back first, the state goes out after.
  function neRun(fn) {
    if (!neReady()) return false;
    if (!neRestore()) return false;
    var out = fn();
    neRemember();
    updatePlaceholder();
    nePost();
    return out === undefined ? true : out;
  }

  // An empty block at the caret for an insert: the caret's own block when it is an empty
  // paragraph, else a new paragraph after its top-level block.
  function neEmptyBlock() {
    var block = caretBlock();
    var region = block ? regionOf(block) : selectionRegion();
    if (!region) return null;
    if (block && block.tagName === "P" && !blockText(block).trim() && !block.querySelector("img,hr,quire-embed,input")) return block;
    var anchor = block || region.lastElementChild;
    while (anchor && anchor.parentElement && anchor.parentElement !== region) anchor = anchor.parentElement;
    var p = document.createElement("p");
    p.innerHTML = "<br>";
    region.insertBefore(p, anchor ? anchor.nextSibling : null);
    placeCaret(p, false);
    return p;
  }

  function neTidy() {
    var region = selectionRegion();
    if (region) { unnestParagraphs(region); tidyRegion(region, false); }
  }

  function neList(kind) {
    var tag = kind === "ol" ? "OL" : "UL";
    var li = caretItem();
    if (li && neChecklistItem(li)) {
      // A checklist asked to be a list: the boxes go, the list stays (or turns numbered).
      neSelectedItems().forEach(neRemoveCheckbox);
      if (tag === "UL") return;
    }
    var block = caretBlock();
    if (!li && block && block.tagName === "P" && block.parentElement === regionOf(block)) convertBlock(block, tag);
    else exec(tag === "OL" ? "insertOrderedList" : "insertUnorderedList");
    neTidy();
  }

  function neChecklist() {
    var li = caretItem();
    if (li && neChecklistItem(li)) {
      neSelectedItems().forEach(neRemoveCheckbox);
      exec("insertUnorderedList");
      neTidy();
      return;
    }
    var block = caretBlock();
    if (!li) {
      if (block && block.tagName === "P" && block.parentElement === regionOf(block)) convertBlock(block, "UL");
      else exec("insertUnorderedList");
      neTidy();
    } else if (li.parentElement.tagName === "OL") {
      exec("insertUnorderedList");
      neTidy();
    }
    keepCaret(function () { neSelectedItems().forEach(neAddCheckbox); });
    neCaretPastBox();
  }

  function neTable() {
    var t = document.createElement("table");
    var html = "<thead><tr><th><br></th><th><br></th></tr></thead><tbody>";
    for (var i = 0; i < 2; i++) html += "<tr><td><br></td><td><br></td></tr>";
    t.innerHTML = html + "</tbody>";
    return t;
  }

  function neInsertBlock(kind) {
    var block = neEmptyBlock();
    if (!block) return false;
    switch (kind) {
      case "heading": insertSlashItem({ id: "h2" }, block); break;
      case "subheading": insertSlashItem({ id: "h3" }, block); break;
      case "quote": insertSlashItem({ id: "quote" }, block); break;
      case "code": insertSlashItem({ id: "code" }, block); break;
      case "rule": insertSlashItem({ id: "hr" }, block); break;
      case "ul":
      case "ol": insertSlashItem({ id: kind }, block); break;
      case "checklist":
        insertSlashItem({ id: "ul" }, block);
        var li = caretItem();
        if (li) { neAddCheckbox(li); caretAt(li, 1); }
        break;
      case "table": {
        var table = neTable();
        insertAfterBlock(block, table);
        placeCaret(table.querySelector("th"), false);
        break;
      }
      default: return false;
    }
    neTidy();
    return true;
  }

  // A tap on text in reading mode, when the app allows editing: the editor turns on right in
  // the touch handler, so the caret lands under the finger and the keyboard comes up.
  function neTextBlockAt(node) {
    var n = node && node.nodeType === 3 ? node.parentNode : node;
    if (!n || !n.closest || n.closest("a[href],button,input,select,textarea,label,iframe,quire-embed,[data-q-ui],[data-app]")) return false;
    while (n && n.parentElement && n.parentElement !== document.body && !n.parentElement.hasAttribute("data-q-region")) n = n.parentElement;
    if (!n || n === document.body || n === document.documentElement) return false;
    if (n.hasAttribute("data-q-region")) return true;
    return qi(n) !== null && isTextBlock(n) && !scriptTouched(n);
  }

  function neTapEdit(x, y) {
    if (editing || page.readOnly || !neTapToEdit || !isTopPage || srcBlocks === null) return false;
    var hit = document.elementFromPoint(x, y);
    if (!neTextBlockAt(hit)) return false;
    setEditing(true);
    if (!editing) return false;
    var at = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    var region = at ? regionOf(at.startContainer) : null;
    if (region) {
      region.focus({ preventScroll: true });
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(at);
    }
    var h = nativeEditorHost();
    if (h) { try { h.postMessage({ type: "tap-edit" }); } catch (e) { /* gone */ } }
    nePost();
    return true;
  }

  document.addEventListener("touchstart", function (e) {
    var t = e.touches && e.touches[0];
    neTouch = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
  }, { passive: true, capture: true });
  document.addEventListener("touchend", function (e) {
    var start = neTouch;
    neTouch = null;
    var t = e.changedTouches && e.changedTouches[0];
    if (!start || !t || editing || !neTapToEdit) return;
    if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10 || Date.now() - start.at > 600) return;
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (neTapEdit(t.clientX, t.clientY)) e.preventDefault();
  }, { capture: true });

  // Checkboxes in a checklist tick in edit mode too, and the tick is saved.
  document.addEventListener("click", function (e) {
    var box = e.target;
    if (!editing || page.readOnly || !box || box.tagName !== "INPUT" || (box.getAttribute("type") || "").toLowerCase() !== "checkbox") return;
    var li = box.parentElement;
    if (!li || li.tagName !== "LI" || li.firstElementChild !== box || !regionOf(li)) return;
    e.preventDefault();
    var on = !box.hasAttribute("checked");
    mutate(function () {
      if (on) box.setAttribute("checked", "");
      else box.removeAttribute("checked");
    });
    setTimeout(function () { box.checked = on; }, 0);
  }, true);

  // Enter in a checklist item: the new item gets a box of its own.
  document.addEventListener("input", function (e) {
    if (!editing || e.inputType !== "insertParagraph") { neSchedule(); return; }
    var li = caretItem();
    var prev = li && li.previousElementSibling;
    if (li && prev && prev.tagName === "LI" && neChecklistItem(prev) && !neChecklistItem(li)) {
      keepCaret(function () { neAddCheckbox(li); });
      neCaretPastBox();
      syncHistory();
      queueSave();
    }
    neSchedule();
  });

  document.addEventListener("selectionchange", function () {
    if (!editing) return;
    neRemember();
    neSchedule();
  });

  quire.editor = {
    bold: function () { return neRun(function () { runToolbarCommand("bold"); }); },
    italic: function () { return neRun(function () { runToolbarCommand("italic"); }); },
    link: function (url) {
      return neRun(function () {
        var href = normalizeUrl(url);
        var sel = window.getSelection();
        mutate(function () {
          if (!href) { exec("unlink"); return; }
          if (sel && sel.isCollapsed && !linkAtSelection()) {
            var a = document.createElement("a");
            a.setAttribute("href", href);
            a.textContent = String(url).trim();
            currentRange().insertNode(a);
            var r = document.createRange();
            r.setStartAfter(a);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
          } else {
            exec("createLink", href);
          }
        });
      });
    },
    heading: function (level) {
      return neRun(function () {
        var n = Number(level) || 0;
        var tag = n >= 1 && n <= 3 ? "H" + n : "P";
        mutate(function () {
          var li = caretItem();
          if (li && tag !== "P") {
            // A list item becomes a heading: out of the list first.
            if (neChecklistItem(li)) neRemoveCheckbox(li);
            exec(li.parentElement.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList");
          }
          exec("formatBlock", blockTagAtSelection() === tag && tag !== "P" ? "<p>" : "<" + tag.toLowerCase() + ">");
          neTidy();
        });
      });
    },
    list: function (kind) { return neRun(function () { mutate(function () { neList(kind); }); }); },
    checklist: function () { return neRun(function () { mutate(neChecklist); }); },
    indent: function () {
      return neRun(function () {
        var li = caretItem();
        if (!li) return false;
        mutate(function () { indentItem(li); tidyRegion(regionOf(li), false); });
      });
    },
    outdent: function () {
      return neRun(function () {
        var li = caretItem();
        if (!li) return false;
        mutate(function () { outdentItem(li); tidyRegion(regionOf(li), false); });
      });
    },
    undo: function () { return neRun(undo); },
    redo: function () { return neRun(redo); },
    insertBlock: function (kind) { return neRun(function () { return mutate(function () { return neInsertBlock(kind); }); }); },
    insertEmbed: function (path) {
      return neRun(function () {
        if (!path) return false;
        mutate(function () {
          var block = neEmptyBlock();
          if (block) insertSlashItem({ id: "page", node: { path: String(path) } }, block);
        });
      });
    },
    insertImage: function (src, alt) {
      return neRun(function () {
        if (!src || !safeSrc(src)) return false;
        mutate(function () {
          var block = neEmptyBlock();
          if (!block) return;
          var img = document.createElement("img");
          img.setAttribute("src", String(src));
          img.setAttribute("alt", alt ? String(alt) : "");
          var p = document.createElement("p");
          p.appendChild(img);
          insertAfterBlock(block, p);
        });
      });
    },
    // The caret back in the page (after the insert sheet, or Edit): where it was, else the end.
    focus: function () {
      if (!neReady()) return false;
      var ok = neRestore();
      nePost();
      return ok;
    },
    blur: function () {
      var a = document.activeElement;
      if (a && a.blur) a.blur();
      return true;
    },
    // Taps on text in reading mode turn the editor on (the app says when that's allowed).
    // The served file is fetched now so the switch can happen inside the tap.
    setTapToEdit: function (on) {
      neTapToEdit = !!on;
      if (neTapToEdit && srcBlocks === null) loadSource();
      return true;
    },
    state: neState,
  };

  // The bar learns about mode changes too (Done, a lock from the Mac).
  new MutationObserver(function () { neSchedule(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  /* ------------------------------------------------------------------ overlay scrollbar */

  // Where a system draws classic scrollbars (macOS "Always", a mouse attached, Windows), the root
  // scrollbar taking up room moves the page when it first overflows. theme.css hides the root's
  // scrollbar under html.q-overlay-scroll and this draws a thin thumb over the content instead.
  // Wheel, keyboard and find keep working: the root still scrolls. Inner scrollers keep theirs.
  // Skipped on the phones and in embeds, and on a published page opened on a touch-only device,
  // which all scroll with their own indicators. The thumb is a child of <html>, outside anything
  // saved, and only exists once the root has scrolled or been hovered.
  var OS_FADE_MS = 800;
  var OS_EDGE_PX = 14; // the hover zone and the track's width
  var OS_PAD_PX = 2;
  var OS_MIN_THUMB_PX = 28;
  var osOn = !isEmbedded && !nativeHost && !nativeEditorHost() &&
    !(standalone && window.matchMedia && window.matchMedia("(hover: none)").matches);
  if (osOn) document.documentElement.classList.add("q-overlay-scroll");
  var osTrack = null;
  var osThumb = null;
  var osScrollable = false;
  var osHover = false;
  var osDrag = null;
  var osFrame = 0;
  var osReveal = false;
  var osFade = 0;
  var osEdge = 0;
  var osMoveBound = false;

  function osRoot() { return document.scrollingElement || document.documentElement; }

  // A root that overflows but can't scroll (overflow: hidden on html, or on a body that passes
  // it up to the viewport) gets no thumb.
  function osRootScrolls() {
    var y = getComputedStyle(document.documentElement).overflowY;
    if (y === "visible" && document.body) y = getComputedStyle(document.body).overflowY;
    return y !== "hidden" && y !== "clip";
  }

  function osSetHover(on) {
    if (on === osHover) return;
    osHover = on;
    if (on) { osSchedule(true); return; }
    if (osTrack) osTrack.classList.remove("q-armed");
    if (!osDrag) osFadeLater();
  }

  // Only runs where the root scrolls, and only compares numbers until the pointer reaches the edge.
  function osOnMove(e) {
    osSetHover(e.buttons === 0 && e.clientX >= osEdge - OS_EDGE_PX);
  }
  function osOnLeave() { osSetHover(false); }

  function osFadeLater() {
    clearTimeout(osFade);
    osFade = setTimeout(function () { if (osTrack && !osHover && !osDrag) osTrack.classList.remove("q-on"); }, OS_FADE_MS);
  }

  function osBuild() {
    osTrack = el("div", { "data-q-ui": "", class: "q-ui q-scrollbar", "aria-hidden": "true" });
    osThumb = el("div", { class: "q-scrollbar-thumb" });
    osTrack.appendChild(osThumb);
    // Mousedown is cancelled so the caret and selection stay where they are.
    osTrack.addEventListener("mousedown", function (e) { e.preventDefault(); });
    osTrack.addEventListener("pointerdown", osPointerDown);
    osTrack.addEventListener("pointermove", osPointerMove);
    osTrack.addEventListener("pointerup", osPointerUp);
    osTrack.addEventListener("pointercancel", osPointerUp);
  }

  function osScrollTo(top) { window.scrollTo({ top: top, behavior: "instant" }); }

  function osPointerDown(e) {
    if (e.button !== 0) return;
    var root = osRoot();
    var thumb = osThumb.getBoundingClientRect();
    if (e.target !== osThumb) {
      // Track click: a page up or down.
      osScrollTo(root.scrollTop + (e.clientY < thumb.top ? -1 : 1) * Math.max(40, root.clientHeight - 40));
      return;
    }
    var travel = root.clientHeight - thumb.height - OS_PAD_PX * 2;
    osDrag = { id: e.pointerId, y: e.clientY, top: root.scrollTop, per: travel > 0 ? (root.scrollHeight - root.clientHeight) / travel : 0 };
    try { osTrack.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is gone */ }
    osTrack.classList.add("q-dragging");
  }
  function osPointerMove(e) {
    if (osDrag && e.pointerId === osDrag.id) osScrollTo(osDrag.top + (e.clientY - osDrag.y) * osDrag.per);
  }
  function osPointerUp(e) {
    if (!osDrag || e.pointerId !== osDrag.id) return;
    osDrag = null;
    osTrack.classList.remove("q-dragging");
    osSetHover(e.clientX >= osEdge - OS_EDGE_PX && e.clientX < osEdge);
    if (!osHover) osFadeLater();
  }

  function osSchedule(reveal) {
    if (reveal) osReveal = true;
    if (!osFrame) osFrame = requestAnimationFrame(osPaint);
  }

  function osPaint() {
    osFrame = 0;
    var reveal = osReveal;
    osReveal = false;
    var root = osRoot();
    var view = root.clientHeight;
    var full = root.scrollHeight;
    osEdge = root.clientWidth;
    osScrollable = full - view > 1 && osRootScrolls();
    // The hover listener only exists while there is something to hover for.
    if (osScrollable !== osMoveBound) {
      osMoveBound = osScrollable;
      var bind = osScrollable ? "addEventListener" : "removeEventListener";
      document[bind]("mousemove", osOnMove, { passive: true });
      document.documentElement[bind]("mouseleave", osOnLeave, { passive: true });
    }
    if (!osScrollable) {
      osHover = false;
      if (osTrack) osTrack.classList.remove("q-on", "q-armed");
      return;
    }
    var shown = osTrack && osTrack.classList.contains("q-on");
    if (!reveal && !shown) return;
    if (!osTrack) osBuild();
    if (!osTrack.isConnected) document.documentElement.appendChild(osTrack);
    var track = view - OS_PAD_PX * 2;
    var h = Math.max(OS_MIN_THUMB_PX, Math.round(track * view / full));
    var at = Math.min(1, Math.max(0, root.scrollTop / (full - view)));
    osThumb.style.height = h + "px";
    osThumb.style.transform = "translateY(" + Math.round(OS_PAD_PX + (track - h) * at) + "px)";
    if (reveal) {
      osTrack.classList.add("q-on");
      osTrack.classList.toggle("q-armed", osHover);
      clearTimeout(osFade);
      if (!osHover && !osDrag) osFadeLater();
    }
  }

  function startOverlayScrollbar() {
    if (!osOn) return;
    // A scroll event only reaches window from the root; inner scrollers' don't bubble.
    window.addEventListener("scroll", function () { osSchedule(true); }, { passive: true });
    window.addEventListener("resize", function () { osSchedule(false); }, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(function () { osSchedule(false); });
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    osSchedule(false);
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    domReady = true;
    isMarkdown = !!(document.body && document.body.getAttribute("data-q-format") === "md");
    if (isEmbedded) document.documentElement.classList.add("q-embedded");
    hydrateEmbeds(document);
    startAi();
    startResizeReporting();
    startOverlayScrollbar();
    if (pendingMode) {
      var m = pendingMode;
      pendingMode = null;
      applyMode(m);
    }
  }

  // Copying works in reading mode too, so it's wired here rather than with the edit UI.
  document.addEventListener("copy", onCopy, true);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  if (isEmbedded) document.documentElement.classList.add("q-embedded");

  // The old shared localStorage was copied in (top of this file): the app stops sending it.
  if (legacyTaken && isFramed) rpc("storage.migrated", {}).catch(function () {});

  // quire.ready: resolves once the parent has answered the first rpc.
  if (standalone) readyResolve();
  else if (isFramed || nativeHost) {
    pages().then(
      function (tree) {
        var node = findNode(tree, pagePath());
        if (node) {
          page.id = node.id || null;
          pageTitle = node.title || "";
        }
        readyResolve();
      },
      function () { readyResolve(); }
    );
  }
})();
