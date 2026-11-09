// Sidebar drag and drop: where a dragged row lands, and files dropped from Finder or Explorer.
// The app's half (autosaves, backends, telling the windows) is ipc.mjs moveDropped.
import fs from "node:fs";
import path from "node:path";
import { normPath, pathDir, isPageDir, checkName, checkParent, newPageId, portableName, writeManifest } from "./pages.mjs";
import { commitPaths } from "./git.mjs";
import { untheme } from "./artifacts.mjs";

const SKIP = new Set([".git", ".noteblock", ".quire", ".DS_Store", "node_modules"]);
const INDEX_ORDER = ["index.html", "index.htm", "index.md"];

/**
 * The folder a drop on `rel` lands in: `rel` itself when it's a folder (or "" for the vault),
 * otherwise the folder holding the page or file it names. Pages don't hold pages.
 */
export function dropFolder(vault, rel) {
  const segs = normPath(rel).split("/").filter(Boolean);
  for (let i = 1; i <= segs.length; i++) {
    const at = segs.slice(0, i).join("/");
    const dir = pathDir(vault, at);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      throw new Error(`No folder: ${at}`);
    }
    if (!st.isDirectory() || isPageDir(dir)) return segs.slice(0, i - 1).join("/");
  }
  return segs.join("/");
}

/** The path `from` gets when dropped on `folder`, or null when that changes nothing or can't be. */
export function dropMoveTarget(vault, from, folder) {
  const src = normPath(from);
  if (!src) return null;
  const dest = dropFolder(vault, folder);
  if (dest === src || dest.startsWith(src + "/")) return null;
  const name = src.split("/").pop();
  const to = dest ? `${dest}/${name}` : name;
  return to === src ? null : to;
}

/** The path `from` gets when renamed to `name`, or null when that changes nothing. */
export function renameTarget(from, name) {
  const src = normPath(from);
  if (!src) throw new Error("The vault itself can't be renamed");
  const clean = String(name ?? "").trim();
  checkName(clean);
  const parent = src.split("/").slice(0, -1).join("/");
  const to = parent ? `${parent}/${clean}` : clean;
  return to === src ? null : to;
}

/** True when `rel` is a plain file sitting in a folder of the vault. */
export function isPlainFile(vault, rel) {
  try {
    return fs.lstatSync(pathDir(vault, rel)).isFile();
  } catch {
    return false;
  }
}

/** Throws when `rel` sits inside a page: that's one of the page's own files. */
function checkNotInPage(vault, rel) {
  const segs = rel.split("/");
  for (let i = 1; i < segs.length; i++) {
    if (isPageDir(pathDir(vault, segs.slice(0, i).join("/")))) throw new Error(`${rel} is a file of the page ${segs.slice(0, i).join("/")}`);
  }
}

/** Move a plain file (core/move.mjs does pages and folders). Returns {from, to, kind: "file"}. */
export function moveFile(vault, from, to) {
  const src = normPath(from);
  const dst = normPath(to);
  if (!isPlainFile(vault, src)) throw new Error(`No file ${src}`);
  checkNotInPage(vault, src);
  checkName(dst.split("/").pop());
  if (fs.existsSync(pathDir(vault, dst))) throw new Error(`Already exists: ${dst}`);
  checkParent(vault, dst);
  fs.renameSync(pathDir(vault, src), pathDir(vault, dst));
  return { from: src, to: dst, kind: "file" };
}

/**
 * What a dropped path becomes, from its name and contents: {kind: "page", entry, from} for an
 * .html, .htm or .md file or a folder holding an index, {kind: "file"} for any other file.
 * Throws on a folder with no index.
 */
export function classifyDrop(source) {
  const name = path.basename(source);
  const st = fs.statSync(source);
  if (st.isDirectory()) {
    const names = fs.readdirSync(source);
    for (const want of INDEX_ORDER) {
      const from = names.find((n) => n.toLowerCase() === want);
      if (from) return { kind: "page", entry: want === "index.md" ? "index.md" : "index.html", from };
    }
    throw new Error(`No index.html or index.md in ${name}`);
  }
  if (!st.isFile()) throw new Error(`${name} isn't a file or folder`);
  if (/\.html?$/i.test(name)) return { kind: "page", entry: "index.html", from: null };
  if (/\.md$/i.test(name)) return { kind: "page", entry: "index.md", from: null };
  return { kind: "file" };
}

const within = (p, root) => p === root || p.startsWith(root + path.sep);

/** `base` (+ `ext`) in `folder`, or "base 2", "base 3"… when that's taken. Returns the rel path. */
function freeName(vault, folder, base, ext = "") {
  for (let i = 1; ; i++) {
    const n = (i === 1 ? base : `${base} ${i}`) + ext;
    const rel = folder ? `${folder}/${n}` : n;
    if (!fs.existsSync(pathDir(vault, rel))) return rel;
  }
}

function copyTree(from, to) {
  fs.mkdirSync(to);
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b); // not symlinks: they could point out of the vault
  }
}

function importOne(vault, source, folder) {
  if (!path.isAbsolute(String(source))) throw new Error(`Not a file: ${source}`);
  const src = fs.realpathSync(source);
  const root = fs.realpathSync(vault);
  const label = path.basename(source);
  if (within(src, root)) throw new Error(`${label} is already in this vault`);
  if (within(root, src)) throw new Error(`${label} holds this vault`);
  const drop = classifyDrop(src);
  const isDir = fs.statSync(src).isDirectory();

  let rel;
  if (drop.kind === "file") {
    const ext = path.extname(label);
    const cleanExt = portableName(ext.slice(1), "");
    rel = freeName(vault, folder, portableName(path.basename(label, ext)), cleanExt ? "." + cleanExt : "");
  } else {
    rel = freeName(vault, folder, portableName(isDir ? label : label.replace(/\.(html?|md)$/i, "")));
  }
  checkName(rel.split("/").pop());
  const dest = pathDir(vault, rel);
  if (!within(path.join(fs.realpathSync(path.dirname(dest)), path.basename(dest)), root)) throw new Error(`${label} would land outside the vault`);

  if (drop.kind === "file") {
    fs.copyFileSync(src, dest);
    return { path: rel, kind: "file" };
  }
  try {
    if (isDir) {
      copyTree(src, dest);
      if (drop.from !== drop.entry) fs.renameSync(path.join(dest, drop.from), path.join(dest, drop.entry));
    } else {
      fs.mkdirSync(dest);
      fs.copyFileSync(src, path.join(dest, drop.entry));
    }
    // Same as an imported artifact: it brings its own layout, not the page theme.
    if (drop.entry === "index.html") untheme(path.join(dest, drop.entry));
    writeManifest(dest, { id: newPageId(), entry: drop.entry });
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  return { path: rel, kind: "page" };
}

/**
 * Make a plain .html, .htm or .md file in the vault a page where it sits, named after the file
 * ("Plan.html" becomes the page "Plan", or "Plan 2" when that's taken), as one commit.
 * Returns {from, to, kind: "page", commit}.
 * @param {string} vault
 * @param {string} rel
 * @param {{commit?: boolean}} [opts]
 */
export function convertFileToPage(vault, rel, { commit = true } = {}) {
  const src = normPath(rel);
  if (!isPlainFile(vault, src)) throw new Error(`Not a file: ${src}`);
  checkNotInPage(vault, src);
  const file = pathDir(vault, src);
  const { kind, entry } = classifyDrop(file);
  if (kind !== "page") throw new Error("Only .html, .htm and .md files can become pages");
  const segs = src.split("/");
  const name = segs.pop();
  const to = freeName(vault, segs.join("/"), portableName(name.replace(/\.(html?|md)$/i, "")));
  checkName(to.split("/").pop());
  const dest = pathDir(vault, to);
  const inside = path.join(dest, entry);
  fs.mkdirSync(dest);
  try {
    fs.renameSync(file, inside);
    if (entry === "index.html") untheme(inside);
    writeManifest(dest, { id: newPageId(), entry });
  } catch (e) {
    if (fs.existsSync(inside)) fs.renameSync(inside, file);
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  const sha = commit ? commitPaths(vault, `Convert ${src} to a page`, [src, to]) : null;
  return { from: src, to, kind: "page", commit: sha };
}

/**
 * Copy files and folders from outside the vault into `folder` as one commit. Sources stay as
 * they are. Returns {imported: [{path, kind}], errors: [{source, error}], folder, commit}.
 * @param {string} vault
 * @param {{sources?: string[], folder?: string, commit?: boolean}} [opts]
 */
export function importDropped(vault, { sources = [], folder = "", commit = true } = {}) {
  const dest = dropFolder(vault, folder);
  const imported = [];
  const errors = [];
  for (const source of sources) {
    try {
      imported.push(importOne(vault, source, dest));
    } catch (e) {
      errors.push({ source, error: String(e?.message || e) });
    }
  }
  const paths = imported.map((i) => i.path);
  const message = paths.length === 1 ? `Import ${paths[0]}` : `Import ${paths.length} items into ${dest || "the top level"}`;
  const sha = commit && paths.length ? commitPaths(vault, message, paths) : null;
  return { imported, errors, folder: dest, commit: sha };
}
