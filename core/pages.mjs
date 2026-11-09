// Page tree and CRUD. A page is a directory holding a `.noteblock` manifest (`.quire` before
// the rename, still read: core/names.mjs); any other directory
// is a plain folder. Pages are leaves: directories inside a page are its own files (assets,
// source), never rows. A path is the vault-relative directory path: "Kyoto trip/Trip budget".
import { applyOrder, readOrder } from "./order.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
import { MANIFEST, OLD_MANIFEST, MANIFESTS, manifestFile, metaPath } from "./names.mjs";
export { MANIFEST, OLD_MANIFEST, MANIFESTS };
const ENTRIES = ["index.html", "index.md"];
import { RENDERERS } from "./renderers.mjs";
import { markSearchExcluded, readSearchExclude } from "./searchExclude.mjs";
export { RENDERERS };

/** A fresh page id (10 chars, [a-z0-9]). */
export function newPageId() {
  return newId();
}

function newId() {
  const bytes = crypto.randomBytes(10);
  let id = "";
  for (const b of bytes) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Normalize a path: trim slashes, reject `.`/`..`/hidden segments. */
export function normPath(p) {
  const segs = String(p || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of segs) {
    if (s === "." || s === ".." || s.startsWith(".")) throw new Error(`Bad path: ${p}`);
  }
  return segs.join("/");
}

export function pathDir(vault, p) {
  return path.join(vault, ...normPath(p).split("/").filter(Boolean));
}

/**
 * True when dir is a page: it holds a `.noteblock` (or older `.quire`) file. The vault's own
 * `.noteblock/` (or `.quire/`) is a directory, so the vault root is never a page.
 */
export function isPageDir(dir) {
  return MANIFESTS.some((n) => {
    try {
      return fs.statSync(path.join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

/** The page's manifest, from `.noteblock`, else the older `.quire`. */
export function readManifest(dir) {
  return readJson(manifestFile(dir));
}

/** Write the manifest as `.noteblock`, removing an older `.quire` file beside it. */
export function writeManifest(dir, obj) {
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(obj, null, 2) + "\n");
  const old = path.join(dir, OLD_MANIFEST);
  try {
    if (fs.statSync(old).isFile()) fs.rmSync(old, { force: true });
  } catch {}
}

/** Return the manifest, writing an id (keeping other fields) when it has none. */
export function ensureManifest(dir) {
  const m = readManifest(dir) || {};
  if (typeof m.id === "string" && /^[a-z0-9]{10}$/.test(m.id)) return m;
  const next = { ...m, id: newId() };
  writeManifest(dir, next);
  return next;
}

/** The entry file name: manifest.entry when it exists, else index.html, else index.md. */
export function entryFile(dir, manifest = readManifest(dir)) {
  const named = manifest && typeof manifest.entry === "string" ? manifest.entry : null;
  if (named && !named.includes("..") && fs.existsSync(path.join(dir, named))) return named;
  for (const f of ENTRIES) if (fs.existsSync(path.join(dir, f))) return f;
  return named || "index.html";
}

function formatOf(file) {
  return /\.md$/i.test(file) ? "md" : "html";
}

function readLock(vault, id) {
  if (!id) return null;
  return readJson(metaPath(vault, "locks", `${id}.json`));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const PROC_NAME = /^[a-z][a-z0-9_-]{0,31}$/i;

/**
 * A page's manifest "backend": {dir, run, proxy}. `run` is a command or {name: command}; a
 * bare string is named "main". `dir` (default "backend") is never published. `proxy` names
 * the process that /api/* requests from the page go to (default "api", else the first one).
 * @returns {{dir: string, run: Record<string, string>, proxy: string|null} | null}
 */
export function parseBackend(b) {
  if (!b || typeof b !== "object") return null;
  const dir = typeof b.dir === "string" && b.dir.trim() && !b.dir.split("/").some((s) => s === ".." || s.startsWith(".")) ? b.dir.trim().replace(/^\/+|\/+$/g, "") : "backend";
  const run = {};
  if (typeof b.run === "string" && b.run.trim()) run.main = b.run.trim();
  else if (b.run && typeof b.run === "object") {
    for (const [name, cmd] of Object.entries(b.run)) if (PROC_NAME.test(name) && typeof cmd === "string" && cmd.trim()) run[name] = cmd.trim();
  }
  const names = Object.keys(run);
  const proxy = typeof b.proxy === "string" && run[b.proxy] ? b.proxy : run.api ? "api" : names[0] || null;
  return { dir, run, proxy };
}

/**
 * A page's manifest "requires": the tools its backend or build expects on the Mac, as
 * {tool: version}, e.g. {"python": "3.12"}. Informational only: Quire installs nothing, it
 * names them when one is missing. Anything that isn't a short string pair is dropped.
 * @returns {Record<string, string> | null}
 */
export function parseRequires(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(k)) continue;
    if (typeof v === "string" || typeof v === "number") out[k] = String(v).trim().slice(0, 40) || "*";
    else if (v === true) out[k] = "*";
  }
  return Object.keys(out).length ? out : null;
}

function pageNode(vault, dir, p) {
  const m = readManifest(dir) || {};
  const id = typeof m.id === "string" ? m.id : null;
  const entry = entryFile(dir, m);
  const name = p.split("/").pop();
  return {
    kind: "page",
    id,
    title: m.title || name,
    path: p,
    dir,
    entry,
    source: typeof m.source === "string" && !m.source.includes("..") ? m.source : null,
    build: typeof m.build === "string" && m.build.trim() ? m.build.trim() : null,
    renderer: RENDERERS.includes(m.renderer) ? m.renderer : "quire",
    embedHeight: m.embed && Number(m.embed.height) > 0 ? Math.round(Number(m.embed.height)) : null,
    backend: parseBackend(m.backend),
    requires: parseRequires(m.requires),
    format: fs.existsSync(path.join(dir, entry)) ? formatOf(entry) : "none",
    children: [],
    lock: readLock(vault, id),
  };
}

function readChildren(vault, dir, parentPath) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders = [];
  const items = []; // pages and plain files, sorted together
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = parentPath ? `${parentPath}/${e.name}` : e.name;
    if (e.isFile()) {
      items.push({ kind: "file", id: null, title: e.name, path: p, dir, children: [], lock: null });
      continue;
    }
    if (!e.isDirectory()) continue;
    const childDir = path.join(dir, e.name);
    if (isPageDir(childDir)) items.push(pageNode(vault, childDir, p));
    else folders.push({ kind: "folder", id: null, title: e.name, path: p, dir: childDir, children: readChildren(vault, childDir, p), lock: null });
  }
  const byName = (a, b) => collator.compare(a.path.split("/").pop(), b.path.split("/").pop());
  return applyOrder([...folders.sort(byName), ...items.sort(byName)], readOrder(dir));
}

/** One folder's rows in sidebar order ("" is the vault root), each with its whole subtree. */
export function listFolder(vault, folder) {
  return readChildren(vault, folder ? pathDir(vault, folder) : vault, folder || "");
}

/**
 * A folder's own order (core/order.mjs) when it has one. Otherwise folders first, then pages and plain files together, each by name. Folder nodes have kind
 * "folder", pages "page", and a plain file sitting in a folder (not inside a page) "file".
 * Nodes at or under a Settings › Exclude from search entry carry searchExcluded and
 * searchExcludedBy; every list a person searches filters on them.
 */
export function listTree(vault) {
  return markSearchExcluded(readChildren(vault, vault, ""), readSearchExclude(vault));
}

export function* walkTree(nodes) {
  for (const n of nodes) {
    yield n;
    yield* walkTree(n.children);
  }
}

/** ref = page path or id. Throws "No page: <ref>". */
export function findPage(vault, ref) {
  if (!ref) throw new Error(`No page: ${ref}`);
  let wanted = null;
  try {
    wanted = normPath(ref);
  } catch {}
  if (wanted) {
    const dir = pathDir(vault, wanted);
    if (isPageDir(dir)) return pageNode(vault, dir, wanted);
  }
  for (const n of walkTree(listTree(vault))) {
    if (n.kind === "page" && n.id === ref) return n;
  }
  throw new Error(`No page: ${ref}`);
}

function blankHtml(title) {
  const t = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body>\n<h1>${t}</h1>\n<p><br></p>\n</body></html>\n`;
}

// Names a Windows PC can't have as a folder, refused on every OS so a vault made on a Mac still
// syncs to a PC: the characters < > : " \ | ? * (and control characters), a trailing dot or
// space, and the reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without
// an extension).
const WIN_ILLEGAL = /[<>:"\\|?*\x00-\x1f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why `name` can't be a page or folder name (a sentence), or null when it can. */
export function nameProblem(name) {
  const n = String(name ?? "");
  if (!n.trim()) return "Names can't be empty";
  if (n.includes("/")) return "Names can't contain /";
  if (n.startsWith(".")) return "Names can't start with a dot";
  const bad = n.match(WIN_ILLEGAL);
  if (bad) return /[\x00-\x1f]/.test(bad[0]) ? "Names can't contain control characters" : `Names can't contain “${bad[0]}” (Windows doesn't allow < > : " \\ | ? *)`;
  if (/[. ]$/.test(n)) return "Names can't end with a dot or a space (Windows drops them)";
  if (WIN_RESERVED.test(n)) return `“${n}” is a name Windows keeps for itself`;
  return null;
}

/** Throw when `name` can't be a page or folder name. */
export function checkName(name) {
  const why = nameProblem(name);
  if (why) throw new Error(why);
}

/** `name` made into one that works everywhere (importers): bad characters become "-". */
export function portableName(name, fallback = "Untitled") {
  let n = String(name ?? "")
    .replace(/[/<>:"\\|?*\x00-\x1f]/g, "-")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (WIN_RESERVED.test(n)) n = n.replace(/^([^.]*)/, "$1 page");
  return n || fallback;
}

/** The parent of a new page or folder must be the vault or a folder (not a page). */
export function checkParent(vault, norm) {
  const parent = norm.split("/").slice(0, -1).join("/");
  if (!parent) return;
  const dir = pathDir(vault, parent);
  if (!fs.existsSync(dir)) throw new Error(`No folder: ${parent}`);
  if (isPageDir(dir)) throw new Error(`${parent} is a page; pages can't hold other pages or folders`);
}

/** Create a page; its parent folder must exist. Returns the new Node. */
export function createPage(vault, p, { format = "html", content } = {}) {
  const norm = normPath(p);
  if (!norm) throw new Error("Page path is empty");
  checkName(norm.split("/").pop());
  const dir = pathDir(vault, norm);
  if (fs.existsSync(dir)) throw new Error(`Already exists: ${norm}`);
  checkParent(vault, norm);
  const title = norm.split("/").pop();
  const entry = format === "md" ? "index.md" : "index.html";
  fs.mkdirSync(dir);
  writeManifest(dir, { id: newId(), entry });
  fs.writeFileSync(path.join(dir, entry), content ?? (format === "md" ? `# ${title}\n` : blankHtml(title)));
  return findPage(vault, norm);
}

/** Create a plain folder; its parent folder must exist. */
export function createFolder(vault, p) {
  const norm = normPath(p);
  if (!norm) throw new Error("Folder path is empty");
  checkName(norm.split("/").pop());
  const dir = pathDir(vault, norm);
  if (fs.existsSync(dir)) throw new Error(`Already exists: ${norm}`);
  checkParent(vault, norm);
  fs.mkdirSync(dir);
  // git ignores empty directories; a .gitkeep keeps the folder in history.
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  return { kind: "folder", id: null, title: norm.split("/").pop(), path: norm, dir, children: [], lock: null };
}

/** @returns {{file: string, format: "html"|"md", content: string, path: string}} */
/** The file a person edits: the `source` template for a built page, else the entry. */
export function editFile(node) {
  return node.source && fs.existsSync(path.join(node.dir, node.source)) ? node.source : node.entry;
}

export function readEntry(vault, ref) {
  const node = findPage(vault, ref);
  const file = editFile(node);
  const full = path.join(node.dir, file);
  const content = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  return { file, format: formatOf(file), content, path: node.path };
}

export function writeEntry(vault, ref, content) {
  const node = findPage(vault, ref);
  fs.writeFileSync(path.join(node.dir, editFile(node)), content);
}

/* ------------------------------------------------------------ a page's own files */

const SKIP_FILES = new Set([".DS_Store", "node_modules"]);
const MAX_TEXT = 2 * 1024 * 1024;

/** Absolute path of `rel` inside page dir `dir`; throws on anything that escapes it. */
export function pageFilePath(dir, rel) {
  const segs = String(rel || "").split("/").filter(Boolean);
  if (!segs.length || segs.some((s) => s === "." || s === "..")) throw new Error(`Bad file: ${rel}`);
  return path.join(dir, ...segs);
}

/**
 * Every file in a page folder as a tree: directories first, then files, each by name.
 * File = {kind: "file", name, path, size}; Dir = {kind: "dir", name, path, children}.
 */
export function listPageFiles(dir, rel = "") {
  let entries = [];
  try {
    entries = fs.readdirSync(rel ? pageFilePath(dir, rel) : dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (SKIP_FILES.has(e.name)) continue;
    const p = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) dirs.push({ kind: "dir", name: e.name, path: p, children: listPageFiles(dir, p) });
    else if (e.isFile()) files.push({ kind: "file", name: e.name, path: p, size: fs.statSync(pageFilePath(dir, p)).size });
  }
  const byName = (a, b) => collator.compare(a.name, b.name);
  return [...dirs.sort(byName), ...files.sort(byName)];
}

/** {path, size, binary, tooLarge, content} — content is null for binary or oversized files. */
export function readPageFile(dir, rel) {
  const full = pageFilePath(dir, rel);
  const size = fs.statSync(full).size;
  if (size > MAX_TEXT) return { path: rel, size, binary: false, tooLarge: true, content: null };
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8192).includes(0)) return { path: rel, size, binary: true, tooLarge: false, content: null };
  return { path: rel, size, binary: false, tooLarge: false, content: buf.toString("utf8") };
}

/** Overwrite an existing file in a page folder. */
export function writePageFile(dir, rel, content) {
  const full = pageFilePath(dir, rel);
  if (!fs.statSync(full).isFile()) throw new Error(`Not a file: ${rel}`);
  fs.writeFileSync(full, content);
}
