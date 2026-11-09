// Vault watcher: fs.watch recursive, 150 ms debounce, classified into
// locks-changed / page-files-changed / tree-changed. Files main wrote itself in the last
// 1.5 s are ignored (see markSelfWrite).
import fs from "node:fs";
import path from "node:path";
import { isManifestName, isMetaDirName, MANIFESTS } from "../../core/names.mjs";

export const DEBOUNCE_MS = 150;
export const SELF_WRITE_MS = 1500;

/** @type {Map<string, number>} abs path → time main wrote it */
const selfWrites = new Map();

export function markSelfWrite(absFile) {
  selfWrites.set(path.resolve(absFile), Date.now());
}

function isSelfWrite(absFile, now = Date.now()) {
  const t = selfWrites.get(absFile);
  if (t == null) return false;
  if (now - t <= SELF_WRITE_MS) return true;
  selfWrites.delete(absFile);
  return false;
}

/**
 * Classify one change (vault-relative path, "/" or OS separators). Needs the vault to tell
 * pages (folders holding a `.noteblock` or older `.quire` file) from plain folders.
 * @param {string} vault
 * @param {string} rel
 * @returns {{locks?: true, tree?: true, maybeTree?: true, page?: string} | null}
 */
export function classify(vault, rel) {
  const segs = String(rel).split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return null;
  if (isMetaDirName(segs[0])) {
    if (segs[1] === "locks") return { locks: true };
    if (segs[1] === "vault.json" || segs[1] === "settings.json") return { tree: true };
    return null;
  }
  if (segs.some((s) => s === ".git" || s === "node_modules")) return null;

  // The page is the first folder along the path that holds a manifest.
  let dir = vault;
  let pageEnd = -1;
  for (let i = 0; i < segs.length - 1; i++) {
    dir = path.join(dir, segs[i]);
    if (isPageDir(dir)) {
      pageEnd = i;
      break;
    }
  }
  if (pageEnd < 0) {
    // Outside any page: a folder or page appeared/disappeared, or a stray file changed.
    const last = segs[segs.length - 1];
    if (last.startsWith(".") && !isManifestName(last)) return null;
    return { tree: true };
  }
  const pagePath = segs.slice(0, pageEnd + 1).join("/");
  const rest = segs.slice(pageEnd + 1);
  if (rest[0] === "data") return null;
  const file = rest.join("/");
  if (rest.length === 1 && isManifestName(rest[0])) return { tree: true, page: pagePath, file };
  if (rest.length === 1 && /^index\.(html|md)$/.test(rest[0])) return { page: pagePath, file, maybeTree: true };
  if (rest[0].startsWith(".")) return null;
  return { page: pagePath, file };
}

function isPageDir(dir) {
  return MANIFESTS.some((n) => {
    try {
      return fs.statSync(path.join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * @param {string} vault
 * @param {{onLocks: () => void, onTree: () => void, onPage: (p: string, files: string[]) => void}} handlers
 * @returns {() => void} stop
 */
export function watchVault(vault, handlers) {
  let timer = null;
  let locks = false;
  let tree = false;
  /** @type {Map<string, Set<string>>} page → changed page-relative files */
  const pages = new Map();

  const flush = () => {
    timer = null;
    const l = locks;
    const t = tree || l; // tree carries lock info
    const ps = [...pages].map(([p, files]) => [p, [...files]]);
    locks = false;
    tree = false;
    pages.clear();
    try {
      if (l) handlers.onLocks();
      if (t) handlers.onTree();
      for (const [p, files] of ps) handlers.onPage(p, files);
    } catch (err) {
      console.error("[quire] watcher handler failed:", err);
    }
  };

  let watcher;
  try {
    watcher = fs.watch(vault, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      // git's own churn (every autosave commit writes dozens of files under .git): drop it
      // before any path work, this callback runs on the main thread.
      if (rel === ".git" || rel.startsWith(".git/") || rel.startsWith(".git\\")) return;
      const abs = path.join(vault, rel);
      if (isSelfWrite(abs)) return;
      const c = classify(vault, rel);
      if (!c) return;
      if (c.locks) locks = true;
      if (c.tree) tree = true;
      // a rename on an entry file means it was created/removed: format may have changed
      if (c.maybeTree && eventType === "rename") tree = true;
      if (c.page) {
        if (!pages.has(c.page)) pages.set(c.page, new Set());
        pages.get(c.page).add(c.file || "");
      }
      if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
      else {
        clearTimeout(timer);
        timer = setTimeout(flush, DEBOUNCE_MS);
      }
    });
    watcher.on("error", (err) => console.error("[quire] watcher error:", err.message));
  } catch (err) {
    console.error("[quire] could not watch vault:", err.message);
  }

  return () => {
    if (timer) clearTimeout(timer);
    try {
      watcher && watcher.close();
    } catch {}
  };
}
