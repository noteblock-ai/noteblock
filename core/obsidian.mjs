// Import an Obsidian vault. Every note becomes a page (as markdown, or converted to an HTML
// page), every folder that holds notes a folder, under `dest` in the Quire vault. Wikilinks
// and markdown links between notes become page links, ![[note]] embeds become Quire embeds,
// and the images/files a note links are copied into its page folder. Every other file (PDFs,
// .canvas boards, images no note links) comes along as a plain file in its folder.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normPath, pathDir, isPageDir, writeManifest, newPageId, portableName } from "./pages.mjs";
import { renderMarkdown, splitFrontmatter } from "./html.mjs";
import { commitAll } from "./git.mjs";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i;
const HEIC = /\.(heic|heif)$/i;
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

/** What an Obsidian vault holds, for the import screen. */
export function scanObsidian(source) {
  const abs = path.resolve(String(source || ""));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Not a folder: ${abs}`);
  const { notes, files } = walk(abs);
  if (!notes.length) throw new Error("No notes (.md files) in that folder");
  return { source: abs, name: path.basename(abs), notes: notes.length, files: files.length, obsidian: fs.existsSync(path.join(abs, ".obsidian")) };
}

/** Every note and other file under root, as "/"-joined relative paths, plus every folder. */
function walk(root) {
  const notes = [];
  const files = [];
  const dirs = [];
  const visit = (rel) => {
    const entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        dirs.push(r);
        visit(r);
      } else if (e.isFile()) (/\.md$/i.test(e.name) ? notes : files).push(r);
    }
  };
  visit("");
  return { notes, files, dirs };
}

const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseOf = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
const noMd = (rel) => rel.replace(/\.md$/i, "");
/** A usable page/folder name: no leading dots, no slashes, trimmed. */
const cleanName = (name) => portableName(name); // works on Windows too (pages.mjs)

/**
 * Obsidian's link resolution: an exact vault path first, then the same name in the linking
 * note's folder, then the shortest path with that name. `byName` maps lowercased basenames
 * (notes: without .md) to their paths.
 */
function resolver(paths, byName, key) {
  const exact = new Map(paths.map((p) => [key(p).toLowerCase(), p]));
  return (target, fromDir) => {
    const t = target.replace(/^\/+/, "").toLowerCase();
    if (!t) return null;
    if (exact.has(t)) return exact.get(t);
    const rel = (fromDir ? fromDir + "/" : "") + t;
    if (exact.has(rel.toLowerCase())) return exact.get(rel.toLowerCase());
    const name = t.slice(t.lastIndexOf("/") + 1);
    const hits = (byName.get(name) || []).filter((p) => key(p).toLowerCase().endsWith(t));
    if (!hits.length) return null;
    return hits.find((p) => dirOf(p) === fromDir) || hits.slice().sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
  };
}

/** Run fn on the parts of md outside fenced code blocks and inline code. */
function outsideCode(md, fn) {
  const parts = md.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .split(/(`[^`\n]+`)/)
        .map((p, j) => (j % 2 === 1 ? p : fn(p)))
        .join("");
    })
    .join("");
}

const escText = (s) => s.replace(/([[\]])/g, "\\$1");
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {string} vault  the Quire vault
 * @param {{source: string, dest?: string, format?: "md"|"html", commit?: boolean}} opts
 *   dest: vault-relative folder to import into ("" = top level; created when missing)
 */
export function importObsidian(vault, { source, dest = "", format = "md", commit = true }) {
  const src = path.resolve(String(source || ""));
  const destRel = normPath(dest);
  const { notes, files, dirs } = walk(src);
  if (!notes.length) throw new Error("No notes (.md files) in that folder");

  // Where dest is: every existing segment must be a folder, never a page.
  let cur = vault;
  for (const seg of destRel ? destRel.split("/") : []) {
    cur = path.join(cur, seg);
    if (fs.existsSync(cur) && (isPageDir(cur) || !fs.statSync(cur).isDirectory())) throw new Error(`${destRel} is inside a page; pick a folder`);
  }

  // ---- plan: Obsidian folder → Quire folder, note → page path (case-insensitive, like APFS)
  const taken = new Map(); // lowercased quire path → "folder" | "page"
  const existing = (rel) => {
    const abs = pathDir(vault, rel);
    if (!fs.existsSync(abs)) return null;
    return isPageDir(abs) || !fs.statSync(abs).isDirectory() ? "page" : "folder";
  };
  const claim = (parent, name, kind) => {
    const base = cleanName(name);
    for (let i = 1; ; i++) {
      const n = i === 1 ? base : `${base} ${i}`;
      const rel = parent ? `${parent}/${n}` : n;
      const k = rel.toLowerCase();
      const have = taken.get(k) || existing(rel);
      if (!have || (have === "folder" && kind === "folder")) {
        taken.set(k, kind);
        return rel;
      }
    }
  };
  const folderOf = new Map([["", destRel]]);
  for (const d of dirs) folderOf.set(d, claim(folderOf.get(dirOf(d)), baseOf(d), "folder"));
  const dirNames = new Set(dirs.map((d) => d.toLowerCase()));
  const pageOf = new Map();
  for (const n of notes) {
    const stem = noMd(n);
    // A note next to a folder of the same name (a "folder note") goes inside that folder.
    const parent = dirNames.has(stem.toLowerCase()) ? folderOf.get(dirs.find((d) => d.toLowerCase() === stem.toLowerCase())) : folderOf.get(dirOf(n));
    pageOf.set(n, claim(parent, baseOf(stem), "page"));
  }

  const group = (list, key) => {
    const m = new Map();
    for (const p of list) {
      const k = key(baseOf(p)).toLowerCase();
      m.set(k, [...(m.get(k) || []), p]);
    }
    return m;
  };
  const findNote = resolver(notes, group(notes, noMd), noMd);
  const findFile = resolver(files, group(files, (x) => x), (x) => x);

  const used = new Set();
  const unresolved = [];
  let attachments = 0;
  const written = [];

  for (const n of notes) {
    const page = pageOf.get(n);
    const fromDir = dirOf(n);
    const segs = page.split("/");
    const toRoot = "../".repeat(segs.length);
    const pageHref = (target) => toRoot + pageOf.get(target).split("/").map(encodeURIComponent).join("/") + "/";
    const assets = new Map(); // source file → name in the page folder
    const asset = (file) => {
      if (assets.has(file)) return assets.get(file);
      used.add(file);
      let name = cleanName(baseOf(file));
      if (HEIC.test(name)) name = name.replace(HEIC, ".jpg");
      const taken = new Set([...assets.values(), "index.md", "index.html", ".noteblock", ".quire", "data"].map((x) => x.toLowerCase()));
      const dot = name.lastIndexOf(".");
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = dot > 0 ? `${name.slice(0, dot)} ${i}${name.slice(dot)}` : `${name} ${i}`;
      assets.set(file, name);
      return name;
    };
    const fileRef = (name) => "<" + name + ">";

    const raw = fs.readFileSync(path.join(src, n), "utf8");
    const { frontmatter, body } = splitFrontmatter(raw);

    /** null (unresolved) only when quiet; otherwise the link's text. */
    const linkTo = (target, label, embed, quiet = false) => {
      const [pathPart] = target.split(/[#^]/);
      const t = pathPart.trim();
      const note = t ? findNote(noMd(t), fromDir) : null;
      if (note && !(t && /\.[a-z0-9]+$/i.test(t) && !/\.md$/i.test(t))) {
        if (embed) return `\n\n![[/${pageOf.get(note)}]]\n\n`;
        return `[${escText(label || baseOf(noMd(t)))}](${pageHref(note)})`;
      }
      const file = t ? findFile(t, fromDir) : null;
      if (file) {
        const name = asset(file);
        if (embed && IMAGE.test(name)) {
          const size = /^(\d+)(?:x(\d+))?$/.exec(label || "");
          if (size) return `<img src="${escAttr(encodeURI(name))}" width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ""} alt="">`;
          return `![${escText(label || "")}](${fileRef(name)})`;
        }
        return `[${escText(label || baseOf(file))}](${fileRef(name)})`;
      }
      if (quiet) return null;
      unresolved.push(`${noMd(n)} → ${target}`);
      return escText(label || t || target);
    };

    let md = outsideCode(body, (text) =>
      text
        .replace(/%%[\s\S]*?%%/g, "")
        .replace(/(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\)/g, (m, bang, label, href) => {
          let target = href.replace(/^<|>$/g, "");
          if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(target)) return m;
          try {
            target = decodeURI(target);
          } catch {}
          if (bang && !IMAGE.test(target.split(/[#?]/)[0])) return m;
          // Relative to the note first (../Home.md), as Obsidian writes them.
          const near = path.posix.normalize((fromDir ? fromDir + "/" : "") + target);
          const out = (!near.startsWith("../") && linkTo("/" + near, label, !!bang, true)) || linkTo(target, label, !!bang, true);
          return out || m;
        })
        .replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (_m, bang, inner) => {
          // Inside a table the alias bar is escaped: [[Note\|Alias]].
          const m = /^(.*?)\\?\|(.*)$/.exec(inner);
          const target = (m ? m[1] : inner).replace(/\\$/, "");
          const label = m ? m[2].trim() : "";
          return linkTo(target.trim(), label, !!bang);
        })
        .replace(/==([^=\n]+)==/g, "<mark>$1</mark>")
        .replace(/^([ \t]*(?:>[ \t]*)+)\[!(\w+)\][+-]?[ \t]*(.*)$/gm, (_m, q, type, title) => `${q}**${escText(title.trim() || capital(type.toLowerCase()))}**\\`)
        .replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/gm, ""),
    );

    // Obsidian shows the file name as the title; a Quire page shows only its content.
    const title = baseOf(page);
    if (!/^\s*#[ \t]/.test(md)) md = `# ${title}\n\n${md.replace(/^\n+/, "")}`;

    const dir = pathDir(vault, page);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { id: newPageId(), entry: format === "html" ? "index.html" : "index.md" };
    if (format === "html") {
      if (frontmatter) manifest.frontmatter = frontmatter.replace(/^---[ \t]*\n|\n---[ \t]*\n?$/g, "");
      fs.writeFileSync(path.join(dir, "index.html"), renderMarkdown(md, { title }).replace('<body data-q-format="md">', "<body>"));
    } else fs.writeFileSync(path.join(dir, "index.md"), frontmatter + md);
    writeManifest(dir, manifest);
    for (const [file, name] of assets) {
      const to = path.join(dir, name);
      if (HEIC.test(file)) {
        try {
          execFileSync("sips", ["-s", "format", "jpeg", path.join(src, file), "--out", to], { stdio: "ignore" });
          attachments++;
          continue;
        } catch {}
      }
      fs.copyFileSync(path.join(src, file), to);
      attachments++;
    }
    written.push(page);
  }

  // Files no note links stay where they were, as plain files in the matching folder.
  const loose = [];
  for (const f of files) {
    if (used.has(f)) continue;
    const parent = folderOf.get(dirOf(f));
    const base = cleanName(baseOf(f));
    const dot = base.lastIndexOf(".");
    let rel;
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : dot > 0 ? `${base.slice(0, dot)} ${i}${base.slice(dot)}` : `${base} ${i}`;
      rel = parent ? `${parent}/${name}` : name;
      if (!taken.has(rel.toLowerCase()) && !existing(rel)) break;
    }
    taken.set(rel.toLowerCase(), "file");
    const to = pathDir(vault, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f), to);
    loose.push(rel);
  }
  const folders = new Set();
  for (const p of [...written, ...loose]) for (let d = dirOf(p); d && d !== destRel && !folders.has(d); d = dirOf(d)) folders.add(d);
  if (commit) commitAll(vault, `Import ${path.basename(src)} from Obsidian`);
  return {
    dest: destRel,
    format,
    pages: written.length,
    folders: folders.size,
    attachments,
    unresolved,
    files: loose.length,
    first: written.slice().sort((a, b) => a.split("/").length - b.split("/").length)[0] || null,
  };
}
