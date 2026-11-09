// quire:// protocol: `quire://p-<page id>/<page path>/<file>` (one origin per page, see
// origins.mjs), `quire://runtime/<file>`, and the legacy `quire://vault/<page path>/<file>`,
// which redirects to the page's own origin (plain files outside any page are still served there).
// The pure parts (resolveVaultRequest, resolvePageRequest, injectHead, transformEntry,
// contentType, originGuard) are exported so they can be exercised without Electron.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { idOfHost, pathsForId, idForPath, pageUrl, splitOwnPath } from "./origins.mjs";
import { getLock, snapshotDir, readManifest, isPageDir, entryFile, parseBackend, loadConfig, isManifestName } from "../../core/index.mjs";
import { TYPES, contentType, editorPrefs, escAttr, transformEntry } from "./transform.mjs";
import { BRAND } from "../../core/brand.mjs";

// The pure half (content types, head injection, entry transform) lives in transform.mjs so the
// iOS app can bundle it into JavaScriptCore; re-exported here for every desktop importer.
export { contentType, EDITOR_FONTS, EDITOR_DEFAULTS, editorPrefs, editorCss, headInjection, injectHead, transformEntry } from "./transform.mjs";

export const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");

/** The one-time copy of the old shared quire://vault localStorage, for a page's first load on
 * its own origin (the runtime copies it in before any page script runs; see runtime.js). */
export function legacyStorageScript(json) {
  if (!json) return "";
  // JSON inside <script>: "<" (only ever inside JSON strings) as \u003c, so nothing ends it early.
  return `<script type="application/json" id="q-legacy-storage">${String(json).replace(/</g, "\\u003c")}</script>`;
}

/**
 * Split decoded URL segments into the page part (the leading folders up to and including the
 * first one holding a `.noteblock` or `.quire` manifest) and the file part (the rest, inside that page).
 * @returns {{pageSegs: string[], fileSegs: string[], dir: string} | null}
 */
export function splitPagePath(vault, segs) {
  let dir = vault;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s || s.startsWith(".")) return null;
    dir = path.join(dir, s);
    if (isPageDir(dir)) return { pageSegs: segs.slice(0, i + 1), fileSegs: segs.slice(i + 1), dir };
  }
  return null;
}

function decodeSegs(pathname) {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

/**
 * Resolve a vault request to something to serve.
 * `urlBase` is what page URLs start with (before the page path) in what it generates: the
 * entry's <base> for a page whose entry is in a subfolder. `extraHead` goes into an entry's head.
 * `restricted`: the vault is in restricted mode (trust.mjs), so a built page whose output isn't
 * there says so instead of showing its unbuilt source.
 * @returns {{status: 404, text: string} | {status: 200, file: string, body?: string, type: string}}
 */
export function resolveVaultRequest(vault, pathname, { urlBase = "quire://vault/", extraHead = "", restricted = false } = {}) {
  let segs;
  try {
    segs = decodeSegs(pathname);
  } catch {
    return { status: 404, text: "Bad path" };
  }
  if (segs.some((s) => s === ".." || s === "." || s.includes("\0") || s.includes("\\"))) {
    return { status: 404, text: "Bad path" };
  }
  const split = splitPagePath(vault, segs);
  if (!split) {
    // A plain file in a folder (not inside any page) is served as itself.
    const loose = path.join(vault, ...segs);
    if (segs.length && !segs.some((s) => s.startsWith(".")) && loose.startsWith(vault + path.sep)) {
      try {
        if (fs.statSync(loose).isFile()) return { status: 200, file: loose, type: contentType(loose) };
      } catch {}
    }
    return { status: 404, text: `No page: ${segs.join("/")}` };
  }
  const pagePath = split.pageSegs.join("/");

  // Personal data is never served, nor dotfiles (.noteblock, .quire, .env, .git…).
  if (split.fileSegs[0] === "data") return { status: 404, text: "Not found" };
  if (split.fileSegs.some((s) => s.startsWith("."))) return { status: 404, text: "Not found" };

  const manifest = readManifest(split.dir) || {};
  // The backend folder (server code, .env secrets) isn't served to the page; /api/* goes to it.
  const backend = parseBackend(manifest.backend);
  if (backend) {
    const rel = split.fileSegs.join("/");
    if (rel === backend.dir || rel.startsWith(backend.dir + "/")) return { status: 404, text: "Not found" };
    if (backend.proxy && split.fileSegs[0] === "api") return { status: "proxy", page: split.pageSegs.join("/"), path: "/" + rel };
  }
  const lock = manifest.id ? getLock(vault, manifest.id) : null;
  const base = lock ? snapshotDir(vault, manifest.id) : split.dir;

  const fileSegs = split.fileSegs;
  if (isManifestName(fileSegs[0])) return { status: 404, text: "Not found" };
  const title = manifest.title || split.pageSegs[split.pageSegs.length - 1];
  const entry = entryFile(base, manifest);
  if (restricted && fileSegs.length === 0 && needsBuild(base, manifest)) {
    return { status: 200, file: path.join(base, entry), body: needsBuildDoc(title), type: TYPES[".html"], entryOf: pagePath };
  }
  if (fileSegs.length === 0 || fileSegs.join("/") === entry) {
    const file = path.join(base, entry);
    const format = /\.md$/i.test(entry) ? "md" : "html";
    let src = null;
    if (fs.existsSync(file)) src = fs.readFileSync(file, "utf8");
    else if (fileSegs.length === 0) {
      src = `<!doctype html><html><head><meta charset="utf-8"><title>${escAttr(title)}</title></head><body></body></html>`;
    }
    if (src != null) {
      const entryDir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
      const baseHref = entryDir ? urlBase + [...split.pageSegs, ...entryDir.split("/").filter(Boolean)].map(encodeURIComponent).join("/") + "/" : null;
      return { status: 200, file, body: transformEntry(src, format, { pagePath, title, baseHref, editor: editorPrefs(loadConfig().editor), extra: extraHead }), type: TYPES[".html"], entryOf: pagePath };
    }
  }

  const file = path.join(base, ...fileSegs);
  if (!file.startsWith(base + path.sep)) return { status: 404, text: "Not found" };
  try {
    if (!fs.statSync(file).isFile()) return { status: 404, text: "Not found" };
  } catch {
    return { status: 404, text: `Not found: ${fileSegs.join("/")}` };
  }
  return { status: 200, file, type: contentType(file) };
}

/** A page with a build command whose named entry (its build output) isn't on disk. */
function needsBuild(base, manifest) {
  if (typeof manifest.build !== "string" || !manifest.build.trim()) return false;
  const named = typeof manifest.entry === "string" && !manifest.entry.includes("..") ? manifest.entry : null;
  return !named || !fs.existsSync(path.join(base, named));
}

/** What a restricted vault shows for a page that has to be built first. */
function needsBuildDoc(title) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escAttr(title)}</title>` +
    `<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;color:#555;margin:0;display:grid;place-items:center;min-height:100vh}p{max-width:420px;text-align:center;padding:0 24px}</style>` +
    `</head><body><p>This page has to be built before it can show, and builds don't run in restricted mode. Trust this vault to build it.</p></body></html>`
  );
}

/** Resolve a runtime request to a file under app/runtime. */
export function resolveRuntimeRequest(pathname, root = RUNTIME_DIR) {
  let segs;
  try {
    segs = decodeSegs(pathname);
  } catch {
    return { status: 404, text: "Bad path" };
  }
  if (!segs.length || segs.some((s) => s === ".." || s === "." || s.includes("\0"))) {
    return { status: 404, text: "Not found" };
  }
  const file = path.join(root, ...segs);
  if (!file.startsWith(root + path.sep)) return { status: 404, text: "Not found" };
  try {
    if (!fs.statSync(file).isFile()) return { status: 404, text: "Not found" };
  } catch {
    return { status: 404, text: `Not found: ${segs.join("/")}` };
  }
  return { status: 200, file, type: contentType(file) };
}

/**
 * Resolve a request on a page's own origin, `quire://p-<id>/<path>`.
 * - inside the page (`<page path>/…`): what resolveVaultRequest serves there, with page URLs
 *   (a subfolder entry's <base>) on this origin
 * - `/api/…`: the page's backend (an absolute fetch("/api/…") from the page)
 * - anything else: another vault path a relative link reached (`../Other page/`). A navigation
 *   there is redirected to that page's own origin (`redirect`); any other request is refused, so
 *   a page can't read another page's files through its own origin.
 * @param {{navigation?: boolean, extraHead?: (pagePath: string) => string, restricted?: boolean}} [opts]
 */
export function resolvePageRequest(vault, host, pathname, { navigation = false, extraHead = null, restricted = false } = {}) {
  const id = idOfHost(host);
  const paths = id ? pathsForId(vault, id) : [];
  if (!paths.length) return { status: 404, text: "No such page" };
  let segs;
  try {
    segs = decodeSegs(pathname);
  } catch {
    return { status: 404, text: "Bad path" };
  }
  if (segs.some((s) => s === ".." || s === "." || s.includes("\0") || s.includes("\\"))) return { status: 404, text: "Bad path" };
  // Several folders can share an id (a page copied in Finder): the path says which one.
  const pagePath = paths.find((p) => "own" in splitOwnPath(p, segs)) || null;
  if (pagePath) {
    // The page itself without its trailing slash: relative URLs need it.
    if (segs.length === pagePath.split("/").length && !pathname.endsWith("/")) return { status: 302, location: pageUrl(id, pagePath) };
    const r = resolveVaultRequest(vault, pathname, { urlBase: `quire://p-${id}/`, extraHead: extraHead ? extraHead(pagePath) : "", restricted });
    return r.status === "proxy" ? { ...r, page: pagePath } : r;
  }
  if (segs[0] === "api") return { status: "proxy", page: paths[0], path: pathname };
  if (navigation) {
    const split = splitPagePath(vault, segs);
    if (split) {
      const target = split.pageSegs.join("/");
      const tid = idForPath(vault, target);
      if (tid) return { status: 302, location: pageUrl(tid, target, split.fileSegs.join("/")) };
    } else {
      // A plain file outside any page: still on the shared vault host.
      return { status: 302, location: "quire://vault/" + segs.map(encodeURIComponent).join("/") };
    }
  }
  return { status: 404, text: "Not found" };
}

/** quire://vault/<page path>/<file> → that page's own origin (keeping ?query); null when the
 * path isn't inside a page (a plain file, served on the vault host itself). */
export function vaultRedirect(vault, pathname) {
  let segs;
  try {
    segs = decodeSegs(pathname);
  } catch {
    return null;
  }
  if (segs.some((s) => s === ".." || s === "." || s.includes("\0") || s.includes("\\"))) return null;
  const split = splitPagePath(vault, segs);
  if (!split) return null;
  const page = split.pageSegs.join("/");
  const id = idForPath(vault, page);
  if (!id) return null;
  return pageUrl(id, page, split.fileSegs.join("/")) + (pathname.endsWith("/") && split.fileSegs.length ? "/" : "");
}

/**
 * Which quire:// requests a frame may make (session.webRequest, main.mjs). Electron's custom
 * protocol handlers skip Chromium's CORS checks, so a page could otherwise fetch() another
 * page's files and APIs across origins. Navigations (a page or an embed loading) are always
 * allowed; the app UI (file://) may load anything; a page may load its own origin and the
 * runtime; nothing else.
 * @returns {boolean} true to let the request through
 */
export function originGuard({ url, resourceType, initiator }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== "quire:" || u.host === "runtime") return true;
  if (resourceType === "mainFrame" || resourceType === "subFrame") return true;
  const from = String(initiator || "");
  if (from.startsWith("file://")) return true;
  if (!from || from === "null") return !idOfHost(u.host) && u.host !== "vault" ? true : false;
  return from === `quire://${u.host}`;
}

/**
 * Whether a frame navigation to `url` should be cancelled and opened in the browser instead
 * (will-frame-navigate, main.mjs / floating.mjs). Links in the app or in a page leave for the
 * browser; a frame a page nests on the web itself (`<iframe src="https://…">` inside a page or an
 * embed, e.g. a hosted game) loads and navigates in place. `frame` is the navigating
 * WebFrameMain (or {url, parent}); without one, any http(s) URL opens externally.
 */
export function opensInBrowser(url, frame) {
  if (!/^https?:\/\//i.test(url)) return false;
  let nested = false;
  try {
    nested = !!(frame && frame.parent && frame.parent.parent) && !/^(quire|file):/i.test(String(frame.url || ""));
  } catch {}
  return !nested;
}

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

function toResponse(r, { cors = false, csp = null } = {}) {
  let base = cors ? { ...NO_CACHE, "Access-Control-Allow-Origin": "*" } : NO_CACHE;
  // Restricted mode (trust.mjs): the page can't reach past its own origin and the runtime.
  if (csp) base = { ...base, "Content-Security-Policy": csp };
  if (r.status === 302) return new Response(null, { status: 302, headers: { ...NO_CACHE, Location: r.location } });
  if (r.status !== 200) {
    return new Response(r.text || "Not found", {
      status: r.status,
      headers: { ...base, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const body = r.body != null ? r.body : fs.readFileSync(r.file);
  return new Response(body, { status: 200, headers: { ...base, "Content-Type": r.type } });
}

const HOP = new Set(["host", "connection", "origin", "referer", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

/** Forward a request to the page's backend (the process its manifest's "backend.proxy" names). */
async function proxy(hooks, vault, page, pathAndQuery, request) {
  const fail = (status, text) => toResponse({ status, text });
  // Starts the backend if it isn't running (it may have been stopped for being idle) and waits
  // for it to listen; throws with .status 503 if it doesn't in time.
  let port;
  try {
    port = await hooks.proxyPort(vault, page);
  } catch (err) {
    return fail(err?.status || 502, String(err?.message || err));
  }
  if (!port) return fail(502, `${page} has no backend to send ${pathAndQuery} to`);
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!HOP.has(k.toLowerCase())) headers.set(k, v);
  const init = { method: request.method, headers, redirect: "manual" };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }
  // A backend that was just started needs a moment to listen.
  let res = null;
  let lastErr = null;
  for (const until = Date.now() + 10000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
    try {
      res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, init);
      break;
    } catch (err) {
      lastErr = err;
      if (!/ECONNREFUSED|fetch failed/i.test(String(err?.cause?.code || err?.message || err))) break;
    }
  }
  if (!res) return fail(503, `The backend for ${page} isn't answering on port ${port} (${String(lastErr?.cause?.code || lastErr?.message || lastErr)}). See its log in the Backend panel.`);
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("access-control-allow-origin");
  out.set("Cache-Control", "no-store");
  return new Response(res.status === 204 || res.status === 304 ? null : await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: out });
}

/** A request that loads a document (a page or embed navigating), not a fetch or subresource. */
function isNavigation(request) {
  const h = request.headers;
  return /^text\/html/i.test(h.get("accept") || "") && h.has("upgrade-insecure-requests");
}

/** The blank document main reads the old shared localStorage from (page-storage.mjs). */
export const LEGACY_STORAGE_PATH = "/__quire/legacy-storage";

/**
 * Register the handler. Call after app ready.
 * @param {import("electron").Protocol} protocol
 * @param {() => string} getVault
 * @param {{proxyPort?: (vault: string, page: string) => Promise<number|null>, onEntry?: (page: string) => void,
 *          extraHead?: (vault: string, id: string, page: string) => Promise<string> | string,
 *          csp?: (vault: string) => string | null}} [hooks]
 *   proxyPort: where /api/* for a page goes (starting its backend); onEntry: a page was loaded;
 *   extraHead: extra markup for a page entry's head (the one-time localStorage migration);
 *   csp: the Content-Security-Policy for the vault's pages, null for none (a trusted vault)
 */
export function registerQuireProtocol(protocol, getVault, hooks = {}) {
  protocol.handle("quire", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host === "runtime") return toResponse(resolveRuntimeRequest(url.pathname), { cors: true });
      const vault = getVault();
      const id = idOfHost(url.host);
      const csp = hooks.csp ? hooks.csp(vault) : null;
      if (id) {
        let extra = "";
        if (hooks.extraHead && isNavigation(request)) {
          const paths = pathsForId(vault, id);
          if (paths.length) extra = (await hooks.extraHead(vault, id, paths[0])) || "";
        }
        const r = resolvePageRequest(vault, url.host, url.pathname, { navigation: isNavigation(request), extraHead: extra ? () => extra : null, restricted: !!csp });
        if (r.status === "proxy") return hooks.proxyPort ? proxy(hooks, vault, r.page, r.path + url.search, request) : toResponse({ status: 404, text: "Not found" });
        if (r.status === 302) return toResponse({ ...r, location: r.location + url.search });
        if (r.entryOf && hooks.onEntry) hooks.onEntry(r.entryOf);
        return toResponse(r, { csp });
      }
      if (url.host === "vault") {
        if (url.pathname === LEGACY_STORAGE_PATH) return toResponse({ status: 200, body: `<!doctype html><title>${BRAND.name}</title>`, type: TYPES[".html"] });
        // A page (or a file in one) moved to its own origin; plain files stay here.
        const to = vaultRedirect(vault, url.pathname);
        if (to) return toResponse({ status: 302, location: to + url.search });
        const r = resolveVaultRequest(vault, url.pathname);
        return toResponse(r.status === "proxy" ? { status: 404, text: "Not found" } : r, { csp });
      }
      return toResponse({ status: 404, text: `Unknown host: ${url.host}` });
    } catch (err) {
      return toResponse({ status: 500, text: String((err && err.message) || err) });
    }
  });
}
