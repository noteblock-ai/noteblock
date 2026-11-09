// Inspect page: a Chrome DevTools window scoped to one page (or one embed). See
// docs/decisions/page-devtools.md and docs/contract.md, "Developer tools".
//
// Every page and embed has its own origin (quire://p-<id>, origins.mjs), so it is an
// out-of-process iframe of its window and a CDP target of its own. For an inspector:
//   - the window's webContents.debugger attaches (only while an inspector of that window is
//     open), and Target.attachToTarget gives a flat session for the page's iframe target;
//   - a one-connection WebSocket relay on 127.0.0.1 (devtools-relay.mjs, random port and token)
//     carries that one session to the DevTools frontend Electron ships
//     (devtools://devtools/bundled/devtools_app.html?ws=…) in a BrowserWindow Quire owns. The
//     frontend sees a plain single-target connection: messages without a sessionId go to the
//     page's session; child sessions it auto-attaches (workers) pass through; other pages'
//     iframes (embeds) are detached instead of shown, and Target discovery is answered locally,
//     so nothing about other pages reaches it.
//   - When the iframe goes (Reload, a recovery reload, switching tab) the inspector waits and
//     reconnects to the page's next iframe in that window; it closes when the page is deleted,
//     no tab shows it any more, or its window closes.
import { BrowserWindow } from "electron";
import { startRelay } from "./devtools-relay.mjs";
import { idOfHost } from "./origins.mjs";

const FRONTEND = "devtools://devtools/bundled/devtools_app.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Target.* the frontend may not drive: they reach beyond its one page. */
const LOCAL_TARGET = {
  "Target.setDiscoverTargets": () => ({}),
  "Target.getTargets": () => ({ targetInfos: [] }),
  "Target.setRemoteLocations": () => ({}),
};
const REFUSED = new Set(["Target.attachToTarget", "Target.attachToBrowserTarget", "Target.createTarget", "Target.closeTarget", "Target.activateTarget", "Target.createBrowserContext", "Target.disposeBrowserContext", "Target.getBrowserContexts", "Target.exposeDevToolsProtocol", "Target.autoAttachRelated"]);

// (Node's URL gives a custom scheme the origin "null": read the host.)
const idOfUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "quire:" ? idOfHost(u.host) : null;
  } catch {
    return null;
  }
};

/** Waiting page shown while the page's iframe is gone. */
function waitingHtml(title) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>${esc(title)} — DevTools</title>
<style>:root{color-scheme:light dark}body{margin:0;font:13px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;background:Canvas;color:GrayText}</style>
<p>${esc(title)} isn't showing. This window reconnects when it is.</p>`)
  );
}

/**
 * One window's debugger connection, shared by that window's inspectors. Attached while at least
 * one inspector is open; detached with the last.
 */
class Hub {
  constructor(wc, onEmpty) {
    this.wc = wc;
    this.onEmpty = onEmpty;
    this.inspectors = new Set();
    this.attached = false;
    this.mainTargetId = null;
    // Flat sessions alive right now, with their parent session. Electron 44 crashes the main
    // process (SIGBUS/SIGSEGV) on any command naming a session that has already detached, so
    // nothing is ever sent to one that isn't in here (see docs/decisions/page-devtools.md).
    this.live = new Map(); // sessionId → parent sessionId ("" = this window's own)
    this.onMessage = (_e, method, params, sessionId) => this.dispatch(method, params, sessionId);
    this.onDetach = () => {
      this.attached = false;
      this.live.clear();
      for (const ins of this.inspectors) ins.targetGone();
    };
  }

  get dbg() {
    return this.wc.debugger;
  }

  async ensure() {
    if (this.attached && this.dbg.isAttached()) return;
    if (!this.dbg.isAttached()) this.dbg.attach("1.3");
    this.attached = true;
    this.dbg.removeListener("message", this.onMessage);
    this.dbg.removeListener("detach", this.onDetach);
    this.dbg.on("message", this.onMessage);
    this.dbg.on("detach", this.onDetach);
    const { targetInfo } = await this.dbg.sendCommand("Target.getTargetInfo");
    this.mainTargetId = targetInfo.targetId;
    // targetCreated / targetInfoChanged tell a waiting inspector its page is back.
    await this.dbg.sendCommand("Target.setDiscoverTargets", { discover: true });
  }

  send(method, params = {}, sessionId) {
    if (!this.attached || this.wc.isDestroyed()) return Promise.reject(new Error("Not attached"));
    if (sessionId && !this.live.has(sessionId)) return Promise.reject(new Error("Session not found"));
    if (method === "Target.detachFromTarget" && params.sessionId && !this.live.has(params.sessionId)) return Promise.resolve({});
    return this.dbg.sendCommand(method, params, sessionId);
  }

  /** A session ended: it and every session under it. */
  dropSession(sid) {
    const gone = [sid];
    for (let i = 0; i < gone.length; i++) for (const [s, parent] of this.live) if (parent === gone[i] && !gone.includes(s)) gone.push(s);
    for (const s of gone) this.live.delete(s);
    return gone;
  }

  /** This window's iframe targets: [{targetId, parentId, url, id}] (embeds of embeds too). */
  async frames() {
    const { targetInfos } = await this.send("Target.getTargets");
    const byId = new Map(targetInfos.map((t) => [t.targetId, t]));
    const mine = (t) => {
      for (let i = 0, cur = t; cur && i < 32; i++, cur = byId.get(cur.parentId)) if (cur.targetId === this.mainTargetId) return true;
      return false;
    };
    return targetInfos.filter((t) => t.type === "iframe" && mine(t)).map((t) => ({ targetId: t.targetId, parentId: t.parentId, url: t.url, id: idOfUrl(t.url), parentPageId: idOfUrl((byId.get(t.parentId) || {}).url) }));
  }

  dispatch(method, params, sessionId) {
    // Keep `live` exact before anything else runs: events arrive synchronously, so a check
    // right before a send can't race a detach.
    if (method === "Target.attachedToTarget" && params.sessionId) this.live.set(params.sessionId, sessionId || "");
    let gone = null;
    if (method === "Target.detachedFromTarget" && params.sessionId) gone = this.dropSession(params.sessionId);
    if (!sessionId) {
      if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") for (const ins of this.inspectors) ins.maybeBack(params.targetInfo);
      if (gone) for (const ins of this.inspectors) if (gone.includes(ins.session)) setImmediate(() => ins.targetGone());
      return;
    }
    if (gone) for (const ins of this.inspectors) for (const s of gone) ins.kids.delete(s);
    for (const ins of this.inspectors) if (ins.owns(sessionId)) ins.event(method, params, sessionId);
  }

  add(ins) {
    this.inspectors.add(ins);
  }

  remove(ins) {
    this.inspectors.delete(ins);
    if (this.inspectors.size) return;
    try {
      if (!this.wc.isDestroyed() && this.dbg.isAttached()) {
        this.dbg.sendCommand("Target.setDiscoverTargets", { discover: false }).catch(() => {});
        this.dbg.detach();
      }
    } catch {}
    this.attached = false;
    this.onEmpty(this);
  }
}

class Inspector {
  /** key: {id, embedOf}; title: () => string; show: open the window visibly. */
  constructor(hub, { id, embedOf, path, title, show, onClosed }) {
    this.hub = hub;
    this.id = id;
    this.embedOf = embedOf || null;
    this.path = path;
    this.titleFn = title;
    this.onClosed = onClosed;
    this.show = show;
    this.session = null;
    this.targetId = null;
    this.kids = new Set();
    this.forwarded = new Set(); // child sessions the frontend was told about
    this.relay = null;
    this.win = null;
    this.queue = null; // a promise while the session is being attached
    this.closed = false;
    this.connects = 0;
  }

  get key() {
    return keyOf(this.hub.wc, this.id, this.embedOf);
  }

  title() {
    return `${this.titleFn() || this.path} — DevTools`;
  }

  owns(sessionId) {
    return sessionId === this.session || this.kids.has(sessionId);
  }

  /** The iframe target this inspector is for, in its window, or null. */
  async findTarget() {
    const frames = (await this.hub.frames()).filter((f) => f.id === this.id);
    if (!frames.length) return null;
    const top = frames.filter((f) => f.parentId === this.hub.mainTargetId);
    const embeds = frames.filter((f) => f.parentId !== this.hub.mainTargetId && (!this.embedOf || f.parentPageId === this.embedOf));
    const pick = this.embedOf ? embeds[0] || top[0] || frames[0] : top[0] || embeds[0] || frames[0];
    return pick || null;
  }

  async open() {
    this.relay = await startRelay({
      onOpen: () => {
        this.connects++;
        this.queue = this.attach();
      },
      onMessage: (text) => this.command(text),
      onClose: () => this.detachSession(),
    });
    this.win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: this.title(),
      show: false,
      backgroundColor: "#FFFFFF",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.win.__quireInspector = true;
    this.win.on("page-title-updated", (e) => {
      e.preventDefault();
      this.win.setTitle(this.title());
    });
    this.win.once("ready-to-show", () => this.show && this.win && !this.win.isDestroyed() && this.win.show());
    this.win.on("closed", () => {
      this.win = null;
      this.close();
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const t = await this.findTarget().catch(() => null);
    if (t) await this.loadFrontend();
    else await this.loadWaiting();
  }

  async loadFrontend() {
    if (!this.win || this.win.isDestroyed()) return;
    this.waiting = false;
    this.relay.drop();
    await this.win.loadURL(`${FRONTEND}?ws=${this.relay.wsParam}`).catch(() => {});
  }

  async loadWaiting() {
    if (!this.win || this.win.isDestroyed()) return;
    this.waiting = true;
    this.relay.drop();
    await this.win.loadURL(waitingHtml(this.titleFn() || this.path)).catch(() => {});
  }

  /** The frontend connected: attach a fresh session to the page's current iframe. */
  async attach() {
    await this.hub.ensure();
    const t = await this.findTarget();
    if (!t) throw new Error("The page isn't showing");
    const { sessionId } = await this.hub.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    if (!this.hub.live.has(sessionId)) this.hub.live.set(sessionId, "");
    this.session = sessionId;
    this.targetId = t.targetId;
    this.kids.clear();
    return sessionId;
  }

  detachSession() {
    const s = this.session;
    this.session = null;
    this.targetId = null;
    this.kids.clear();
    this.forwarded.clear();
    this.queue = null;
    // Detaching ends every domain the frontend enabled (breakpoints, overrides, emulation).
    if (s && this.hub.attached) this.hub.send("Target.detachFromTarget", { sessionId: s }).catch(() => {});
  }

  reply(obj) {
    if (this.relay) this.relay.send(JSON.stringify(obj));
  }

  async command(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const { id, method } = msg;
    const sid = msg.sessionId;
    const out = (body) => this.reply({ id, ...body, ...(sid ? { sessionId: sid } : {}) });
    if (!sid && LOCAL_TARGET[method]) return out({ result: LOCAL_TARGET[method](msg.params) });
    if (REFUSED.has(method)) return out({ error: { code: -32000, message: "Not allowed in a page inspector" } });
    let root;
    try {
      root = await this.queue;
    } catch (err) {
      return out({ error: { code: -32000, message: String(err.message || err) } });
    }
    if (!root || (sid && !this.kids.has(sid))) return out({ error: { code: -32001, message: "Session not found" } });
    let params = msg.params || {};
    // Nothing waits for this frontend before it runs: another page's iframe it is not shown
    // would otherwise stay paused.
    if (method === "Target.setAutoAttach") params = { ...params, waitForDebuggerOnStart: false };
    try {
      const result = await this.hub.send(method, params, sid || root);
      out({ result: result || {} });
    } catch (err) {
      out({ error: { code: -32000, message: String(err.message || err) } });
    }
  }

  event(method, params, sessionId) {
    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo || {};
      const other = info.type === "iframe" && idOfUrl(info.url) !== this.id;
      if (other) {
        // Another page (an embed): it has its own inspector. Let it go.
        setImmediate(() => this.hub.send("Target.detachFromTarget", { sessionId: params.sessionId }, sessionId).catch(() => {}));
        return;
      }
      this.kids.add(params.sessionId);
      this.forwarded.add(params.sessionId);
    }
    if (method === "Target.detachedFromTarget") {
      if (!this.forwarded.has(params.sessionId)) return;
      this.forwarded.delete(params.sessionId);
    }
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged" || method === "Target.targetDestroyed") return;
    this.reply(sessionId === this.session ? { method, params } : { method, params, sessionId });
  }

  /** Our iframe went away (Reload, recovery, another tab): wait for the page's next one. */
  targetGone() {
    if (this.closed || this.waiting) return;
    this.detachSession();
    this.relay.drop();
    clearTimeout(this.goneTimer);
    // A reload swaps the iframe in well under a second: reconnect without the waiting page.
    this.goneTimer = setTimeout(async () => {
      if (this.closed) return;
      const t = await this.findTarget().catch(() => null);
      if (t) await this.loadFrontend();
      else await this.loadWaiting();
    }, 400);
  }

  async maybeBack(info) {
    if (this.closed || !this.waiting || !info || info.type !== "iframe" || idOfUrl(info.url) !== this.id) return;
    const t = await this.findTarget().catch(() => null);
    if (t && this.waiting && !this.closed) await this.loadFrontend();
  }

  focus() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    if (this.show) this.win.show();
    this.win.focus();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.goneTimer);
    this.detachSession();
    if (this.relay) this.relay.close();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.hub.remove(this);
    this.onClosed(this);
  }
}

const wcIds = new WeakMap();
let nextWc = 1;
function keyOf(wc, id, embedOf) {
  if (!wcIds.has(wc)) wcIds.set(wc, nextWc++);
  return `${wcIds.get(wc)}:${id}:${embedOf || ""}`;
}

/**
 * opts: {idForPath(path) → id|null, pathForId(id) → path|null, titleFor(path) → string,
 *        show: boolean (false in capture runs)}.
 */
export function createPageDevtools({ idForPath, pathForId, titleFor, show = true }) {
  const hubs = new Map(); // webContents → Hub
  const inspectors = new Map(); // key → Inspector

  function hubFor(wc) {
    let h = hubs.get(wc);
    if (!h) {
      h = new Hub(wc, () => hubs.delete(wc));
      hubs.set(wc, h);
      wc.once("destroyed", () => {
        for (const ins of [...h.inspectors]) ins.close();
        hubs.delete(wc);
      });
    }
    return h;
  }

  /**
   * Open (or bring forward) the inspector for page `path` shown in window `wc`. embedOf: the
   * path of the page holding it, for an embed. Resolves to the Inspector.
   */
  async function inspect(wc, { path, embedOf = null }) {
    if (!wc || wc.isDestroyed()) throw new Error("No window to inspect");
    const id = idForPath(path);
    if (!id) throw new Error(`Not a page: ${path}`);
    const parentId = embedOf ? idForPath(embedOf) : null;
    const key = keyOf(wc, id, parentId);
    const have = inspectors.get(key);
    if (have && !have.closed) {
      have.focus();
      return have;
    }
    const hub = hubFor(wc);
    await hub.ensure();
    const ins = new Inspector(hub, {
      id,
      embedOf: parentId,
      path,
      title: () => titleFor(pathForId(id) || path),
      show,
      onClosed: (i) => inspectors.get(i.key) === i && inspectors.delete(i.key),
    });
    hub.add(ins);
    inspectors.set(key, ins);
    try {
      await ins.open();
    } catch (err) {
      ins.close();
      throw err;
    }
    ins.focus();
    return ins;
  }

  /** ⌘⌥J: the page or embed that has focus in window `wc` (the deepest focused embed). */
  async function inspectFocused(wc) {
    if (!wc || wc.isDestroyed()) return null;
    const pageFrames = () => {
      try {
        return wc.mainFrame.frames.filter((f) => idOfUrl(f.url));
      } catch {
        return [];
      }
    };
    let frame = pageFrames()[0];
    if (!frame) return null;
    let holder = null;
    for (let depth = 0; depth < 4; depth++) {
      // The holder's runtime knows whether focus sits in one of its embeds. A frozen page never
      // answers: then the page itself.
      const src = await Promise.race([frame.executeJavaScript(`(function(){var a=document.activeElement;return a&&a.tagName==="IFRAME"?a.src:null})()`).catch(() => null), sleep(400).then(() => null)]);
      // The embed's src is quire://vault/<path>/ (redirected to quire://p-<id>/<path>/): match on the path.
      const pathOf = (u) => String(u).replace(/[?#].*$/, "").replace(/^[a-z]+:\/\/[^/]*/i, "");
      const child = src ? frame.frames.find((f) => pathOf(f.url) === pathOf(src)) : null;
      if (!child || !idOfUrl(child.url)) break;
      holder = frame;
      frame = child;
    }
    const path = pathForId(idOfUrl(frame.url));
    if (!path) return null;
    const embedOf = holder ? pathForId(idOfUrl(holder.url)) : null;
    return inspect(wc, { path, embedOf });
  }

  /** The vault changed: close inspectors of pages that no longer exist, retitle the rest. */
  function pagesChanged() {
    for (const ins of [...inspectors.values()]) {
      if (!pathForId(ins.id)) ins.close();
      else if (ins.win && !ins.win.isDestroyed()) ins.win.setTitle(ins.title());
    }
  }

  /** Window `wc` now shows these pages (its open tabs): close its inspectors for any other. */
  function openPages(wc, paths) {
    const ids = new Set((paths || []).map((p) => idForPath(p)).filter(Boolean));
    for (const ins of [...inspectors.values()]) {
      if (ins.hub.wc !== wc) continue;
      if (!ids.has(ins.embedOf || ins.id)) ins.close();
    }
  }

  function closeAll() {
    for (const ins of [...inspectors.values()]) ins.close();
  }

  /** Is this BrowserWindow an inspector? (The app menu leaves them alone.) */
  const isInspector = (bw) => !!(bw && bw.__quireInspector);

  return { inspect, inspectFocused, pagesChanged, openPages, closeAll, isInspector, list: () => [...inspectors.values()] };
}
