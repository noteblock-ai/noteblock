// Sandboxed preload: only `require("electron")` is available here.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && typeof res === "object" && "error" in res) throw new Error(res.error);
  return res ? res.ok : null;
}

function on(channel) {
  return (cb) => {
    const listener = (_event, ...args) => {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[quire] ${channel} handler failed`, err);
      }
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

// noteblock:// links (main.mjs openLink): a path can arrive before App.jsx subscribes (a cold
// start), so the last one waits here for the first listener.
let pendingOpenPath = null;
const openPathListeners = new Set();
ipcRenderer.on("open-path", (_event, path) => {
  if (!openPathListeners.size) pendingOpenPath = path;
  for (const cb of openPathListeners) {
    try {
      cb(path);
    } catch (err) {
      console.error("[quire] open-path handler failed", err);
    }
  }
});
function onOpenPath(cb) {
  openPathListeners.add(cb);
  if (pendingOpenPath !== null) {
    const path = pendingOpenPath;
    pendingOpenPath = null;
    try {
      cb(path);
    } catch (err) {
      console.error("[quire] open-path handler failed", err);
    }
  }
  return () => openPathListeners.delete(cb);
}

// The OS the UI is drawn for (darwin, win32…). QUIRE_FAKE_PLATFORM in main passes
// --quire-platform=<p> so the Windows layout can be checked on a Mac (hidden capture runs).
const fakePlatform = (process.argv.find((a) => a.startsWith("--quire-platform=")) || "").split("=")[1];

contextBridge.exposeInMainWorld("quireApp", {
  platform: fakePlatform || process.platform,
  // Windows: the app menu as a popup under the menu button (x, y in window coordinates).
  popupAppMenu: (x, y) => call("quire:popupAppMenu", Math.round(x || 0), Math.round(y || 0)),
  getState: () => call("quire:getState"),
  listTree: () => call("quire:listTree"),
  searchExclude: () => call("quire:searchExclude"),
  setSearchExcluded: (path, excluded) => call("quire:setSearchExcluded", path, excluded),
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
  folderPublishStatus: (path) => call("quire:folderPublishStatus", path),
  publishFolder: (path) => call("quire:publishFolder", path),
  unpublishFolder: (path) => call("quire:unpublishFolder", path),
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
  // Settings → Plan: GET /api/billing, and Stripe Checkout or the portal in the browser.
  billing: () => call("quire:billing"),
  billingCheckout: (item) => call("quire:billingCheckout", item),
  billingPortal: () => call("quire:billingPortal"),
  // Settings → Debug (dev and Next builds): mode "free" | "pro" | "credits" | null for real data.
  debugBilling: (mode) => call("quire:debugBilling", mode || null),
  debugPublishError: (path) => call("quire:debugPublishError", path),
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
  addTemplateFromUrl: (url, opts) => call("quire:addTemplateFromUrl", url, opts || {}),
  restoreTemplates: () => call("quire:restoreTemplates"),
  revealTemplate: (path) => call("quire:revealTemplate", path || ""),
  trashTemplate: (path) => call("quire:trashTemplate", path),
  watchTemplates: (on) => call("quire:watchTemplates", !!on),
  onTemplatesChanged: on("templates-changed"),
  contextMenu: (items) => call("quire:contextMenu", items),
  reveal: (path) => call("quire:reveal", path || ""),
  copyPath: (path) => call("quire:copyPath", path || ""),
  openInBrowser: (path) => call("quire:openInBrowser", path),
  trash: (path) => call("quire:trash", path),
  moveInto: (path, folder, place) => call("quire:moveInto", path, folder || "", place || null),
  rename: (path, name) => call("quire:rename", path, name),
  convertToPage: (path) => call("quire:convertToPage", path),
  importDropped: (sources, folder) => call("quire:importDropped", sources, folder || ""),
  // A sandboxed renderer's File has no .path. "" for anything not on disk.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  getPrefs: () => call("quire:getPrefs"),
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
  // origin: the calling frame's MessageEvent.origin; main works out the page from it.
  rpc: (origin, method, params) => call("quire:rpc", origin, method, params || {}),
  openVault: () => call("quire:openVault"),
  // Vault trust (app/main/trust.mjs): "trusted" | "restricted"; the new-command prompt.
  setVaultTrust: (state) => call("quire:setVaultTrust", state === "trusted" ? "trusted" : "restricted"),
  trustPending: () => call("quire:trustPending"),
  answerCommands: (path, run) => call("quire:answerCommands", path, !!run),
  onTrustChanged: on("trust-changed"),
  onTrustRequest: on("trust-request"),
  onTrustAnswered: on("trust-answered"),
  vaultInfo: () => call("quire:vaultInfo"),
  renameVault: (name) => call("quire:renameVault", name),
  moveVault: () => call("quire:moveVault"),
  switchVault: (path) => call("quire:switchVault", path),
  createVault: () => call("quire:createVault"),
  forgetVault: (path) => call("quire:forgetVault", path),
  pickImportSource: () => call("quire:pickImportSource"),
  importObsidian: (opts) => call("quire:importObsidian", opts || {}),
  importArtifactFiles: (opts) => call("quire:importArtifactFiles", opts || {}),
  copyText: (text) => call("quire:copyText", text),
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
  onOpenPath,
  // Noteblock AI (app/main/ai.mjs, docs/ai.md).
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
  // Floating note (Settings → Floating note, and the note window itself).
  getFloating: () => call("quire:getFloating"),
  setFloating: (patch) => call("quire:setFloating", patch || {}),
  openFloating: () => call("quire:openFloating"),
  hideFloating: () => call("quire:hideFloating"),
  floatingPage: () => call("quire:floatingPage"),
  newFloatingNote: () => call("quire:newFloatingNote"),
  floatingPicking: (on) => call("quire:floatingPicking", !!on),
  onFloatingChanged: on("floating-changed"),
  onFloatingShown: on("floating-shown"),
});
