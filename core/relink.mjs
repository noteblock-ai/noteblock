// Keep links working when a page or folder moves (docs/contract.md, Links). Runs after the rename,
// over the html and md entry file of every page: inbound links follow the move, a moved page's
// relative links to things outside it are recomputed for its new depth. Only the link's bytes
// change; a link that still reaches the same place is left exactly as it was.
//
// Two ways to resolve, both the runtime's (app/runtime/runtime.js):
//  - a URL (<a href>, <img src>, a markdown link) goes by the page's folder URL, as pageLinkHref:
//    "../Other/" from "Garden/Home" is "Garden/Other". Percent-encoded.
//  - an embed src (<quire-embed>, ![[…]]) goes by the folder holding the page, as resolvePagePath:
//    "Other" from "Garden/Home" is "Garden/Other". Not encoded: the runtime never decodes it.
import fs from "node:fs";
import path from "node:path";
import { parse } from "node-html-parser";
import { normPath, listTree, walkTree, editFile } from "./pages.mjs";
import { buildInfo, isBuildOutput } from "./build.mjs";
import { getLock } from "./lock.mjs";
import { splitFrontmatter } from "./html.mjs";

// Which attribute of a tag names another place. Scripts' and stylesheets' own text isn't parsed.
const LINK_ATTR = {
  a: "href",
  area: "href",
  link: "href",
  img: "src",
  video: "src",
  audio: "src",
  source: "src",
  iframe: "src",
  embed: "src",
  script: "src",
  "quire-embed": "src",
  "noteblock-embed": "src",
};
const EMBED_TAG = new Set(["quire-embed", "noteblock-embed"]);
const YIELD_MS = 12;

const nfc = (s) => s.normalize("NFC");
const sameSegs = (a, b) => a.length === b.length && a.every((s, i) => nfc(s) === nfc(b[i]));
const isUnder = (segs, root) => segs.length >= root.length && root.every((s, i) => nfc(s) === nfc(segs[i]));
const decodeSeg = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const decodeEntities = (s) =>
  s.includes("&")
    ? s.replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, dec, hex) => {
        if (dec) return String.fromCodePoint(Number(dec));
        if (hex) return String.fromCodePoint(parseInt(hex, 16));
        return { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[m.toLowerCase()];
      })
    : s;

/** Where `head` lands from `base`, the way both resolvers do: "." and empty go, ".." pops. */
function resolveSegs(base, head, decode, trim) {
  const out = [...base];
  let climbedOut = false;
  for (let seg of head.split("/")) {
    if (trim) seg = seg.trim();
    if (!seg || seg === ".") continue;
    if (seg === "..") climbedOut = out.pop() === undefined || climbedOut;
    else out.push(decode ? decodeSeg(seg) : seg);
  }
  out.climbedOut = climbedOut;
  return out;
}

/** Whether `rel`, read from `base`, still lands on `next`. A moved page that used to need more
 * "../" than it has now reaches the same place only because a URL stops at the root: tidy that. */
function stillReaches(base, rel, next, m, decode, trim) {
  const at = resolveSegs(base, rel, decode, trim);
  return sameSegs(at, next) && !(at.climbedOut && !sameSegs(m.oldPage, m.newPage));
}

/** The relative path from folder `base` to `target`, as pageLinkHref writes it. */
function relativePath(base, target, slash, encode) {
  let common = 0;
  while (common < base.length && common < target.length && nfc(base[common]) === nfc(target[common])) common++;
  const ups = "../".repeat(base.length - common);
  const rest = target.slice(common).map(encode).join("/");
  if (rest) return ups + rest + (slash ? "/" : "");
  if (!ups) return slash ? "./" : ".";
  return slash ? ups : ups.slice(0, -1);
}

/** Replacement for a URL, or null when it stays. `raw` is as written, entities and all. */
function nextUrl(raw, m, encode) {
  const text = raw.trim();
  // The first ? or # that isn't inside an entity (&#39;) ends the path; what follows is kept as written.
  let cut = text.length;
  for (const hit of text.matchAll(/&#?[a-z0-9]+;|[?#]/gi)) {
    if (hit[0].length === 1) {
      cut = hit.index;
      break;
    }
  }
  const head = decodeEntities(text.slice(0, cut));
  const tail = text.slice(cut);
  if (!head || /\{\{|\$\{|<%/.test(head)) return null;

  let prefix = null; // an absolute link keeps its form
  let rel = head;
  const q = /^quire:\/\/([^/]*)(\/.*)?$/i.exec(head);
  if (q) {
    if (q[1].toLowerCase() === "runtime") return null;
    prefix = `quire://${q[1]}/`;
    rel = q[2] || "";
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(head) || head.startsWith("//")) return null;
  else if (head[0] === "/") {
    prefix = "/";
    rel = head;
  }

  const slash = /\/\.?$/.test(rel);
  const target = resolveSegs(prefix ? [] : m.oldPage, rel, true, false);
  const next = isUnder(target, m.from) ? [...m.to, ...target.slice(m.from.length)] : target;
  if (prefix) {
    if (sameSegs(next, target)) return null;
    return prefix + next.map(encode).join("/") + (slash && next.length ? "/" : "") + tail;
  }
  if (stillReaches(m.newPage, rel, next, m, true, false)) return null;
  return relativePath(m.newPage, next, slash, encode) + tail;
}

/** Replacement for an embed src (already free of entities), or null when it stays. */
function nextEmbed(value, m) {
  const src = value.trim();
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || /\{\{|\$\{|<%/.test(src)) return null;
  // The runtime reads a src as plain text; someone's "Kyoto%20trip" stays in that form.
  const encoded = /%[0-9a-f]{2}/i.test(src);
  const encode = encoded ? encodeURIComponent : (s) => s;
  const absolute = src[0] === "/";
  const slash = src.endsWith("/");
  const target = resolveSegs(absolute ? [] : m.oldPage.slice(0, -1), src, encoded, true);
  const next = isUnder(target, m.from) ? [...m.to, ...target.slice(m.from.length)] : target;
  if (absolute) {
    if (sameSegs(next, target)) return null;
    return "/" + next.map(encode).join("/") + (slash && next.length ? "/" : "");
  }
  if (stillReaches(m.newPage.slice(0, -1), src, next, m, encoded, true)) return null;
  return relativePath(m.newPage.slice(0, -1), next, slash, encode);
}

const ATTR = /\s*([^\s=/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?|\s*\//y;

/** An edit for the link attribute of the start tag at `start`, if it needs one. */
function tagEdit(text, start, m) {
  const name = /^<([a-zA-Z][\w:-]*)/.exec(text.slice(start, start + 64));
  if (!name) return null;
  const tag = name[1].toLowerCase();
  const wanted = LINK_ATTR[tag];
  if (!wanted) return null;
  let at = start + name[0].length;
  for (;;) {
    ATTR.lastIndex = at;
    const a = ATTR.exec(text);
    if (!a || a[0].length === 0) return null;
    at = ATTR.lastIndex;
    if (a[1]?.toLowerCase() !== wanted) continue;
    if (a[2] == null) return null; // only the first one counts, in a browser too
    const written = a[2];
    const quote = written[0] === '"' || written[0] === "'" ? written[0] : "";
    const inner = quote ? written.slice(1, -1) : written;
    const next = EMBED_TAG.has(tag) ? nextEmbed(decodeEntities(inner), m) : nextUrl(inner, m, encodeURIComponent);
    if (next == null) return null;
    const useQuote = quote || (/\s/.test(next) ? '"' : "");
    // A URL's tail is copied as written, so only a character that would end the value needs escaping.
    const safe = EMBED_TAG.has(tag) ? next.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : next;
    const value = useQuote === '"' ? safe.replace(/"/g, "&quot;") : useQuote === "'" ? safe.replace(/'/g, "&#39;") : safe;
    return [at - written.length, at, useQuote + value + useQuote];
  }
}

function htmlEdits(html, m) {
  const root = parse(html, { comment: false, lowerCaseTagName: false, blockTextElements: { script: true, noscript: true, style: true, textarea: true } });
  const edits = [];
  const visit = (el) => {
    for (const child of el.childNodes || []) {
      if (child.nodeType !== 1) continue;
      const start = child.range?.[0];
      if (start != null && html[start] === "<") {
        const e = tagEdit(html, start, m);
        if (e) edits.push(e);
      }
      visit(child);
    }
  };
  visit(root);
  return edits;
}

/** Same length as `md`, with everything that isn't live markdown blanked (line ends stay). */
function maskMarkdown(md) {
  const blanks = []; // [start, end)
  const { frontmatter } = splitFrontmatter(md);
  if (frontmatter) blanks.push([0, frontmatter.length]);

  // Fenced and indented code, line by line.
  let fence = null;
  let prevBlank = true;
  let inCode = false;
  let inList = false;
  const lineRe = /[^\n]*(?:\n|$)/g;
  for (let hit = lineRe.exec(md); hit && hit[0]; hit = lineRe.exec(md)) {
    const at = hit.index;
    const line = hit[0].replace(/\r?\n$/, "");
    const end = at + hit[0].length;
    if (at < (frontmatter ? frontmatter.length : 0)) continue;
    if (fence) {
      const close = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      blanks.push([at, end]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      prevBlank = false;
      continue;
    }
    const open = /^[ \t>]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = open[1];
      blanks.push([at, end]);
      prevBlank = false;
      continue;
    }
    const blank = !line.trim();
    if (!blank) {
      const indented = /^(?: {4}|\t)/.test(line);
      if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]/.test(line)) inList = true;
      else if (!indented && prevBlank) inList = false;
      inCode = indented && !inList && (prevBlank || inCode);
      if (inCode) blanks.push([at, end]);
    }
    prevBlank = blank;
    if (end >= md.length) break;
  }

  const live = blankOut(md, blanks);
  // Inline code: a run of backticks up to the next run of the same length, in the same paragraph.
  const inline = [];
  for (let i = 0; i < live.length; i++) {
    if (live[i] !== "`" || live[i - 1] === "\\") continue;
    let n = 1;
    while (live[i + n] === "`") n++;
    let j = i + n;
    let closed = -1;
    for (; j < live.length; j++) {
      if (live[j] === "\n" && /^\r?\n[ \t]*\r?\n/.test(live.slice(j, j + 80))) break;
      if (live[j] !== "`") continue;
      let k = 1;
      while (live[j + k] === "`") k++;
      if (k === n) {
        closed = j;
        break;
      }
      j += k - 1;
    }
    if (closed >= 0) {
      inline.push([i, closed + n]);
      i = closed + n - 1;
    } else i += n - 1;
  }
  const noCode = blankOut(live, inline);
  // Raw HTML whose text isn't live either.
  const raw = [];
  for (const hit of noCode.matchAll(/<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style|textarea)\b[\s\S]*?<\/\1\s*>/gi)) raw.push([hit.index, hit.index + hit[0].length]);
  return blankOut(noCode, raw);
}

function blankOut(text, ranges) {
  if (!ranges.length) return text;
  let out = "";
  let at = 0;
  for (const [s, e] of ranges) {
    out += text.slice(at, s) + text.slice(s, e).replace(/[^\r\n]/g, " ");
    at = e;
  }
  return out + text.slice(at);
}

// A parenthesis would end the link early; the rest is pageLinkHref's encoding.
const encodeMd = (s) => encodeURIComponent(s).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));

function mdEdits(md, m) {
  const live = maskMarkdown(md);
  const edits = [];
  const url = (start, written) => {
    if (written[0] === "<" && written.endsWith(">")) {
      const next = nextUrl(written.slice(1, -1), m, encodeMd);
      if (next != null) edits.push([start + 1, start + written.length - 1, next]);
    } else {
      const next = nextUrl(written, m, encodeMd);
      if (next != null) edits.push([start, start + written.length, next]);
    }
  };
  // [x](dest "title"), ![x](dest): an untitled dest with one level of balanced parentheses.
  for (const hit of live.matchAll(/(?<!\\)\]\([ \t]*(<[^<>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)(?=[ \t]*\)|[ \t]+["'(])/g)) {
    url(hit.index + hit[0].length - hit[1].length, hit[1]);
  }
  // [ref]: dest
  for (const hit of live.matchAll(/^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(<[^<>\n]*>|\S+)/gm)) {
    url(hit.index + hit[0].length - hit[1].length, hit[1]);
  }
  // ![[Page]] on its own line: an embed (core/html.mjs EMBED_LINE).
  for (const hit of live.matchAll(/^ {0,3}!\[\[([^\]\n]+)\]\][ \t]*\r?$/gm)) {
    const next = nextEmbed(hit[1], m);
    if (next == null) continue;
    const at = hit.index + hit[0].indexOf("[[") + 2 + (hit[1].length - hit[1].trimStart().length);
    edits.push([at, at + hit[1].trim().length, next]);
  }
  // Raw HTML in markdown.
  for (const hit of live.matchAll(/<[a-zA-Z][\w:-]*/g)) {
    const e = tagEdit(live, hit.index, m);
    if (e) edits.push(e);
  }
  return edits;
}

/** What to look for before parsing a file: the name's longest run that no encoding changes. */
function needles(name) {
  const run = (name.match(/[A-Za-z0-9_.~-]+/g) || []).sort((a, b) => b.length - a.length)[0] || "";
  if (run.length >= 3) return [run.toLowerCase()];
  const forms = new Set();
  for (const s of [name, name.normalize("NFC"), name.normalize("NFD")]) {
    forms.add(s);
    forms.add(encodeURIComponent(s));
    forms.add(encodeURI(s));
    forms.add(s.replace(/&/g, "&amp;"));
  }
  return [...forms].map((s) => s.toLowerCase());
}

/** The file of a page that can hold its links; null for build output or a file of another kind. */
function linkFile(node) {
  const file = editFile(node);
  if (!/\.(html?|md)$/i.test(file)) return null;
  return isBuildOutput(node.build ? buildInfo(node.dir) : null, file) ? null : file;
}

/**
 * The text of an entry file with its links fixed for a move, or null when nothing changes.
 * @param {string} text
 * @param {"html"|"md"} format
 * @param {{oldPage: string, newPage: string, from: string, to: string}} move vault paths
 */
export function relinkText(text, format, { oldPage, newPage, from, to }) {
  const m = {
    oldPage: oldPage.split("/"),
    newPage: newPage.split("/"),
    from: from.split("/"),
    to: to.split("/"),
  };
  const edits = format === "md" ? mdEdits(text, m) : htmlEdits(text, m);
  if (!edits.length) return null;
  edits.sort((a, b) => b[0] - a[0]);
  let out = text;
  let floor = Infinity;
  for (const [s, e, value] of edits) {
    if (e > floor) continue; // a markdown link inside a raw tag's attribute: one edit is enough
    out = out.slice(0, s) + value + out.slice(e);
    floor = s;
  }
  return out === text ? null : out;
}

/**
 * Fix every link a finished move broke, in the entry file of every page in the vault. Call it
 * after the rename. A page an agent has locked is skipped and named, if it needs a change.
 * Yields to the event loop between files, never between reading a file and writing it.
 * @param {string} vault
 * @param {string} from vault path before the move
 * @param {string} to vault path after it
 * @returns {Promise<{relinked: string[], skipped: string[]}>} relinked: vault paths of the
 *   rewritten files, to commit with the move. skipped: vault paths of the pages left alone.
 */
export async function rewriteLinksForMove(vault, from, to) {
  const src = normPath(from);
  const dst = normPath(to);
  const relinked = [];
  const skipped = [];
  const wanted = needles(src.split("/").pop());
  let slice = performance.now();
  for (const node of walkTree(listTree(vault))) {
    if (node.kind !== "page") continue;
    if (performance.now() - slice > YIELD_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      slice = performance.now();
    }
    const moved = node.path === dst || node.path.startsWith(dst + "/");
    const file = linkFile(node);
    if (!file) continue;
    const full = path.join(node.dir, file);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    const text = buf.toString("utf8");
    const low = text.toLowerCase();
    // A moved page can break a link without naming the moved folder: a way out, or an embed.
    const maybe = wanted.some((n) => low.includes(n)) || (moved && (text.includes("..") || low.includes("-embed") || text.includes("![[")));
    if (!maybe) continue;
    // Not UTF-8: a round trip through a string would change bytes this has no business touching.
    if (!Buffer.from(text, "utf8").equals(buf)) continue;
    const oldPage = moved ? src + node.path.slice(dst.length) : node.path;
    let next;
    try {
      next = relinkText(text, /\.md$/i.test(file) ? "md" : "html", { oldPage, newPage: node.path, from: src, to: dst });
    } catch (err) {
      console.error(`[noteblock] relink ${node.path}:`, err.message);
      skipped.push(node.path);
      continue;
    }
    if (next == null) continue;
    if (node.id && getLock(vault, node.id)) {
      skipped.push(node.path);
      continue;
    }
    fs.writeFileSync(full, next);
    relinked.push(`${node.path}/${file}`);
  }
  return { relinked, skipped };
}
