// Move or rename a page or folder inside the vault (Noteblock AI's move_page, docs/ai.md
// "What a chat turn can do"). Paths are vault-relative: "Kyoto trip" → "Travel/Kyoto trip".
// The app stops the moved pages' backends and flushes its autosaves first (ipc.mjs
// movePagePath); this half checks, closes the store handles under it and renames.
import fs from "node:fs";
import path from "node:path";
import { normPath, pathDir, isPageDir, checkName, checkParent, listTree, walkTree, findPage } from "./pages.mjs";
import { getLock } from "./lock.mjs";
import { closeStoresUnder } from "./store.mjs";
import { moveSearchExclude } from "./searchExclude.mjs";

/** The page nodes at or under `rel` (a page: just it; a folder: every page inside). */
export function pagesUnder(vault, rel) {
  const norm = normPath(rel);
  if (!norm) return [];
  if (isPageDir(pathDir(vault, norm))) return [findPage(vault, norm)];
  const out = [];
  for (const n of walkTree(listTree(vault))) if (n.kind === "page" && n.path.startsWith(norm + "/")) out.push(n);
  return out;
}

/**
 * Check a move without doing it. Refuses the vault root, a missing source, an existing target,
 * a folder moved into itself, a target inside a page, and a page (or a folder holding one) an
 * agent is editing. Returns {from, to, kind: "page" | "folder"}.
 */
export function checkMove(vault, from, to) {
  const src = normPath(from);
  const dst = normPath(to);
  if (!src) throw new Error("The vault itself can't be moved");
  if (!dst) throw new Error("Say where it goes: the full new path");
  if (src === dst) throw new Error(`${src} is already there`);
  const srcDir = pathDir(vault, src);
  let st;
  try {
    st = fs.statSync(srcDir);
  } catch {
    throw new Error(`No page or folder ${src}`);
  }
  if (!st.isDirectory()) throw new Error(`${src} isn't a page or folder`);
  // Inside a page: its own files, not something to move from here.
  const segs = src.split("/");
  for (let i = 1; i < segs.length; i++) {
    if (isPageDir(pathDir(vault, segs.slice(0, i).join("/")))) throw new Error(`${src} is a file of the page ${segs.slice(0, i).join("/")}`);
  }
  if (dst.startsWith(src + "/")) throw new Error(`${src} can't be moved into itself`);
  checkName(dst.split("/").pop());
  if (fs.existsSync(pathDir(vault, dst))) throw new Error(`Already exists: ${dst}`);
  checkParent(vault, dst);
  for (const node of pagesUnder(vault, src)) {
    const lock = node.lock || getLock(vault, node.id);
    if (lock) throw new Error(`${lock.by || "An agent"} is editing ${node.path}`);
  }
  return { from: src, to: dst, kind: isPageDir(srcDir) ? "page" : "folder" };
}

/**
 * Move (rename) a page or folder; search exclusions follow. Returns {from, to, kind}, plus
 * settingsChanged when the vault's settings.json needs committing too.
 */
export function movePath(vault, from, to) {
  const m = checkMove(vault, from, to);
  const srcDir = pathDir(vault, m.from);
  // node:sqlite keeps the file open; a handle on the old path would write to a moved inode.
  closeStoresUnder(srcDir);
  fs.renameSync(srcDir, path.join(vault, ...m.to.split("/")));
  if (moveSearchExclude(vault, m.from, m.to)) m.settingsChanged = true;
  return m;
}
