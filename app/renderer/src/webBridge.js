// The renderer in a plain browser tab (app/web, the headless web host). When the host serves
// index.html it injects `window.__NB_WEB__ = {folder?}` before the bundle; with no Electron
// preload around, this defines `window.quireApp` with the same methods as app/main/preload.cjs,
// each one a POST /api/call/<the same channel> ({args} → {ok} | {error}), and every on*(cb)
// a listener on one shared EventSource (/api/events, `event: <channel>`, data = JSON args).
//
// Imported first thing in main.jsx: platform.js reads window.quireApp when it loads.
//
// Three methods never leave the tab, because the host can't do them for the viewer: contextMenu
// (a small menu drawn here), copyText (the viewer's clipboard) and popupAppMenu (no app menu).

const W = typeof window !== "undefined" ? window : null;

/** {folder?} from the host, or null in the desktop app. */
export const web = W && W.__NB_WEB__ && typeof W.__NB_WEB__ === "object" && !W.quireApp ? W.__NB_WEB__ : null;
export const isWeb = !!web;
/** The one vault folder an embed shows ("Projects/billable"), or "" outside embed mode. */
export const embedFolder = web && typeof web.folder === "string" ? web.folder.replace(/^\/+|\/+$/g, "") : "";
export const isEmbed = !!embedFolder;

const enc = (segs) => segs.filter((s) => s !== "").map(encodeURIComponent).join("/");

/** URL of a vault path (segments joined by "/"): quire://vault/… in the app, /v/… on the web host. */
export function vaultUrl(path) {
  const p = enc(String(path || "").split("/"));
  return (isWeb ? "/v/" : "quire://vault/") + p;
}

/** URL of a runtime file: quire://runtime/… in the app, /runtime/… on the web host. */
export function runtimeUrl(file) {
  return (isWeb ? "/runtime/" : "quire://runtime/") + enc(String(file || "").split("/"));
}

/**
 * The vault path a same-origin web URL points into (/v/<segs>…), decoded, or null. Used to
 * find which page a message came from (all pages share one origin on the web host).
 */
export function vaultPathOfUrl(url) {
  if (!isWeb || !url) return null;
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith("/v/")) return null;
    return u.pathname
      .slice(3)
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s))
      .join("/");
  } catch {
    return null;
  }
}

/** Is a message's origin one of the vault's pages? */
export function isPageOrigin(origin) {
  const o = String(origin || "");
  if (/^quire:/.test(o)) return true;
  return isWeb && o === location.origin;
}

/* ------------------------------------------------------------------ transport */

async function call(channel, ...args) {
  let res;
  try {
    const r = await fetch("/api/call/" + channel, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: args.map((a) => (a === undefined ? null : a)) }),
    });
    const text = await r.text();
    res = text ? JSON.parse(text) : null;
    if (!r.ok && !(res && typeof res === "object" && "error" in res)) throw new Error(`${channel} failed (HTTP ${r.status})`);
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`${channel}: the server's answer wasn't JSON`);
    throw e;
  }
  if (res && typeof res === "object" && "error" in res) throw new Error(res.error);
  return res && typeof res === "object" ? (res.ok === undefined ? null : res.ok) : null;
}

// One EventSource for every subscription, opened on the first and closed after the last.
const listeners = new Map(); // channel → Set<cb>
let source = null;

function dispatch(channel, ev) {
  let args;
  try {
    args = ev.data ? JSON.parse(ev.data) : [];
  } catch {
    return;
  }
  if (!Array.isArray(args)) args = [args];
  for (const cb of [...(listeners.get(channel) || [])]) {
    try {
      cb(...args);
    } catch (err) {
      console.error(`[quire] ${channel} handler failed`, err);
    }
  }
}

function ensureSource() {
  if (source) return;
  source = new EventSource("/api/events", { withCredentials: true });
  for (const channel of listeners.keys()) source.addEventListener(channel, (ev) => dispatch(channel, ev));
}

function on(channel) {
  return (cb) => {
    if (typeof cb !== "function") return () => {};
    let set = listeners.get(channel);
    if (!set) {
      listeners.set(channel, (set = new Set()));
      if (source) source.addEventListener(channel, (ev) => dispatch(channel, ev));
    }
    set.add(cb);
    ensureSource();
    return () => {
      set.delete(cb);
      // The channel's EventSource listener stays (it dispatches to an empty set); the source
      // closes once nobody listens to anything.
      if ([...listeners.values()].every((s) => s.size === 0) && source) {
        source.close();
        source = null;
        listeners.clear();
      }
    };
  };
}

/* ------------------------------------------------------------------ local-only methods */

// Where the last click happened, so a menu opens under the button that asked for it.
let lastPointer = null;
if (W && web) {
  W.addEventListener(
    "pointerdown",
    (e) => {
      const el = e.target && e.target.closest ? e.target.closest("button, [role=tab], [role=treeitem], a") : null;
      lastPointer = { x: e.clientX, y: e.clientY, rect: el ? el.getBoundingClientRect() : null };
    },
    true,
  );
}

/**
 * The native context menu, drawn in the page: items as preload's contextMenu takes them
 * ({id, label, type: "separator"|"radio"|"checkbox", checked, enabled, accelerator}).
 * Resolves to the picked id, or null when dismissed.
 */
function contextMenu(items) {
  return new Promise((resolve) => {
    const list = Array.isArray(items) ? items : [];
    const menu = document.createElement("div");
    menu.className = "pub-menu web-menu";
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;
    const buttons = [];
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
      menu.remove();
      resolve(id ?? null);
    };
    const onDown = (e) => {
      if (!menu.contains(e.target)) finish(null);
    };
    const onBlur = () => finish(null);
    for (const it of list) {
      if (!it) continue;
      if (it.type === "separator") {
        const sep = document.createElement("div");
        sep.className = "pub-menu-sep";
        sep.setAttribute("role", "separator");
        menu.appendChild(sep);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pub-menu-item web-menu-item";
      b.setAttribute("role", it.type === "radio" ? "menuitemradio" : it.type === "checkbox" ? "menuitemcheckbox" : "menuitem");
      if (it.type === "radio" || it.type === "checkbox") b.setAttribute("aria-checked", it.checked ? "true" : "false");
      b.disabled = it.enabled === false;
      const check = document.createElement("span");
      check.className = "web-menu-check";
      check.textContent = it.checked ? "✓" : "";
      const label = document.createElement("span");
      label.className = "pub-menu-label";
      label.textContent = it.label || "";
      b.append(check, label);
      b.addEventListener("click", () => finish(it.id));
      b.addEventListener("mouseenter", () => b.focus());
      buttons.push(b);
      menu.appendChild(b);
    }
    menu.addEventListener("keydown", (e) => {
      const live = buttons.filter((b) => !b.disabled);
      const at = live.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!live.length) return;
        const next = at < 0 ? 0 : (at + (e.key === "ArrowDown" ? 1 : live.length - 1)) % live.length;
        live[next].focus();
      }
    });
    document.body.appendChild(menu);
    // Under the button that was clicked (right-aligned when it sits on the right), else at the pointer.
    const r = menu.getBoundingClientRect();
    const p = lastPointer || { x: window.innerWidth / 2, y: window.innerHeight / 3, rect: null };
    let left = p.rect ? (p.rect.left + r.width > window.innerWidth - 8 ? p.rect.right - r.width : p.rect.left) : p.x;
    let top = p.rect ? p.rect.bottom + 6 : p.y;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, (p.rect ? p.rect.top - 6 : p.y) - r.height);
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    (buttons.find((b) => !b.disabled) || menu).focus();
  });
}

async function copyText(text) {
  await navigator.clipboard.writeText(String(text ?? ""));
  return true;
}

/* ------------------------------------------------------------------ the bridge */

if (web) {
  W.quireApp = {
    platform: "web",
    popupAppMenu: () => Promise.resolve(null),
    getState: () => call("quire:getState"),
    listTree: () => call("quire:listTree"),
    readEntry: (path) => call("quire:readEntry", path),
    writeEntry: (path, content) => call("quire:writeEntry", path, content),
    listFiles: (path) => call("quire:listFiles", path),
    readFile: (path, file) => call("quire:readFile", path, file),
    openFileExternally: (path, file) => call("quire:openFileExternally", path, file),
    inspectDb: (path, file, opts) => call("quire:inspectDb", path, file, opts || {}),
    setRenderer: (path, renderer) => call("quire:setRenderer", path, renderer),
    publishStatus: (path) => call("quire:publishStatus", path),
    publish: (path, host) => call("quire:publish", path, host || null),
    unpublish: (path) => call("quire:unpublish", path),
    onPublishStatus: on("publish-status"),
    publishTargets: (path) => call("quire:publishTargets", path),
    publishingInfo: (fresh) => call("quire:publishingInfo", !!fresh),
    toolsInfo: () => call("quire:toolsInfo"),
    setToolMode: (id, mode) => call("quire:setToolMode", id, mode),
    setSelfHost: (on) => call("quire:setSelfHost", !!on),
    setDefaultHost: (host) => call("quire:setDefaultHost", host),
    hostingSignIn: () => call("quire:hostingSignIn"),
    hostingCancelSignIn: () => call("quire:hostingCancelSignIn"),
    hostingSignOut: () => call("quire:hostingSignOut"),
    onHostingChanged: on("hosting-changed"),
    billing: () => call("quire:billing"),
    billingCheckout: (item) => call("quire:billingCheckout", item),
    billingPortal: () => call("quire:billingPortal"),
    cloudflareLogin: () => call("quire:cloudflareLogin"),
    cloudflareCancelLogin: () => call("quire:cloudflareCancelLogin"),
    cloudflareLogout: () => call("quire:cloudflareLogout"),
    onCloudflareStatus: on("cloudflare-status"),
    buildPage: (path) => call("quire:buildPage", path),
    onBuildStatus: on("build-status"),
    writeFile: (path, file, content) => call("quire:writeFile", path, file, content),
    createPage: (path, opts) => call("quire:createPage", path, opts || {}),
    createFolder: (path) => call("quire:createFolder", path),
    listTemplates: () => call("quire:listTemplates"),
    createFromTemplate: (template, folder, name) => call("quire:createFromTemplate", template, folder || "", name || ""),
    saveAsTemplate: (path, name) => call("quire:saveAsTemplate", path, name || ""),
    restoreTemplates: () => call("quire:restoreTemplates"),
    revealTemplate: (path) => call("quire:revealTemplate", path || ""),
    trashTemplate: (path) => call("quire:trashTemplate", path),
    watchTemplates: (on) => call("quire:watchTemplates", !!on),
    onTemplatesChanged: on("templates-changed"),
    contextMenu,
    reveal: (path) => call("quire:reveal", path || ""),
    copyPath: (path) => call("quire:copyPath", path || ""),
    openInBrowser: (path) => call("quire:openInBrowser", path),
    trash: (path) => call("quire:trash", path),
    moveInto: (path, folder, place) => call("quire:moveInto", path, folder || "", place || null),
    convertToPage: (path) => call("quire:convertToPage", path),
    // Files dropped from the viewer's own disk can't reach the host: no path, no import.
    importDropped: () => Promise.reject(new Error("Drop files into the Noteblock app; the web editor can't read them.")),
    pathForFile: () => "",
    searchExclude: () => call("quire:searchExclude"),
    setSearchExcluded: (path, excluded) => call("quire:setSearchExcluded", path, excluded),
    folderPublishStatus: (path) => call("quire:folderPublishStatus", path),
    publishFolder: (path) => call("quire:publishFolder", path),
    unpublishFolder: (path) => call("quire:unpublishFolder", path),
    addTemplateFromUrl: (url, opts) => call("quire:addTemplateFromUrl", url, opts || {}),
    getPrefs: () => call("quire:getPrefs"),
    demoInfo: () => call("quire:demoInfo"),
    resetDemo: () => call("quire:resetDemo"),
    dictionaryWords: () => call("quire:dictionaryWords"),
    addDictionaryWord: (word) => call("quire:addDictionaryWord", word),
    removeDictionaryWord: (word) => call("quire:removeDictionaryWord", word),
    setPref: (key, value) => call("quire:setPref", key, value),
    getShortcuts: () => call("quire:getShortcuts"),
    setShortcut: (id, accelerator) => call("quire:setShortcut", id, accelerator),
    resetShortcuts: () => call("quire:resetShortcuts"),
    suspendShortcuts: (on) => call("quire:suspendShortcuts", !!on),
    getShortcutPriority: () => call("quire:getShortcutPriority"),
    setShortcutPriority: (value) => call("quire:setShortcutPriority", value),
    setShortcutPriorityOverride: (id, value) => call("quire:setShortcutPriorityOverride", id, value ?? null),
    // On the web every page shares one origin, so the caller also names the page:
    // args [origin, method, params, pagePath] (App.jsx works the page out from event.source).
    rpc: (origin, method, params, pagePath) => call("quire:rpc", origin, method, params || {}, typeof pagePath === "string" ? pagePath : null),
    openVault: () => call("quire:openVault"),
    vaultInfo: () => call("quire:vaultInfo"),
    renameVault: (name) => call("quire:renameVault", name),
    moveVault: () => call("quire:moveVault"),
    switchVault: (path) => call("quire:switchVault", path),
    createVault: () => call("quire:createVault"),
    forgetVault: (path) => call("quire:forgetVault", path),
    pickImportSource: () => call("quire:pickImportSource"),
    importObsidian: (opts) => call("quire:importObsidian", opts || {}),
    importArtifactFiles: (opts) => call("quire:importArtifactFiles", opts || {}),
    copyText,
    backendStatus: (path) => call("quire:backendStatus", path),
    backendStart: (path) => call("quire:backendStart", path),
    backendRestart: (path) => call("quire:backendRestart", path),
    backendStop: (path) => call("quire:backendStop", path),
    backendLog: (path, name) => call("quire:backendLog", path, name),
    onBackendStatus: on("backend-status"),
    activity: () => call("quire:activity"),
    setBackendPolicy: (policy) => call("quire:setBackendPolicy", policy || {}),
    stopAllBackends: () => call("quire:stopAllBackends"),
    revealBackendLog: (path, name) => call("quire:revealBackendLog", path, name),
    limits: () => call("quire:limits"),
    limitsSchema: () => call("quire:limitsSchema"),
    setLimits: (patch) => call("quire:setLimits", patch || {}),
    resetLimits: () => call("quire:resetLimits"),
    probePage: (src) => call("quire:probePage", src),
    inspectPage: (path) => call("quire:inspectPage", path),
    devtoolsOpenPages: (paths) => call("quire:devtoolsOpenPages", paths || []),
    killPageProcess: (src, opts) => call("quire:killPageProcess", src, opts || {}),
    syncInfo: () => call("quire:syncInfo"),
    setSyncRemote: (url) => call("quire:setSyncRemote", url),
    setSyncEnabled: (on) => call("quire:setSyncEnabled", !!on),
    setSyncEvery: (sec) => call("quire:setSyncEvery", Number(sec)),
    syncNow: () => call("quire:syncNow"),
    onSyncStatus: on("sync-status"),
    updateStatus: () => call("quire:updateStatus"),
    runUpdate: () => call("quire:runUpdate"),
    revealUpdateLog: () => call("quire:revealUpdateLog"),
    onUpdateStatus: on("update-status"),
    onTreeChanged: on("tree-changed"),
    onLocksChanged: on("locks-changed"),
    onPageFilesChanged: on("page-files-changed"),
    onMenu: on("menu"),
    onOpenPath: on("open-path"),
    ai: {
      status: () => call("quire:aiStatus"),
      start: (opts) => call("quire:aiStart", opts || {}),
      stop: (jobId) => call("quire:aiStop", jobId),
      answer: (jobId, askId, allow, always) => call("quire:aiAnswer", jobId, askId, !!allow, !!always),
      apply: (jobId) => call("quire:aiApply", jobId),
      undo: (jobId) => call("quire:aiUndo", jobId),
      jobs: () => call("quire:aiJobs"),
      chats: () => call("quire:aiChats"),
      chat: (id) => call("quire:aiChat", id),
      deleteChat: (id) => call("quire:aiDeleteChat", id),
      permissions: () => call("quire:aiPermissions"),
      setPermissions: (patch) => call("quire:aiSetPermissions", patch || {}),
    },
    onAiEvent: on("ai-event"),
    getFloating: () => call("quire:getFloating"),
    setFloating: (patch) => call("quire:setFloating", patch || {}),
    openFloating: () => call("quire:openFloating"),
    hideFloating: () => call("quire:hideFloating"),
    floatingPage: () => call("quire:floatingPage"),
    newFloatingNote: () => call("quire:newFloatingNote"),
    floatingPicking: (on) => call("quire:floatingPicking", !!on),
    onFloatingChanged: on("floating-changed"),
    onFloatingShown: on("floating-shown"),
  };
  document.documentElement.classList.add("is-web");
  if (isEmbed) document.documentElement.classList.add("is-embed");
}
