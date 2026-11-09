import { isWeb, vaultPathOfUrl, vaultUrl } from "./webBridge.js";

/** Depth-first list of every node. */
export function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (n.children?.length) flatten(n.children, out);
  }
  return out;
}

/** The page a vault opens on when nothing is remembered: a top-level "Welcome" if there is one, else the first page. */
export function firstPage(nodes) {
  const pages = flatten(nodes).filter((n) => n.kind === "page");
  return pages.find((n) => n.path === "Welcome") || pages[0] || null;
}

export function findPageNode(nodes, path) {
  const n = findNode(nodes, path);
  return n && n.kind === "page" ? n : null;
}

export function findNode(nodes, path) {
  if (!path) return null;
  return flatten(nodes).find((n) => n.path === path) || null;
}

/** Nodes from the root down to (and including) `path`, as far as they exist. */
export function ancestry(nodes, path) {
  const out = [];
  let level = nodes || [];
  const segs = path ? path.split("/") : [];
  let acc = "";
  for (const s of segs) {
    acc = acc ? acc + "/" + s : s;
    const n = level.find((x) => x.path === acc);
    if (!n) break;
    out.push(n);
    level = n.children || [];
  }
  return out;
}

export function parentPath(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Every parent folder of `path`, added to the expanded set. */
export function withAncestors(expanded, path) {
  const next = new Set(expanded);
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
  return next;
}

/**
 * A tab's visit history is {stack, at}. The index one step back (-1) or forward (1) from `at`,
 * skipping pages that no longer exist and the page already on screen, or -1 when there is none.
 */
export function historyStep(history, step, nodes) {
  if (!history) return -1;
  const live = new Set(flatten(nodes).filter((n) => n.kind !== "folder").map((n) => n.path));
  const here = history.stack[history.at];
  for (let i = history.at + step; i >= 0 && i < history.stack.length; i += step) {
    if (live.has(history.stack[i]) && history.stack[i] !== here) return i;
  }
  return -1;
}

export function collectLocks(nodes) {
  return flatten(nodes).filter((n) => n.lock).map((n) => ({ ...n.lock, path: n.lock.path || n.path }));
}

/**
 * The URL a page is shown at: its own origin, quire://p-<id>/<path>/ (app/main/origins.mjs).
 * Without an id (not known yet) the legacy quire://vault/<path>/, which main redirects.
 * On the web host (webBridge.js) every page is /v/<path>/ on the host's one origin.
 */
export function pageSrc(path, id) {
  if (isWeb) return vaultUrl(path) + "/";
  const p = path.split("/").map(encodeURIComponent).join("/") + "/";
  return id ? "quire://p-" + id + "/" + p : "quire://vault/" + p;
}

/**
 * The page whose origin (quire://p-<id>) a message came from: its path, or null. On the web
 * host all pages share one origin, so this is always null there: use pageOfWindow.
 */
export function pageOfOrigin(nodes, origin) {
  const m = /^quire:\/\/p-([a-z0-9]{10})$/.exec(String(origin || ""));
  if (!m) return null;
  const n = flatten(nodes).find((x) => x.kind === "page" && x.id === m[1]);
  return n ? n.path : null;
}

/**
 * Web host: the page a window (a MessageEvent's source) shows, from its same-origin
 * /v/<path>/… location: the deepest page in the tree that path sits in. Null if unknown.
 */
export function pageOfWindow(nodes, win) {
  if (!isWeb || !win) return null;
  let href = "";
  try {
    href = win.location.href;
  } catch {
    return null;
  }
  const p = vaultPathOfUrl(href);
  if (p == null) return null;
  let best = null;
  for (const n of flatten(nodes)) {
    if (n.kind === "page" && (p === n.path || p.startsWith(n.path + "/")) && (!best || n.path.length > best.length)) best = n.path;
  }
  return best;
}

/** pageSrc for a page path, looking its id up in the tree. */
export function pageSrcIn(nodes, path) {
  return pageSrc(path, findPageNode(nodes, path)?.id);
}

export function readLocal(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
