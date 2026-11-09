// Import a Claude artifact (a claude.ai HTML page, sometimes with extra files) as a Quire page.
// The source is a local file or folder that Claude or the user already has: Claude Code's
// Artifact tool `read` saves the page to disk, and claude.ai's "Download" gives a file. The
// page lands in <folder>/<Name>/ with `"origin": {kind: "claude-artifact", url, importedAt}` in
// its .noteblock; importing the same url again replaces that page's files instead of adding a page.
import fs from "node:fs";
import path from "node:path";
import { normPath, pathDir, isPageDir, readManifest, writeManifest, newPageId, listTree, walkTree, portableName } from "./pages.mjs";
import { getLock } from "./lock.mjs";
import { isManifestName } from "./names.mjs";
import { commitAll } from "./git.mjs";

export const ARTIFACT_KIND = "claude-artifact";
const SKIP = new Set([".DS_Store", ".git", "node_modules", "data", ".noteblock", ".quire"]);

const cleanName = (name) => portableName(String(name || "").replace(/\s+/g, " ").slice(0, 120), ""); // pages.mjs

function decode(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The page title in an HTML or markdown document: <title>, else the first h1 / `# `. */
export function artifactTitle(content, format = "html") {
  const text = String(content || "");
  if (format === "md") {
    const m = /^#\s+(.+?)\s*#*\s*$/m.exec(text.replace(/^---\n[\s\S]*?\n---\n/, ""));
    return m ? m[1].trim() : "";
  }
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (t && decode(t[1])) return decode(t[1]);
  const h = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
  return h ? decode(h[1]) : "";
}

/** What a source holds: {kind: "file"|"dir", entry (name in the page), from (abs entry file)}. */
function inspect(src) {
  if (!fs.existsSync(src)) throw new Error(`No such file: ${src}`);
  if (fs.statSync(src).isFile()) {
    if (/\.html?$/i.test(src)) return { kind: "file", entry: "index.html", from: src };
    if (/\.(md|markdown)$/i.test(src)) return { kind: "file", entry: "index.md", from: src };
    throw new Error(`Not an artifact (.html or .md): ${src}`);
  }
  const names = fs.readdirSync(src);
  for (const n of ["index.html", "index.htm", "index.md"]) {
    if (names.includes(n)) return { kind: "dir", entry: n === "index.htm" ? "index.html" : n, rename: n, from: path.join(src, n) };
  }
  const html = names.filter((n) => /\.html?$/i.test(n));
  if (html.length === 1) return { kind: "dir", entry: "index.html", rename: html[0], from: path.join(src, html[0]) };
  throw new Error(`No index.html in ${src}`);
}

/** Copy a folder's files into dest (skipping dotfiles, node_modules, data/), renaming one. */
function copyDir(from, to, rename, entry) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const s = path.join(from, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(path.join(to, e.name), { recursive: true });
      copyDir(s, path.join(to, e.name));
    } else if (e.isFile()) {
      fs.copyFileSync(s, path.join(to, rename && e.name === rename ? entry : e.name));
    }
  }
}

/** Remove a page's own files, keeping its manifest and data/ (the person's stored rows). */
function clearPage(dir) {
  for (const e of fs.readdirSync(dir)) {
    if (isManifestName(e) || e === "data") continue;
    fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  }
}

/** Make every missing segment of a folder path, each with a .gitkeep; refuse pages. */
function ensureFolder(vault, rel) {
  let cur = vault;
  for (const seg of rel ? rel.split("/") : []) {
    cur = path.join(cur, seg);
    if (fs.existsSync(cur)) {
      if (!fs.statSync(cur).isDirectory() || isPageDir(cur)) throw new Error(`${rel} is inside a page; pick a folder`);
    } else {
      fs.mkdirSync(cur);
      fs.writeFileSync(path.join(cur, ".gitkeep"), "");
    }
  }
}

/** The page whose manifest origin is this artifact url, or null. */
export function findArtifactPage(vault, url) {
  if (!url) return null;
  for (const n of walkTree(listTree(vault))) {
    if (n.kind !== "page") continue;
    const o = (readManifest(n.dir) || {}).origin;
    if (o && o.kind === ARTIFACT_KIND && o.url === url) return n;
  }
  return null;
}

/**
 * Import a Claude artifact as a page.
 * @param {string} vault
 * @param {{source: string, name?: string, folder?: string, url?: string, commit?: boolean, skipExisting?: boolean}} opts
 *   source: an .html or .md file, or a folder holding index.html (or index.md) plus its files.
 *   skipExisting: when a page already has this url, leave it alone and return {skipped: true}.
 * @returns {{path: string, dir: string, title: string, updated: boolean, skipped?: boolean, commit: string|null}}
 */
export function importArtifact(vault, { source, name, folder = "Artifacts", url, commit = true, skipExisting = false } = {}) {
  const src = path.resolve(String(source || ""));
  if (!source) throw new Error("No artifact file given");
  if (skipExisting) {
    const had = findArtifactPage(vault, url);
    if (had) return { path: had.path, dir: had.dir, title: (readManifest(had.dir) || {}).title || had.path.split("/").pop(), updated: false, skipped: true, commit: null };
  }
  const info = inspect(src);
  const format = info.entry.endsWith(".md") ? "md" : "html";
  const title = artifactTitle(fs.readFileSync(info.from, "utf8"), format);
  const origin = { kind: ARTIFACT_KIND, ...(url ? { url: String(url) } : {}), importedAt: new Date().toISOString() };

  let rel;
  let dir;
  let manifest;
  const existing = findArtifactPage(vault, url);
  if (existing) {
    if (getLock(vault, existing.id)) throw new Error(`${existing.path} is being edited; run noteblock done or noteblock abort first`);
    rel = existing.path;
    dir = existing.dir;
    manifest = readManifest(dir) || {};
    clearPage(dir);
  } else {
    const folderRel = normPath(folder);
    ensureFolder(vault, folderRel);
    const base =
      cleanName(name) || cleanName(title) || cleanName(path.basename(src).replace(/\.(html?|md|markdown)$/i, "")) || "Untitled artifact";
    for (let i = 1; ; i++) {
      const n = i === 1 ? base : `${base} ${i}`;
      rel = folderRel ? `${folderRel}/${n}` : n;
      if (!fs.existsSync(pathDir(vault, rel))) break;
    }
    dir = pathDir(vault, rel);
    fs.mkdirSync(dir);
    manifest = { id: newPageId() };
  }

  if (info.kind === "file") fs.copyFileSync(src, path.join(dir, info.entry));
  else copyDir(src, dir, info.rename, info.entry);
  if (!info.entry.endsWith(".md")) untheme(path.join(dir, info.entry));

  const folderName = rel.split("/").pop();
  const next = { ...manifest, entry: info.entry, origin };
  if (title && title !== folderName) next.title = title;
  else delete next.title;
  writeManifest(dir, next);

  const sha = commit ? commitAll(vault, `${existing ? "Update" : "Import"} artifact ${rel}`) : null;
  return { path: rel, dir, title: next.title || folderName, updated: !!existing, commit: sha };
}

/**
 * An artifact brings its own layout, so it opts out of Quire's theme (which caps the body at
 * 700px and restyles headings, lists and tables): `<body data-q-theme="none">`. A body that
 * already says which theme it wants is left alone. Returns true when the file changed.
 */
export function untheme(file) {
  let html;
  try {
    html = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const m = /<body\b[^>]*>/i.exec(html);
  if (!m || /\bdata-q-theme\s*=/i.test(m[0])) return false;
  const tag = m[0].replace(/^<body\b/i, '<body data-q-theme="none"');
  fs.writeFileSync(file, html.slice(0, m.index) + tag + html.slice(m.index + m[0].length));
  return true;
}

/** Every imported artifact page in the vault gets untheme() (for pages imported before it existed). */
export function unthemeArtifacts(vault) {
  const changed = [];
  const walk = (dir, rel) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && isPageDir(dir)) {
      const m = readManifest(dir) || {};
      if (m.origin && m.origin.kind === "claude-artifact" && m.entry && !m.entry.endsWith(".md") && untheme(path.join(dir, m.entry))) changed.push(rel);
      return;
    }
    for (const e of names) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(dir, e.name), rel ? rel + "/" + e.name : e.name);
  };
  walk(vault, "");
  return changed;
}

/**
 * Import several downloaded artifacts (files, artifact folders, or folders of .html/.md files)
 * into one folder, as one commit. A folder with an index.html (or index.md) becomes one page;
 * any other folder gives one page per .html/.md file in it.
 * @param {string} vault
 * @param {{sources: string[], folder?: string}} opts
 * @returns {{pages: number, first: string|null, dest: string, errors: {source: string, error: string}[], commit: string|null}}
 */
export function importArtifactFiles(vault, { sources = [], folder = "Artifacts" } = {}) {
  const list = [];
  for (const s of sources) {
    const abs = path.resolve(String(s));
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {}
    if (!isDir) {
      list.push(abs);
      continue;
    }
    const names = fs.readdirSync(abs);
    const files = names.filter((n) => !n.startsWith(".") && /\.(html?|md|markdown)$/i.test(n)).sort();
    if (names.some((n) => /^index\.(html?|md)$/i.test(n)) || !files.length) list.push(abs); // one page (or "No index.html in …")
    else list.push(...files.map((n) => path.join(abs, n)));
  }
  const errors = [];
  const done = [];
  for (const source of list) {
    try {
      done.push(importArtifact(vault, { source, folder, commit: false }).path);
    } catch (e) {
      errors.push({ source, error: String(e?.message || e) });
    }
  }
  const dest = normPath(folder);
  const sha = done.length ? commitAll(vault, `Import ${done.length === 1 ? `artifact ${done[0]}` : `${done.length} artifacts into ${dest || "the top level"}`}`) : null;
  return { pages: done.length, first: done[0] || null, dest, errors, commit: sha };
}
