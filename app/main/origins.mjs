// One origin per page: `quire://p-<page id>/<page path>/<file>`. The host is the page's id, so
// a rename or move keeps its localStorage and IndexedDB; the path is the page's vault path, so
// relative URLs written in a page (`./app.js`, `../Trip budget/`) resolve exactly as they did
// on the shared `quire://vault/<page path>/` origin. A different host means a different site,
// so Chromium also gives every page (and every embed of another page) its own renderer
// process. See docs/contract.md, "Pages in the app: the quire:// protocol".
//
// Pure (no Electron): the protocol handler, ipc and the smoke scripts all use these.
import { listTree, walkTree, readManifest, ensureManifest, isPageDir, pathDir } from "../../core/index.mjs";

const HOST = /^p-([a-z0-9]{10})$/;

/** "quire://p-<id>" */
export function pageOrigin(id) {
  return "quire://p-" + id;
}

/** The page id a `quire://p-<id>` host (or origin, or URL) names; null for anything else. */
export function idOfHost(host) {
  const m = HOST.exec(String(host || "").toLowerCase());
  return m ? m[1] : null;
}

export function idOfOrigin(origin) {
  try {
    const u = new URL(String(origin || ""));
    return u.protocol === "quire:" ? idOfHost(u.host) : null;
  } catch {
    return null;
  }
}

const enc = (p) =>
  String(p || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

/** quire://p-<id>/<page path>/<file> (file "" = the page itself, with its trailing slash). */
export function pageUrl(id, pagePath, file = "") {
  return pageOrigin(id) + "/" + enc(pagePath) + "/" + enc(file);
}

/** The legacy shared-origin URL; still the iOS app's scheme, and redirected here in Electron. */
export function vaultUrl(pagePath, file = "") {
  return "quire://vault/" + enc(pagePath) + "/" + enc(file);
}

// id → page path, checked on every use (one manifest read) and rebuilt from the tree on a miss.
// Several folders can share an id (a page folder copied in Finder): they share one origin.
const cache = new Map(); // vault → Map(id → path[])

function rebuild(vault) {
  const map = new Map();
  let tree = [];
  try {
    tree = listTree(vault);
  } catch {}
  for (const n of walkTree(tree)) {
    if (n.kind !== "page") continue;
    let id = n.id;
    if (!id || !HOST.test("p-" + id)) {
      // A page whose manifest has no (valid) id yet, e.g. written by hand: give it one.
      try {
        id = ensureManifest(n.dir).id;
      } catch {
        continue;
      }
    }
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(n.path);
  }
  cache.set(vault, map);
  return map;
}

function stillThere(vault, id, p) {
  try {
    const dir = pathDir(vault, p);
    return isPageDir(dir) && (readManifest(dir) || {}).id === id;
  } catch {
    return false;
  }
}

/** Every page path with this id (usually one), or []. */
export function pathsForId(vault, id) {
  if (!id) return [];
  let map = cache.get(vault);
  let hit = map && map.get(id);
  if (!hit || !hit.every((p) => stillThere(vault, id, p))) {
    map = rebuild(vault);
    hit = map.get(id);
  }
  return hit ? hit.slice() : [];
}

/** The page an origin (`quire://p-<id>`) belongs to: its path, or null. With several folders
 * on one id, `hint` (a path from the URL) picks among them. */
export function pageForOrigin(vault, origin, hint = null) {
  const paths = pathsForId(vault, idOfOrigin(origin));
  if (!paths.length) return null;
  if (hint && paths.includes(hint)) return hint;
  return paths[0];
}

/** The id of the page at `pagePath` (writing one into its manifest when it has none), or null. */
export function idForPath(vault, pagePath) {
  try {
    const dir = pathDir(vault, pagePath);
    if (!isPageDir(dir)) return null;
    const m = readManifest(dir) || {};
    if (typeof m.id === "string" && HOST.test("p-" + m.id)) return m.id;
    const id = ensureManifest(dir).id;
    cache.delete(vault);
    return id;
  } catch {
    return null;
  }
}

/**
 * Split a `quire://p-<id>` request path for the page `pagePath`:
 * - {own: rest}    the path is inside the page (rest = file segments, maybe [])
 * - {other: segs}  some other vault path (a relative link that left the page)
 */
export function splitOwnPath(pagePath, segs) {
  const page = String(pagePath || "").split("/").filter(Boolean);
  if (segs.length >= page.length && page.every((s, i) => segs[i] === s)) return { own: segs.slice(page.length) };
  return { other: segs };
}

/** Relative embed refs resolve like the runtime's resolvePagePath: against the folder holding
 * the page; a leading "/" is the vault root. */
export function resolveRef(fromPage, src) {
  src = String(src || "").trim();
  const parts = src.startsWith("/") ? [] : String(fromPage || "").split("/").filter(Boolean).slice(0, -1);
  for (let seg of src.split("/")) {
    seg = seg.trim();
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** The page paths an HTML document embeds (`<quire-embed src="…">`), resolved from `fromPage`. */
export function embedsIn(html, fromPage) {
  const out = new Set();
  const re = /<quire-embed\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const raw = (m[2] ?? m[3] ?? m[4] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const p = resolveRef(fromPage, raw);
    if (p) out.add(p);
  }
  return [...out];
}

/** A file path inside a page that another page may read with files.read: no `..`, no dotfiles,
 * not data/, not the backend folder, not node_modules. Returns the clean relative path. */
export function readablePageFile(rel, backendDir = null) {
  const segs = String(rel || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (!segs.length) throw new Error("files.read: a file path is required");
  for (const s of segs) {
    if (s === ".." || s.startsWith(".") || s.includes("\0")) throw new Error(`files.read: not allowed: ${rel}`);
  }
  if (segs[0] === "data" || segs[0] === "node_modules") throw new Error(`files.read: not allowed: ${rel}`);
  const joined = segs.join("/");
  if (backendDir && (joined === backendDir || joined.startsWith(backendDir + "/"))) throw new Error(`files.read: not allowed: ${rel}`);
  return joined;
}

/** Give every page in the vault an id (its origin) now, and index them. */
export function ensurePageIds(vault) {
  rebuild(vault);
}

/** Forget the id index (tests). */
export function clearOriginCache() {
  cache.clear();
}
