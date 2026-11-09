// The web host: Noteblock's own editor UI over HTTP, for a headless machine. Plain Node, no
// Electron anywhere in the import graph. The renderer (app/renderer/dist) runs in a browser tab or
// an iframe and talks to this server instead of window.quireApp's IPC. docs/web-host.md has the
// routes, flags and security model.
//
//   node app/web/server.mjs --vault <dir> --port <n> --token-file <f> [--host 127.0.0.1] [--sync-every <sec>]
//
// The IPC handlers are the desktop app's own (app/main/ipc.mjs registerIpc, through a recording
// ipcMain); what the Electron main process sends the window (main.mjs) goes out as server-sent
// events on /api/events. The vault itself is served by the same routes as "Open in browser"
// (app/main/browser-server.mjs createVaultRoutes) at /v/, /runtime/ and /_quire/rpc.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  listLocks,
  migrateVault,
  migrateVaultNames,
  isVaultDir,
  isManifestName,
  ensureGitignore,
  configureRepo,
  findPage,
  buildInfo,
  isBuildOutput,
  pathDir,
} from "../../core/index.mjs";
import { registerIpc, runRpc } from "../main/ipc.mjs";
import { watchVault } from "../main/watcher.mjs";
import { flushAutosaves, onAutosaveCommit } from "../main/autosave.mjs";
import { scheduleBuild, isBuilding } from "../main/builds.mjs";
import { ensurePageIds } from "../main/origins.mjs";
import { startSync, syncNow } from "../main/sync.mjs";
import { ensureBackend, proxyPort, backendFilesChanged, onBackendStatus, stopAllBackends, killAllBackendsNow, setBackendPolicy } from "../main/backend.mjs";
import { activitySnapshot } from "../main/activity.mjs";
import { publishStatus } from "../main/publish.mjs";
import { createVaultRoutes, send, sendText, readBody } from "../main/browser-server.mjs";
import { contentType } from "../main/protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "renderer", "dist");

export const UNAVAILABLE = "Not available in the web editor";
const COOKIE = "nbw";
const CALL_MAX = 32 * 1024 * 1024;
const HEARTBEAT_MS = 25000;
const SOON_MS = 5000;

/** Page-runtime methods that change a page (ipc.mjs RPC_WRITES): other clients reload it. */
const RPC_WRITES = new Set(["save", "store.insert", "store.update", "store.remove", "kv.set", "embed.setHeight"]);

/* ------------------------------------------------------------------ flags + token */

function parseFlags(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: "string" },
      port: { type: "string" },
      "token-file": { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      "sync-every": { type: "string", default: "30" },
    },
    strict: true,
  });
  const usage = "usage: node app/web/server.mjs --vault <dir> --port <n> --token-file <f> [--host 127.0.0.1] [--sync-every <sec>]";
  if (!values.vault || !values.port || !values["token-file"]) throw new Error(usage);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Bad --port: ${values.port}`);
  const syncEvery = Number(values["sync-every"]);
  if (!Number.isFinite(syncEvery) || syncEvery < 0) throw new Error(`Bad --sync-every: ${values["sync-every"]}`);
  return { vault: path.resolve(values.vault), port, tokenFile: path.resolve(values["token-file"]), host: values.host, syncEvery };
}

/** The token in the file (trimmed); a new random one, written 0600, when there's no file yet. */
export function loadToken(file) {
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length < 16) throw new Error(`${file}: the token must be at least 16 characters`);
    return { token: t, created: false };
  }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return { token, created: true };
}

/** Constant-time token comparison (both sides hashed, so lengths never leak or throw). */
function tokenMatches(given, token) {
  if (typeof given !== "string" || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

const isHttps = (req) => String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";

/* ------------------------------------------------------------------ trash (no Finder here) */

/** shell.trashItem without Electron: move into the user's Trash (macOS ~/.Trash, else XDG). */
async function trashItem(abs) {
  const dir = process.platform === "darwin" ? path.join(os.homedir(), ".Trash") : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Trash", "files");
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(abs);
  const stem = path.basename(abs, ext);
  let dest = path.join(dir, stem + ext);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${stem} ${i}${ext}`);
  try {
    await fs.promises.rename(abs, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fs.promises.cp(abs, dest, { recursive: true });
    await fs.promises.rm(abs, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ the host */

/**
 * Start the web host. Resolves {port, close}.
 * @param {{vault: string, port: number, token: string, host?: string, syncEvery?: number, log?: (msg: string) => void}} opts
 */
export async function startWebHost({ vault: vaultDir, port, token, host = "127.0.0.1", syncEvery = 30, log = (m) => console.log(m) }) {
  if (!isVaultDir(vaultDir)) throw new Error(`Not a Noteblock vault: ${vaultDir}`);
  let vault = null;
  let stopWatch = null;
  let syncTimer = null;
  let soonTimer = null;

  /* -------------------------------------------------------------- events (SSE) */

  /** @type {Set<{res: http.ServerResponse, client: string | null}>} */
  const streams = new Set();
  const write = (s, channel, args) => {
    try {
      s.res.write(`event: ${channel}\ndata: ${JSON.stringify(args)}\n\n`);
    } catch {}
  };
  /** What main.mjs's send() does: every window hears it. */
  const broadcast = (channel, ...args) => {
    for (const s of streams) write(s, channel, args);
  };

  // The one "window" handlers in ipc.mjs reach through ctx.getWindow() / event.sender: sends
  // become broadcasts, so publish-status, hosting-changed, cloudflare-status and
  // templates-changed still arrive. reload() (vault switched) is the "reload" event.
  const webContents = {
    id: 0,
    send: (channel, ...args) => broadcast(channel, ...args),
    reload: () => broadcast("reload"),
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [] },
  };
  const fakeWindow = { isDestroyed: () => false, webContents };
  /** The calling client (X-NB-Client header): page-files-changed skips the one that wrote. */
  const senderFor = (req) => {
    const client = String(req.headers["x-nb-client"] || "").slice(0, 100) || null;
    return { ...webContents, client };
  };

  /* -------------------------------------------------------------- vault, watcher, sync */

  const notifyBuild = (msg) => broadcast("build-status", msg);

  // Cached a while: the watcher asks on every change.
  const originCache = { dir: null, at: 0, has: false };
  const hasOrigin = (dir) => {
    if (originCache.dir === dir && Date.now() - originCache.at < 30000) return originCache.has;
    let has = false;
    try {
      has = !!execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {}
    Object.assign(originCache, { dir, at: Date.now(), has });
    return has;
  };
  // Sync whenever the vault has an origin (not only when Settings turned it on): every
  // syncEvery seconds and a few seconds after an edit is committed.
  const syncing = () => !!vault && syncEvery > 0 && hasOrigin(vault);
  const syncSoon = () => {
    if (!syncing()) return;
    const v = vault;
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => vault === v && syncNow(v), SOON_MS);
  };

  function setVault(dir) {
    if (stopWatch) stopWatch();
    if (vault && vault !== dir) stopAllBackends().catch(() => {});
    for (const step of [() => migrateVaultNames(dir), () => migrateVault(dir), () => ensureGitignore(dir), () => configureRepo(dir), () => ensurePageIds(dir)]) {
      try {
        step();
      } catch (err) {
        log(`[noteblock-web] vault setup: ${err.message}`);
      }
    }
    vault = dir;
    startSync(dir, (status) => broadcast("sync-status", status));
    clearInterval(syncTimer);
    syncTimer = null;
    if (syncing()) {
      syncTimer = setInterval(() => vault === dir && syncNow(dir), syncEvery * 1000);
      setTimeout(() => vault === dir && syncNow(dir), 3000);
    }
    stopWatch = watchVault(dir, {
      onLocks: () => {
        broadcast("locks-changed", listLocks(dir));
        syncSoon();
      },
      onTree: () => {
        broadcast("tree-changed");
        syncSoon();
      },
      onPage: (p, files) => {
        syncSoon();
        let node = null;
        try {
          node = findPage(dir, p);
        } catch {}
        // Backend folder: restart its processes, and don't reload the page for it.
        const be = node && node.backend;
        if (be) {
          const inBackend = (f) => f === be.dir || f.startsWith(be.dir + "/");
          const own = files.filter((f) => f && inBackend(f));
          if (own.some((f) => !/(^|\/)(data|node_modules|\.git)(\/|$)/.test(f.slice(be.dir.length)) && !/\.log$/.test(f))) backendFilesChanged(dir, p);
          if (files.some(isManifestName)) ensureBackend(dir, p).catch(() => {});
          files = files.filter((f) => !inBackend(f));
          if (!files.length) return;
        }
        const info = node && node.build ? buildInfo(node.dir) : null;
        if (info) {
          if (isBuilding(dir, p)) return;
          if (files.some((f) => f && !isBuildOutput(info, f))) {
            scheduleBuild(dir, p, { reload: true, ifChanged: true, notify: notifyBuild });
            return;
          }
        }
        broadcast("page-files-changed", p);
      },
    });
  }

  onAutosaveCommit(() => syncSoon());
  onBackendStatus((status) => broadcast("backend-status", status));
  setVault(vaultDir);

  /* -------------------------------------------------------------- IPC handlers */

  const unavailable = () => Promise.reject(new Error(UNAVAILABLE));
  const fail = () => {
    throw new Error(UNAVAILABLE);
  };
  const ctx = {
    dialog: { showOpenDialog: unavailable, showSaveDialog: unavailable, showMessageBox: unavailable, showErrorBox: fail },
    shell: { trashItem, showItemInFolder: fail, openPath: unavailable, openExternal: unavailable },
    clipboard: { writeText: fail, readText: fail },
    Menu: { buildFromTemplate: fail },
    rebuildMenu: () => {},
    getVault: () => vault,
    setVault,
    notifyBuild,
    getWindow: () => fakeWindow,
    floating: null,
    devtools: null,
    pageStorage: null,
    broadcast,
    // A write from one client: the others reload that page. Without a client id nobody is told
    // (the writer must not reload what it is typing into).
    onPageWritten: (pagePath, sender) => {
      const from = sender && sender.client;
      if (!from) return;
      for (const s of streams) if (s.client && s.client !== from) write(s, "page-files-changed", [pagePath]);
    },
    dev: null,
  };

  /** @type {Map<string, (event: any, ...args: any[]) => Promise<{ok: any} | {error: string}>>} */
  const handlers = new Map();
  registerIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, ctx);

  // Overrides: the same {ok}|{error} envelope as registerIpc's.
  const override = (channel, fn) =>
    handlers.set(channel, async (event, ...args) => {
      try {
        const ok = await fn(event, ...args);
        return { ok: ok === undefined ? null : ok };
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    });
  // Need a window, Electron's session, a native menu or this machine's desktop: answer an error
  // without running (some would import Electron).
  for (const channel of WEB_UNAVAILABLE) override(channel, fail);
  // No Electron processes to measure here.
  const snapshot = () => activitySnapshot(vault, { appMetrics: () => [], pageProcesses: () => [] });
  override("quire:activity", snapshot);
  override("quire:setBackendPolicy", async (_e, policy) => {
    await setBackendPolicy(policy);
    return snapshot();
  });
  override("quire:stopAllBackends", async () => {
    await stopAllBackends();
    return snapshot();
  });
  // A new origin starts (or stops) the interval sync.
  const setRemote = handlers.get("quire:setSyncRemote");
  handlers.set("quire:setSyncRemote", async (event, ...args) => {
    const out = await setRemote(event, ...args);
    originCache.at = 0;
    if (!out.error) setVault(vault);
    return out;
  });
  // Page rpcs: the renderer sends [origin, method, params, pagePath]. Pages under /v/ share the
  // host's origin, so the page comes from pagePath (the frame the message came from) instead of
  // pageForOrigin as in the app.
  override("quire:rpc", (event, _origin, method, params, pagePath) => {
    if (typeof pagePath !== "string" || !pagePath) throw new Error("This frame isn't a Noteblock page");
    const page = findPage(vault, pagePath).path;
    if (method === "storage.migrated") return null;
    if (method === "devtools.inspectEmbed") throw new Error(UNAVAILABLE);
    const result = runRpc(vault, page, String(method || ""), params || {});
    if (RPC_WRITES.has(method)) ctx.onPageWritten(method === "embed.setHeight" ? findPage(vault, params.page).path : page, event && event.sender);
    return result;
  });
  // No page processes to probe or kill in a browser: every page answers "ok".
  override("quire:probePage", () => ({ state: "ok", pid: null, pages: [] }));
  override("quire:killPageProcess", () => null);
  // createFolder("A/B/C") makes the missing parents too (each a folder with its .gitkeep).
  const createFolder = handlers.get("quire:createFolder");
  handlers.set("quire:createFolder", async (event, folderPath, ...rest) => {
    const segs = String(folderPath || "").split("/").filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join("/");
      let exists = true;
      try {
        exists = fs.existsSync(pathDir(vault, parent));
      } catch {}
      if (exists) continue;
      const out = await createFolder(event, parent);
      if (out.error) return out;
    }
    return createFolder(event, folderPath, ...rest);
  });
  // Nothing to open on this machine: the URL comes back for the browser to open.
  override("quire:openInBrowser", (_e, pagePath) => {
    const node = findPage(vault, pagePath);
    const pub = publishStatus(vault, node.path).public;
    if (pub && pub.url) return pub.url;
    return "/v/" + node.path.split("/").filter(Boolean).map(encodeURIComponent).join("/") + "/";
  });

  /* -------------------------------------------------------------- HTTP */

  const routes = createVaultRoutes({
    runRpc: (v, page, method, params, req) => {
      const result = runRpc(v, page, method, params);
      if (RPC_WRITES.has(method)) {
        try {
          ctx.onPageWritten(method === "embed.setHeight" ? findPage(v, params.page).path : page, senderFor(req));
        } catch {}
      }
      return result;
    },
    proxyPort: (v, p) => proxyPort(v, p),
    onEntry: (p) => ensureBackend(vault, p).catch((err) => log(`[noteblock-web] backend: ${err.message}`)),
    vaultBase: "/v/",
    runtimeBase: "/runtime/",
    rpcPath: "/_quire/rpc",
    isOwnUrl: (u, req) => [req.headers.host, req.headers["x-forwarded-host"]].some((h) => h && u.host === String(h).split(",")[0].trim()),
  });

  const json = (res, status, body) => send(res, status, "application/json; charset=utf-8", JSON.stringify(body));

  const embed = (req, res, url, given) => {
    const file = path.join(DIST, "index.html");
    if (!fs.existsSync(file)) return sendText(res, 503, "The editor isn't built: run `pnpm build` (app/renderer/dist is missing)");
    const folder = url.searchParams.get("folder") || "";
    const boot = `<script>window.__NB_WEB__=${JSON.stringify({ folder }).replace(/</g, "\\u003c")}</script>`;
    let html = fs.readFileSync(file, "utf8");
    const at = html.search(/<script\b/i);
    html = at >= 0 ? html.slice(0, at) + boot + html.slice(at) : html.replace(/<\/head>/i, boot + "</head>");
    const cookie = `${COOKIE}=${encodeURIComponent(given)}; HttpOnly; SameSite=Lax; Path=/${isHttps(req) ? "; Secure" : ""}`;
    send(res, 200, "text/html; charset=utf-8", html, { "Set-Cookie": cookie });
  };

  const call = async (req, res, channel) => {
    if (req.method !== "POST") return sendText(res, 405, "POST only");
    // JSON only: a cross-site form can't send it without a CORS preflight, which never passes.
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return sendText(res, 415, "JSON only");
    const fn = handlers.get(channel);
    if (!fn) return json(res, 404, { error: `Unknown channel: ${channel}` });
    let args;
    try {
      const body = JSON.parse((await readBody(req, CALL_MAX)).toString("utf8") || "{}");
      args = Array.isArray(body.args) ? body.args : [];
    } catch (err) {
      return json(res, 400, { error: `Bad request: ${err.message}` });
    }
    json(res, 200, await fn({ sender: senderFor(req) }, ...args));
  };

  const events = (req, res, url) => {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    const s = { res, client: (url.searchParams.get("client") || "").slice(0, 100) || null };
    streams.add(s);
    const beat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {}
    }, HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(beat);
      streams.delete(s);
    });
  };

  /** A file of the built renderer (app/renderer/dist), at its own path. */
  const distFile = (res, pathname) => {
    let rel;
    try {
      rel = decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch {
      return false;
    }
    if (!rel || rel.split("/").some((s) => !s || s === "." || s === ".." || s.includes("\0"))) return false;
    const file = path.join(DIST, ...rel.split("/"));
    if (!file.startsWith(DIST + path.sep)) return false;
    try {
      if (!fs.statSync(file).isFile()) return false;
    } catch {
      return false;
    }
    send(res, 200, contentType(file), fs.readFileSync(file), /^assets\//.test(rel) ? { "Cache-Control": "private, max-age=31536000, immutable" } : {});
    return true;
  };

  const handler = async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const fromQuery = url.searchParams.get("t");
    const fromCookie = cookieOf(req, COOKIE);
    const authed = tokenMatches(fromQuery, token) || tokenMatches(fromCookie, token);

    if (url.pathname === "/embed" && req.method === "GET") {
      if (!tokenMatches(fromQuery, token) && !tokenMatches(fromCookie, token)) return sendText(res, 401, "Unauthorized");
      return embed(req, res, url, tokenMatches(fromQuery, token) ? fromQuery : fromCookie);
    }
    if (!authed) return sendText(res, 401, "Unauthorized");

    if (url.pathname.startsWith("/api/call/")) {
      let channel;
      try {
        channel = decodeURIComponent(url.pathname.slice("/api/call/".length));
      } catch {
        return json(res, 400, { error: "Bad channel" });
      }
      return call(req, res, channel);
    }
    if (url.pathname === "/api/events") {
      if (req.method !== "GET") return sendText(res, 405, "GET only");
      return events(req, res, url);
    }
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(302, { Location: "/embed" + url.search, "Cache-Control": "no-store" });
      return res.end();
    }
    if (await routes.handle(req, res, url, vault)) return;
    if (["GET", "HEAD"].includes(req.method) && distFile(res, url.pathname)) return;
    sendText(res, 404, "Not found");
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) sendText(res, 500, String((err && err.message) || err));
      else res.end();
    });
  });
  // SSE streams stay open; don't let Node's request timeouts cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;

  const close = async () => {
    clearInterval(syncTimer);
    clearTimeout(soonTimer);
    if (stopWatch) stopWatch();
    for (const s of streams) {
      try {
        s.res.end();
      } catch {}
    }
    streams.clear();
    flushAutosaves();
    await stopAllBackends().catch(() => {});
    await new Promise((r) => server.close(() => r()));
  };

  return { port: actual, close, channels: () => [...handlers.keys()] };
}

/** Channels that answer {error: UNAVAILABLE} in the web editor. */
export const WEB_UNAVAILABLE = [
  // page-devtools / spelling need Electron
  "quire:inspectPage",
  "quire:dictionaryWords",
  "quire:addDictionaryWord",
  "quire:removeDictionaryWord",
  // native menu, clipboard, Finder, the machine's browser
  "quire:contextMenu",
  "quire:popupAppMenu",
  "quire:copyText",
  "quire:copyPath",
  "quire:reveal",
  "quire:revealBackendLog",
  "quire:revealUpdateLog",
  "quire:revealTemplate",
  "quire:openFileExternally",
  // file pickers and the vault this host is bound to
  "quire:pickImportSource",
  "quire:importArtifactFiles",
  "quire:openVault",
  "quire:createVault",
  "quire:moveVault",
  "quire:switchVault",
  // sign-ins open a browser on the host machine; the desktop updater
  "quire:hostingSignIn",
  "quire:cloudflareLogin",
  "quire:runUpdate",
  // the floating note is a desktop window
  "quire:getFloating",
  "quire:setFloating",
  "quire:openFloating",
  "quire:hideFloating",
  "quire:floatingPage",
  "quire:newFloatingNote",
  "quire:floatingPicking",
];

/* ------------------------------------------------------------------ CLI */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { token, created } = loadToken(flags.tokenFile);
  if (created) console.log(`[noteblock-web] wrote a new token to ${flags.tokenFile}`);
  process.on("exit", killAllBackendsNow);
  startWebHost({ vault: flags.vault, port: flags.port, token, host: flags.host, syncEvery: flags.syncEvery }).then(
    ({ port, close }) => {
      console.log(`[noteblock-web] ${flags.vault} on http://${flags.host}:${port}/embed?t=…`);
      let closing = false;
      const stop = () => {
        if (closing) return process.exit(1);
        closing = true;
        close().finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
    (err) => {
      console.error(`[noteblock-web] ${err.message}`);
      process.exit(1);
    },
  );
}
