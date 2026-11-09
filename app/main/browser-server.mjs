// "Open in browser" for a page that isn't published: a local HTTP server that serves the vault
// the way the quire:// protocol does (same resolver and entry transform, protocol.mjs), so the
// page runs in a normal browser tab.
//
// - Bound to 127.0.0.1 only, on a random free port, started on first use.
// - Every URL starts with an unguessable token (/<token>/…), and the Host header must be this
//   server's, so other local processes, other sites and DNS rebinding can't read the vault.
// - /<token>/<page path>/…        a page and its files (as quire://vault/…)
// - /<token>/_quire/runtime/…     the page runtime (as quire://runtime/…)
// - POST /<token>/_quire/rpc/<page path>   {method, params} → runRpc for that page; answers
//   {ok} | {error}. The page comes from the URL each entry is given (its quire-rpc meta), never
//   from the body; a same-server Referer must agree with it.
// - <page>/api/… and /api/…       the page's backend, when its .noteblock has backend.proxy
// quire://runtime/ and quire://vault/ in served HTML, CSS and JS are rewritten to these paths.
// createVaultRoutes is those routes on their own; the web host (app/web/server.mjs) mounts them
// at /v/, /runtime/ and /_quire/rpc.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { resolveVaultRequest, resolveRuntimeRequest, splitPagePath } from "./protocol.mjs";
import { restrictedCsp } from "./trust.mjs";

const NO_CACHE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };
const TEXT = /^(text\/html|text\/css|text\/javascript|application\/json)/;
const HOP = new Set(["host", "connection", "origin", "referer", "content-length", "transfer-encoding", "keep-alive", "upgrade", "cookie"]);
const RPC_MAX = 16 * 1024 * 1024;

export function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { ...NO_CACHE, "Content-Type": type, ...extra });
  res.end(body);
}

export function sendText(res, status, text) {
  send(res, status, "text/plain; charset=utf-8", text);
}

/** The request body as a Buffer; rejects (and drops the connection) past `max` bytes. */
export function readBody(req, max = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The vault routes, mountable under any layout (this file's token server, app/web/server.mjs):
 * - <vaultBase><page path>/…   a page and its files (as quire://vault/…)
 * - <runtimeBase>…              the page runtime (as quire://runtime/…)
 * - POST <rpcPath>/<page path>  {method, params} → runRpc for that page; answers {ok} | {error}
 * - <page>/api/… and /api/…     the page's backend, when its .noteblock has backend.proxy
 *   (/api/… names its page by a Referer that isOwnUrl accepts)
 * quire://runtime/ and quire://vault/ in served HTML, CSS and JS are rewritten to the bases.
 * handle() resolves false when the request is none of these (the caller answers it).
 * @param {{runRpc: (vault: string, page: string, method: string, params: any, req?: import("node:http").IncomingMessage) => any,
 *          proxyPort?: (vault: string, page: string) => Promise<number|null>, onEntry?: (page: string) => void,
 *          vaultBase: string, runtimeBase: string, rpcPath: string,
 *          isOwnUrl: (u: URL, req: import("node:http").IncomingMessage) => boolean,
 *          getVault?: () => string, isRestricted?: (vault: string) => boolean}} opts
 */
export function createVaultRoutes({ runRpc, proxyPort, onEntry, vaultBase, runtimeBase, rpcPath, isOwnUrl, getVault = () => "", isRestricted = () => false }) {
  const root = vaultBase;
  const rewrite = (text) => text.replaceAll("quire://runtime/", runtimeBase).replaceAll("quire://vault/", root);

  // Restricted mode (trust.mjs): pages stay on this server, as in the app.
  const cspHeader = () => {
    const vault = getVault();
    return vault && isRestricted(vault) ? { "Content-Security-Policy": restrictedCsp({ runtime: "'self'" }) } : {};
  };
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { ...NO_CACHE, ...cspHeader(), "Content-Type": type, ...extra });
    res.end(body);
  };
  const sendText = (res, status, text) => send(res, status, "text/plain; charset=utf-8", text);

  /** The rpc URL a page's entry is given: the page is in the path, so main never takes it from the body. */
  const rpcUrlFor = (pagePath) => rpcPath + "/" + String(pagePath).split("/").map(encodeURIComponent).join("/");

  /** The page an rpc URL names, or "" (not exactly a page). */
  const pageOfRpcPath = (vault, pathname) => {
    try {
      const segs = pathname.slice(rpcPath.length + 1).split("/").filter(Boolean).map(decodeURIComponent);
      if (!segs.length || segs.some((s) => s === ".." || s === "." || s.includes("\0"))) return "";
      const split = splitPagePath(vault, segs);
      return split && !split.fileSegs.length ? split.pageSegs.join("/") : "";
    } catch {
      return "";
    }
  };

  /** A resolveVaultRequest / resolveRuntimeRequest result. entry: the page path when serving that page's entry (it gets its rpc URL). */
  const serve = (res, r, { entry = null } = {}) => {
    if (r.status !== 200) return sendText(res, r.status === "proxy" ? 404 : r.status, r.text || "Not found");
    if (r.body != null || TEXT.test(r.type)) {
      let text = r.body != null ? r.body : fs.readFileSync(r.file, "utf8");
      if (entry) text = text.replace('<meta name="quire-page"', `<meta name="quire-rpc" content="${rpcUrlFor(entry)}"><meta name="quire-page"`);
      return send(res, 200, r.type, rewrite(text));
    }
    return send(res, 200, r.type, fs.readFileSync(r.file));
  };

  /** Forward to the page's backend (backend.proxy in its .noteblock). */
  const proxy = async (req, res, vault, page, pathAndQuery) => {
    const backendPort = proxyPort ? await proxyPort(vault, page) : null;
    if (!backendPort) return sendText(res, 502, `${page} has no backend to send ${pathAndQuery} to`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const init = { method: req.method, headers, redirect: "manual" };
    if (!["GET", "HEAD"].includes(req.method)) init.body = await readBody(req);
    let out = null;
    let lastErr = null;
    // A backend that was just started needs a moment to listen.
    for (const until = Date.now() + 10000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
      try {
        out = await fetch(`http://127.0.0.1:${backendPort}${pathAndQuery}`, init);
        break;
      } catch (err) {
        lastErr = err;
        if (!/ECONNREFUSED|fetch failed/i.test(String(err?.cause?.code || err?.message || err))) break;
      }
    }
    if (!out) return sendText(res, 502, `The backend isn't answering on port ${backendPort}: ${String(lastErr?.cause?.code || lastErr?.message || lastErr)}`);
    const h = {};
    out.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) h[k] = v;
    });
    h["cache-control"] = "no-store";
    const body = out.status === 204 || out.status === 304 ? null : Buffer.from(await out.arrayBuffer());
    res.writeHead(out.status, h);
    res.end(body);
  };

  /** The page a same-server Referer belongs to ("" when none). */
  const pageOfReferer = (vault, referer, req) => {
    try {
      const u = new URL(referer);
      if (!isOwnUrl(u, req) || !u.pathname.startsWith(root)) return "";
      const segs = u.pathname.slice(root.length).split("/").filter(Boolean).map(decodeURIComponent);
      const split = splitPagePath(vault, segs);
      return split ? split.pageSegs.join("/") : "";
    } catch {
      return "";
    }
  };

  /** @returns {Promise<boolean>} false when the request isn't a vault route */
  const handle = async (req, res, url, vault) => {
    // fetch("/api/…") from a page: no page in the path, so the Referer (same origin) names the page.
    if (/^\/api(\/|$)/.test(url.pathname)) {
      const page = pageOfReferer(vault, String(req.headers.referer || ""), req);
      if (page) await proxy(req, res, vault, page, url.pathname + url.search);
      else sendText(res, 404, "Not found");
      return true;
    }

    if (url.pathname === rpcPath || url.pathname.startsWith(rpcPath + "/")) {
      if (req.method !== "POST") return sendText(res, 405, "POST only"), true;
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return sendText(res, 415, "JSON only"), true;
      // The calling page is the one in the URL the server gave its entry, never `page` in the body.
      const page = pageOfRpcPath(vault, url.pathname);
      if (!page) return sendText(res, 404, "No such page"), true;
      const ref = pageOfReferer(vault, String(req.headers.referer || ""), req);
      if (ref && ref !== page) return sendText(res, 403, "Forbidden"), true;
      let reply;
      try {
        const msg = JSON.parse((await readBody(req, RPC_MAX)).toString("utf8") || "{}");
        const params = msg.params || {};
        const result = await runRpc(vault, page, String(msg.method || ""), params, req);
        reply = { ok: result === undefined ? null : result };
      } catch (err) {
        reply = { error: String((err && err.message) || err) };
      }
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(reply));
      return true;
    }

    if (url.pathname.startsWith(runtimeBase)) return serve(res, resolveRuntimeRequest("/" + url.pathname.slice(runtimeBase.length))), true;
    if (!url.pathname.startsWith(root)) return false;

    if (!["GET", "HEAD"].includes(req.method) && !/\/api(\/|$)/.test(url.pathname)) return sendText(res, 405, "Read only"), true;
    const rest = "/" + url.pathname.slice(root.length);
    const r = resolveVaultRequest(vault, rest, { restricted: isRestricted(vault) });
    if (r.status === "proxy") return await proxy(req, res, vault, r.page, r.path + url.search), true;
    if (r.entryOf) {
      // A page folder asked for without its trailing slash: relative URLs need it.
      let segs = [];
      try {
        segs = rest.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {}
      if (!url.pathname.endsWith("/") && segs.join("/") === r.entryOf) {
        res.writeHead(301, { ...NO_CACHE, Location: url.pathname + "/" + url.search });
        res.end();
        return true;
      }
      if (onEntry) onEntry(r.entryOf);
    }
    serve(res, r, { entry: r.entryOf && r.body != null ? r.entryOf : null });
    return true;
  };

  return { handle, rewrite };
}

/** @type {Promise<{port: number, token: string, urlFor: (pagePath: string) => string, close: () => Promise<void>}> | null} */
let running = null;

/**
 * The server, started on the first call (later calls get the same one).
 * @param {{getVault: () => string, runRpc: (vault: string, page: string, method: string, params: any) => any,
 *          proxyPort?: (vault: string, page: string) => Promise<number|null>, onEntry?: (page: string) => void,
 *          isRestricted?: (vault: string) => boolean}} opts
 */
export function getBrowserServer(opts) {
  if (!running) {
    running = startBrowserServer(opts).catch((err) => {
      running = null;
      throw err;
    });
  }
  return running;
}

/** Start a new server (getBrowserServer is the lazy shared one). */
export function startBrowserServer({ getVault, runRpc, proxyPort, onEntry, isRestricted = () => false }) {
  const token = crypto.randomBytes(24).toString("base64url");
  const root = "/" + token + "/";
  let port = 0;
  const routes = createVaultRoutes({
    runRpc,
    proxyPort,
    onEntry,
    vaultBase: root,
    runtimeBase: root + "_quire/runtime/",
    rpcPath: root + "_quire/rpc",
    isOwnUrl: (u) => u.host === `127.0.0.1:${port}`,
    getVault,
    isRestricted,
  });

  const handler = async (req, res) => {
    const host = String(req.headers.host || "");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendText(res, 403, "Forbidden");
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const vault = getVault();
    if (!vault) return sendText(res, 503, "No vault open");
    if (!(await routes.handle(req, res, url, vault))) sendText(res, 404, "Not found");
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) sendText(res, 500, String((err && err.message) || err));
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      server.unref?.();
      resolve({
        port,
        token,
        urlFor: (pagePath) =>
          `http://127.0.0.1:${port}${root}` +
          String(pagePath || "")
            .split("/")
            .filter(Boolean)
            .map(encodeURIComponent)
            .join("/") +
          "/",
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
