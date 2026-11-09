// ipcMain handlers behind window.quireApp (see preload.cjs). Every handler answers with an
// envelope {ok: result} or {error: message}; the preload unwraps it so the renderer (and the
// page, via rpc) sees the plain error message rather than Electron's "Error invoking…" prefix.
import fs from "node:fs";
import path from "node:path";
import {
  listTree,
  readSearchExclude,
  setSearchExcluded,
  dropSearchExclude,
  findPage,
  readEntry,
  writeEntry,
  createPage,
  createFolder,
  createVault,
  loadConfig,
  saveConfig,
  vaultName,
  currentUser,
  openStore,
  getLock,
  snapshotDir,
  applyRegions,
  htmlToMarkdown,
  splitFrontmatter,
  renderMarkdown,
  commitAll,
  listLocks,
  pathDir,
  isPageDir,
  listPageFiles,
  readPageFile,
  writePageFile,
  pageFilePath,
  renameVault,
  moveVault,
  inspectDb,
  editFile,
  isBuildOutput,
  buildInfo,
  readManifest,
  writeManifest,
  RENDERERS,
  scanObsidian,
  importObsidian,
  importArtifactFiles,
  listTemplates,
  templatesDir,
  templatePath,
  seedTemplates,
  createFromTemplate,
  saveAsTemplate,
  addTemplateFromUrl,
  checkMove,
  movePath,
  rewriteLinksForMove,
  pagesUnder,
  normPath,
  commitPaths,
  dropMoveTarget,
  listFolder,
  writeOrder,
  placeName,
  renameInOrder,
  ORDER_FILE,
  isPlainFile,
  moveFile,
  renameTarget,
  renameHeader,
  convertFileToPage,
  importDropped,
  isManifestName,
  isMetaDirName,
  isVaultDir,
  manifestFile,
} from "../../core/index.mjs";
import { scheduleAutosave, flushAutosaves } from "./autosave.mjs";
import { markSelfWrite } from "./watcher.mjs";
import { shortcutList, setShortcut, resetShortcuts, shortcutPriority, setShortcutPriority, setShortcutPriorityOverride } from "./shortcuts.mjs";
import { suspendShortcutPriority } from "./keys.mjs";
import { scheduleBuild, buildEnv } from "./builds.mjs";
import { toolsInfo, setToolMode } from "./tools.mjs";
import { publishPage, unpublishPage, publishStatusAsync, publicRecord, HOSTS, publishFolder, unpublishFolder, folderPublishStatus, moveFolderRecords } from "./publish.mjs";
import {
  account as hostingAccount,
  signIn as hostingSignIn,
  cancelSignIn as hostingCancelSignIn,
  signOut as hostingSignOut,
  siteHost,
  billing as hostingBilling,
  checkout as hostingCheckout,
  portal as hostingPortal,
} from "./hosting.mjs";
import { setBillingFake } from "./billing-debug.mjs";
import { cloudflareAccount, cloudflareLogin, cloudflareLoginRunning, cancelCloudflareLogin, cloudflareLogout } from "./cloudflare.mjs";
import { syncInfo, setRemote, setEnabled, setSyncEvery, syncNow, moveSyncSetting } from "./sync.mjs";
import { backendStatus, ensureBackend, restartBackend, stopBackend, backendLog, proxyPort, stopAllBackends, setBackendPolicy, applyBackendLimits, backendLogPath } from "./backend.mjs";
import { activitySnapshot } from "./activity.mjs";
import { limits, limitsSchema, setLimits, resetLimits } from "./limits.mjs";
import { getBrowserServer } from "./browser-server.mjs";
import { updateStatus, runUpdate } from "./updater.mjs";
import { editorPrefs, editorCss } from "./protocol.mjs";
import { createAi, isApplying } from "./ai.mjs";
// page-health.mjs needs Electron; loaded on first use so runRpc can be tested under plain node.
const health = () => import("./page-health.mjs");
import { idOfOrigin, pageForOrigin, embedsIn, readablePageFile } from "./origins.mjs";
import { BRAND } from "../../core/brand.mjs";
import { isTrusted, vaultTrust, setVaultTrust, moveTrust, approveCommands, answerCommands, askAgain, pendingRequests, commandGate, TRUSTED, RESTRICTED } from "./trust.mjs";

/** App preferences, as the renderer sees them. */
function prefsOf(cfg) {
  return { confirmDelete: cfg.confirmDelete !== false, editor: editorPrefs(cfg.editor) };
}

/** The app preferences now (Settings, and Noteblock AI's get_settings). */
export function appPrefs() {
  return prefsOf(loadConfig());
}

/**
 * Set one app preference: confirmDelete, or editor.textSize|readableWidth|font|spellcheck|
 * defaultRenderer, pushed into the open page frames at once. Used by quire:setPref and by
 * Noteblock AI's change_setting. Returns the preferences.
 * @param {{getWindow: () => import("electron").BrowserWindow | null}} ctx
 */
export function setAppPref(ctx, key, value) {
  const cfg = loadConfig();
  if (key === "confirmDelete") {
    saveConfig({ ...cfg, confirmDelete: !!value });
  } else if (/^editor\.(textSize|readableWidth|font|spellcheck|defaultRenderer)$/.test(String(key))) {
    const editor = editorPrefs({ ...editorPrefs(cfg.editor), [key.slice(7)]: value });
    saveConfig({ ...cfg, editor });
    applyEditorPrefs(ctx.getWindow(), editor);
  } else {
    throw new Error(`Unknown setting: ${key}`);
  }
  return prefsOf(loadConfig());
}

/**
 * Set one shortcut ("" clears it) and rebuild the menu with it. Used by quire:setShortcut and
 * by Noteblock AI's change_setting. Returns the shortcut list.
 * @param {{rebuildMenu: (opts?: object) => void}} ctx
 */
export function setAppShortcut(ctx, id, accelerator) {
  setShortcut(id, accelerator);
  ctx.rebuildMenu();
  return shortcutList();
}

/** Push the editor settings into every open page frame (embeds too), without a reload. */
function applyEditorPrefs(win, editor) {
  if (!win || win.isDestroyed()) return;
  const js = `(function(){var d=document,s=d.getElementById("q-editor-prefs"),m=d.querySelector('meta[name="quire-spellcheck"]');` +
    `if(s)s.textContent=${JSON.stringify(editorCss(editor))};if(m)m.setAttribute("content",${JSON.stringify(editor.spellcheck ? "on" : "off")});` +
    `d.querySelectorAll('[contenteditable="true"]').forEach(function(e){e.spellcheck=${editor.spellcheck ? "true" : "false"};});})()`;
  for (const frame of win.webContents.mainFrame.framesInSubtree) {
    if (!/^quire:\/\/(vault|p-[a-z0-9]+)\//.test(String(frame.url || ""))) continue;
    frame.executeJavaScript(js).catch(() => {});
  }
}

/** Pages being published or unpublished right now. */
const publishing = new Set();

/** Set by registerIpc: tells the renderer how a page build is going. */
let notifyBuild = () => {};

/** Rebuild a built page soon; reload when its code (not just its prose) changed. */
function rebuild(vault, node, reload) {
  if (node.build) scheduleBuild(vault, node.path, { reload, notify: notifyBuild });
}

/** Page-runtime methods that change a page (another open window reloads it). */
const RPC_WRITES = new Set(["save", "store.insert", "store.update", "store.remove", "kv.set", "embed.setHeight"]);

export const READ_ONLY_MSG = "Page is read-only while it is being edited";

/** Drop `dir` from every node. */
export function publicTree(nodes) {
  return nodes.map(({ dir, children, ...rest }) => ({ ...rest, children: publicTree(children || []) }));
}

function publicNode(node) {
  return publicTree([node])[0];
}

function lockOf(vault, node) {
  return node.lock || (node.id ? getLock(vault, node.id) : null);
}

function assertWritable(vault, node) {
  if (lockOf(vault, node)) throw new Error(READ_ONLY_MSG);
}

/** The pages a page embeds (`<quire-embed src>` in its entry, or in its source for a built page). */
function pageEmbeds(node) {
  const out = new Set();
  for (const file of new Set([node.entry, editFile(node)])) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(node.dir, file), "utf8");
    } catch {
      continue;
    }
    if (/\.md$/i.test(file)) text = renderMarkdown(text, { title: node.title });
    for (const p of embedsIn(text, node.path)) out.add(p);
  }
  return [...out];
}

const FILE_READ_MAX = 10 * 1024 * 1024;

/** files.read: one file of another (or this) page, read-only, as text. */
function readFileOf(vault, target, rel) {
  const clean = readablePageFile(rel, target.backend ? target.backend.dir : null);
  if (isManifestName(clean)) throw new Error(`files.read: not allowed: ${rel}`);
  const lock = lockOf(vault, target);
  const base = lock && target.id ? snapshotDir(vault, target.id) : target.dir;
  const file = path.join(base, ...clean.split("/"));
  if (!file.startsWith(base + path.sep)) throw new Error(`files.read: not allowed: ${rel}`);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`files.read: no file ${clean} in ${target.path}`);
  }
  if (!st.isFile()) throw new Error(`files.read: ${clean} in ${target.path} isn't a file`);
  if (st.size > FILE_READ_MAX) throw new Error(`files.read: ${clean} is over 10 MB`);
  return fs.readFileSync(file, "utf8");
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const IMAGE_MAX = 25 * 1024 * 1024;

/**
 * files.addImage: `data` (base64 or a data: URL) written to `<page>/images/<name>`, the name
 * made safe and unique. Returns the src for the page's entry ("images/x.png"). SVG is refused
 * (it can carry script); built pages too, since their entry is build output.
 */
function addPageImage(node, name, data) {
  if (node.build) throw new Error("Images can't be dropped on a built page yet: add them to its source");
  const raw = String(name || "image.png").split(/[\\/]/).pop();
  const dot = raw.lastIndexOf(".");
  const ext = (dot > 0 ? raw.slice(dot + 1) : "").toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw new Error(ext === "heic" ? "HEIC images don't show in Noteblock: export as JPEG first" : `Not an image Noteblock can show: ${raw}`);
  const base = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^\w.\- ]+/g, "-").replace(/^[.\s-]+/, "").trim().slice(0, 80) || "image";
  const b64 = String(data || "").replace(/^data:[^,]*,/, "");
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length) throw new Error("The image was empty");
  if (bytes.length > IMAGE_MAX) throw new Error("Images over 25 MB can't be added");
  const dir = path.join(node.dir, "images");
  fs.mkdirSync(dir, { recursive: true });
  let file = `${base}.${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `${base} ${i}.${ext}`;
  const abs = path.join(dir, file);
  markSelfWrite(abs);
  fs.writeFileSync(abs, bytes);
  const entryDir = path.dirname(path.join(node.dir, node.entry));
  return path.relative(entryDir, abs).split(path.sep).map(encodeURIComponent).join("/");
}

/**
 * Run one page-runtime RPC in main.
 * @param {string} vault
 * @param {string} pagePath  the calling page, as main or the renderer worked it out (from the
 *   frame's origin in the app, the URL path in the browser server). `params.from`, which the
 *   page sets itself, is ignored: a page can only touch its own store, kv and text.
 * @param {string} method
 * @param {any} params
 */
export function runRpc(vault, pagePath, method, params = {}) {
  params = params || {};
  const from = pagePath;
  const user = currentUser();
  const self = () => findPage(vault, from);
  // Restricted mode (trust.mjs): a page reaches only itself. Read lazily, so methods that only
  // touch the caller don't read trust.json.
  const other = (ref) => {
    const target = findPage(vault, ref);
    if (target.path !== from && !isTrusted(vault)) throw new Error(`${method}: pages only reach themselves in restricted mode`);
    return target;
  };

  switch (method) {
    case "store.all":
      return openStore(self().dir, user).all(params.table);
    case "store.get":
      return openStore(self().dir, user).get(params.table, params.id);
    case "store.insert":
    case "store.update":
    case "store.remove": {
      const node = self();
      assertWritable(vault, node);
      const store = openStore(node.dir, user);
      let result;
      if (method === "store.insert") result = store.insert(params.table, params.obj || {});
      else if (method === "store.update") result = store.update(params.table, params.id, params.patch || {});
      else result = store.remove(params.table, params.id);
      scheduleAutosave(vault, null);
      return result;
    }
    case "kv.get":
      return openStore(self().dir, user).kvGet(params.key);
    case "kv.set": {
      const node = self();
      assertWritable(vault, node);
      const result = openStore(node.dir, user).kvSet(params.key, params.value);
      scheduleAutosave(vault, null);
      return result;
    }
    case "query": {
      const target = other(params.page);
      return openStore(target.dir, user).all(params.table);
    }
    case "pages":
      return publicTree(listTree(vault));
    case "navigate":
      return null; // the renderer handles navigation
    case "save":
      return save(vault, self(), params);
    case "files.read": {
      const target = params.page == null || params.page === "" ? self() : other(params.page);
      return readFileOf(vault, target, params.path);
    }
    case "files.addImage": {
      // An image dropped on the page in the editor: copied into the page's images/ folder.
      const node = self();
      assertWritable(vault, node);
      return addPageImage(node, params.name, params.data);
    }
    case "storage.migrated":
      return null; // handled by the "quire:rpc" handler (it needs the frame's page id)
    case "embed.setHeight": {
      // Dragging an embed's edge writes the embedded page's manifest: only from a page that embeds it.
      const target = other(params.page);
      if (target.path !== from && !pageEmbeds(self()).includes(target.path)) throw new Error(`embed.setHeight: ${from} doesn't embed ${target.path}`);
      return setEmbedHeight(vault, target, params.height);
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

/** How tall a page is wherever it's embedded: `embed.height` in its manifest (0/null = auto). */
function setEmbedHeight(vault, node, height) {
  assertWritable(vault, node);
  const m = readManifest(node.dir) || {};
  const h = Math.round(Number(height) || 0);
  if (h > 0) m.embed = { ...(m.embed || {}), height: h };
  else if (m.embed) {
    delete m.embed.height;
    if (!Object.keys(m.embed).length) delete m.embed;
  }
  writeManifest(node.dir, m);
  scheduleAutosave(vault, node.path);
  return { height: h > 0 ? h : null };
}

/** Thrown for a page frame's save that would land over a Noteblock AI apply (ai.mjs isApplying). */
export const AI_RELOADING_MSG = `Page is reloading after a ${BRAND.name} AI change`;

function save(vault, node, params) {
  assertWritable(vault, node);
  if (isApplying(vault, node.path)) throw new Error(AI_RELOADING_MSG);
  if (node.format === "md" || params.markdownBody != null) {
    if (params.markdownBody == null) throw new Error("save: markdownBody is required for a markdown page");
    const file = path.join(node.dir, node.entry);
    // The editor never sees frontmatter (it isn't rendered), so carry it over from the file.
    let front = "";
    try {
      front = splitFrontmatter(fs.readFileSync(file, "utf8")).frontmatter;
    } catch {}
    const md = front + htmlToMarkdown(params.markdownBody);
    markSelfWrite(file);
    fs.writeFileSync(file, md);
    scheduleAutosave(vault, node.path);
    return { ok: true };
  }
  const regions = Array.isArray(params.regions) ? params.regions : [];
  // A built page's prose lives in its source template; its entry is build output.
  const target = editFile(node);
  const file = path.join(node.dir, target);
  // Always the RAW live file, never the snapshot and never the served (indexed) copy.
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const next = applyRegions(raw, regions);
  if (next !== raw) {
    markSelfWrite(file);
    fs.writeFileSync(file, next);
    scheduleAutosave(vault, node.path);
    if (target !== node.entry) {
      // Patch the built copy too, so the edit is there before the rebuild lands. The build
      // keeps body markup in place, so the same element numbers line up.
      const out = path.join(node.dir, node.entry);
      try {
        const built = fs.readFileSync(out, "utf8");
        markSelfWrite(out);
        fs.writeFileSync(out, applyRegions(built, regions));
      } catch {}
    }
    rebuild(vault, node, false);
  }
  return { ok: true };
}

/**
 * Move a page, folder or file (vault-relative path) to the Trash and commit the removal.
 * Finder's "Put Back" undoes it, and git keeps the history. Never the vault's own .noteblock
 * (or .quire) or .git, a page's manifest, or anything in a page an agent is editing. Used by
 * quire:trash and by Noteblock AI's trash_page (ai.mjs), which passes commit: false and puts
 * the removal in its own commit.
 * @param {{getVault: () => string, shell: {trashItem: (p: string) => Promise<void>}}} ctx
 */
export async function trashPath(ctx, relPath, { commit = true } = {}) {
  const vault = ctx.getVault();
  const segs = String(relPath || "").split("/").filter(Boolean);
  if (!segs.length || segs.some((s) => s === "." || s === "..")) throw new Error("Nothing to delete");
  if (isMetaDirName(segs[0]) || segs[0] === ".git" || isManifestName(segs[segs.length - 1])) throw new Error("That one can't be deleted");
  const abs = path.join(vault, ...segs);
  if (!fs.existsSync(abs)) throw new Error(`Not found: ${segs.join("/")}`);
  // Inside (or being) a page: refuse while Claude edits it.
  let dir = vault;
  for (const s of segs) {
    dir = path.join(dir, s);
    if (isPageDir(dir)) {
      const id = (readManifest(dir) || {}).id;
      if (id && getLock(vault, id)) throw new Error(READ_ONLY_MSG);
      break;
    }
  }
  // A folder holding a page Claude is editing goes too, so check below it as well.
  if (fs.statSync(abs).isDirectory()) {
    for (const lock of listLocks(vault)) {
      const p = lock.path || "";
      if (p === segs.join("/") || p.startsWith(segs.join("/") + "/")) throw new Error(READ_ONLY_MSG);
    }
  }
  flushAutosaves();
  await ctx.shell.trashItem(abs);
  dropSearchExclude(vault, segs.join("/"));
  if (commit) {
    try {
      commitAll(vault, `Delete ${segs.join("/")}`);
    } catch {}
  }
  return null;
}

/** True when `a` and `b` are two spellings of one entry on disk (a case-insensitive filesystem). */
function sameFile(vault, a, b) {
  if (a === b || a.toLowerCase() !== b.toLowerCase()) return false;
  try {
    return fs.statSync(pathDir(vault, a)).ino === fs.statSync(pathDir(vault, b)).ino;
  } catch {
    return false;
  }
}

/**
 * Move or rename a page or folder (core/move.mjs), the app's way: the person's pending edits
 * committed first, the backends of the pages being moved stopped (they start again from the
 * new path on next use), their store handles closed. Used by Noteblock AI's move_page.
 * @param {{getVault: () => string}} ctx
 * Links that reached the old path are fixed (core/relink.mjs): commit `relinked` with the move.
 * @returns {Promise<{from: string, to: string, kind: "page" | "folder", relinked: string[], skipped: string[]}>}
 */
export async function movePagePath(ctx, from, to) {
  const vault = ctx.getVault();
  const m = checkMove(vault, from, to);
  flushAutosaves();
  for (const node of pagesUnder(vault, m.from)) if (node.id) await stopBackend(node.id);
  const moved = movePath(vault, m.from, m.to);
  // The move has happened by now: a link that can't be fixed must not fail it.
  let links = { relinked: [], skipped: [] };
  try {
    links = await rewriteLinksForMove(vault, moved.from, moved.to);
  } catch (err) {
    console.error("[noteblock] relink failed:", err.message);
  }
  if (moveFolderRecords(vault, m.from, m.to) || moved.settingsChanged || links.relinked.length) scheduleAutosave(vault);
  return { ...moved, ...links };
}

// Job states that still write to their page (ai.mjs).
const AI_BUSY = new Set(["running", "asking", "ready", "applying"]);

function isVault(dir) {
  return isVaultDir(dir);
}

/** Make dir the current vault in the config (and remember it). */
export function rememberVault(dir) {
  const cfg = loadConfig();
  const vaults = [...new Set([...(cfg.vaults || []), dir])];
  saveConfig({ ...cfg, current: dir, vaults });
}

/**
 * @param {import("electron").IpcMain} ipcMain
 * @param {{dialog: import("electron").Dialog, getVault: () => string, setVault: (dir: string) => void,
 *          getWindow: () => import("electron").BrowserWindow | null}} ctx
 */
export function registerIpc(ipcMain, ctx) {
  if (ctx.notifyBuild) notifyBuild = ctx.notifyBuild;
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        const ok = await fn(...args);
        return { ok: ok === undefined ? null : ok };
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    });
  };
  // Same, with the calling webContents first (to tell the main window from the floating note).
  const handleFrom = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const ok = await fn(event && event.sender, ...args);
        return { ok: ok === undefined ? null : ok };
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    });
  };
  /** Publishing runs a page's build: refuse in restricted mode, or ask about a new command first. */
  const gatePublish = (vault, nodes) => {
    for (const node of nodes) {
      if (!node.build) continue;
      const gate = commandGate(vault, node);
      if (!gate.ok) throw new Error(gate.reason === "restricted" ? "Restricted mode. Trust this vault to publish a page that builds." : `${gate.message} (${node.path})`);
    }
  };

  /** A window wrote to a page: the other window (main / floating note) reloads it. */
  const written = (pagePath, sender) => {
    if (ctx.onPageWritten && pagePath) ctx.onPageWritten(pagePath, sender);
  };

  handle("quire:getState", () => {
    const vault = ctx.getVault();
    // `debug`: Settings shows its Debug section (dev and Next builds only, never a release).
    return { vault, vaultName: vaultName(vault), user: currentUser(), dev: ctx.dev || null, debug: !!(ctx.dev || ctx.next), trust: vaultTrust(vault) };
  });

  // Vault trust (trust.mjs, docs/contract.md "Trust"). setVaultTrust answers the trust prompt
  // and Settings › Vault; every window hears trust-changed and reloads its page.
  handle("quire:setVaultTrust", async (state) => {
    const vault = ctx.getVault();
    const next = setVaultTrust(vault, state === TRUSTED ? TRUSTED : RESTRICTED);
    if (next !== TRUSTED) await stopAllBackends();
    if (ctx.broadcast) ctx.broadcast("trust-changed", { vault, trust: next });
    return next;
  });
  handle("quire:trustPending", () => pendingRequests(ctx.getVault()));
  // A new command's prompt answered: Run approves it and starts what it was for.
  handle("quire:answerCommands", async (pagePath, run) => {
    const vault = ctx.getVault();
    const node = answerCommands(vault, String(pagePath || ""), !!run);
    if (ctx.broadcast) ctx.broadcast("trust-answered", { page: String(pagePath || "") });
    if (!node) return null;
    if (node.backend) await ensureBackend(vault, node.path);
    if (node.build) rebuild(vault, node, true);
    return null;
  });

  // Page backends (backend.mjs): status, start, restart, stop, log.
  handle("quire:backendStatus", (pagePath) => backendStatus(ctx.getVault(), pagePath));
  // Start from the Backend panel: a command declined earlier is asked about again.
  handle("quire:backendStart", (pagePath) => {
    askAgain(ctx.getVault(), pagePath);
    return ensureBackend(ctx.getVault(), pagePath);
  });
  handle("quire:backendRestart", (pagePath) => restartBackend(ctx.getVault(), pagePath));
  handle("quire:backendStop", async (pagePath) => {
    const node = findPage(ctx.getVault(), pagePath);
    if (node.id) await stopBackend(node.id);
    return backendStatus(ctx.getVault(), pagePath);
  });
  handle("quire:backendLog", (pagePath, name) => backendLog(ctx.getVault(), pagePath, String(name)));

  // Page recovery (page-health.mjs): the renderer's heartbeat stopped hearing from a page frame.
  handleFrom("quire:probePage", async (sender, src) => (await health()).probePage(sender, String(src || "")));
  // Inspect page (page-devtools.mjs): a DevTools window for one page shown in the sending
  // window. devtoolsOpenPages: the sending window's open tabs, so inspectors of pages no tab
  // shows any more close.
  handleFrom("quire:inspectPage", async (sender, pagePath) => {
    if (!ctx.devtools) throw new Error("Inspect page isn't available");
    await ctx.devtools.inspect(sender, { path: String(pagePath || "") });
    return null;
  });
  handleFrom("quire:devtoolsOpenPages", (sender, paths) => {
    if (ctx.devtools) ctx.devtools.openPages(sender, Array.isArray(paths) ? paths.filter((p) => typeof p === "string") : []);
    return null;
  });
  handleFrom("quire:killPageProcess", async (sender, src, opts) => (await health()).killPageProcess(sender, String(src || ""), { keep: opts && typeof opts.keep === "string" ? opts.keep : null }));

  // Settings → Activity & limits (activity.mjs): memory/CPU of Quire and every page backend, and the
  // idle / max-running limits, which apply as soon as they're saved.
  handle("quire:activity", async () => activitySnapshot(ctx.getVault(), { pageProcesses: (await health()).pageProcesses }));
  // Every page and backend limit (limits.mjs), for Settings → Activity & limits. Setting one
  // applies the backend ones at once (idle stop, cap, the watchdog's next check).
  handle("quire:limits", () => limits());
  handle("quire:limitsSchema", () => limitsSchema());
  handle("quire:setLimits", async (patch) => {
    const out = setLimits(patch || {});
    await applyBackendLimits();
    return out;
  });
  handle("quire:resetLimits", async () => {
    const out = resetLimits();
    await applyBackendLimits();
    return out;
  });
  handle("quire:setBackendPolicy", async (policy) => {
    await setBackendPolicy(policy);
    return activitySnapshot(ctx.getVault());
  });
  handle("quire:stopAllBackends", async () => {
    await stopAllBackends();
    return activitySnapshot(ctx.getVault());
  });
  handle("quire:revealBackendLog", (pagePath, name) => {
    const node = findPage(ctx.getVault(), pagePath);
    if (!node.id) return null;
    const file = backendLogPath(node.id, String(name));
    if (fs.existsSync(file)) ctx.shell.showItemInFolder(file);
    return null;
  });

  // Settings → Tools: the git, Node and pnpm Quire runs, and "Use the one on this Mac".
  handle("quire:toolsInfo", () => toolsInfo());
  handle("quire:setToolMode", (id, mode) => setToolMode(String(id), String(mode)));

  handle("quire:syncInfo", () => syncInfo(ctx.getVault()));
  handle("quire:setSyncRemote", (url) => setRemote(ctx.getVault(), url));
  handle("quire:setSyncEnabled", (on) => setEnabled(ctx.getVault(), !!on));
  handle("quire:setSyncEvery", (sec) => setSyncEvery(ctx.getVault(), sec));
  handle("quire:syncNow", async () => {
    await syncNow(ctx.getVault());
    return syncInfo(ctx.getVault());
  });

  /** Settings → Import: pick an Obsidian vault folder and say what's in it. */
  handle("quire:pickImportSource", async () => {
    const win = ctx.getWindow();
    const opts = { title: "Choose your Obsidian vault", buttonLabel: "Choose", properties: ["openDirectory"] };
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    return scanObsidian(res.filePaths[0]);
  });
  handle("quire:importObsidian", (opts = {}) => {
    const vault = ctx.getVault();
    const src = path.resolve(String(opts.source || ""));
    const inside = (a, b) => a === b || a.startsWith(b + path.sep);
    if (inside(src, path.resolve(vault)) || inside(path.resolve(vault), src)) throw new Error(`Pick a folder outside this ${BRAND.name} vault`);
    flushAutosaves();
    return importObsidian(vault, { source: opts.source, dest: opts.dest || "", format: opts.format === "html" ? "html" : "md" });
  });

  /** Settings → Import → Claude artifacts: pick downloaded files (or a folder) and import them. */
  handle("quire:importArtifactFiles", async (opts = {}) => {
    const win = ctx.getWindow();
    const dlg = {
      title: "Choose HTML or markdown files",
      buttonLabel: "Import",
      properties: ["openFile", "openDirectory", "multiSelections"],
      filters: [{ name: "HTML or markdown", extensions: ["html", "htm", "md"] }],
    };
    const res = win ? await ctx.dialog.showOpenDialog(win, dlg) : await ctx.dialog.showOpenDialog(dlg);
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    const vault = ctx.getVault();
    const inside = (a, b) => a === b || a.startsWith(b + path.sep);
    if (res.filePaths.some((p) => inside(path.resolve(p), path.resolve(vault)))) throw new Error(`Pick files outside this ${BRAND.name} vault`);
    flushAutosaves();
    return importArtifactFiles(vault, { sources: res.filePaths, folder: String(opts.folder || "") });
  });
  handle("quire:copyText", async (text) => {
    const clipboard = ctx.clipboard || (await import("electron")).clipboard;
    clipboard.writeText(String(text || ""));
    return true;
  });

  handle("quire:updateStatus", () => updateStatus());
  handle("quire:runUpdate", () => runUpdate());
  handle("quire:revealUpdateLog", () => {
    const log = updateStatus().log;
    if (log) ctx.shell.showItemInFolder(log);
    return null;
  });

  handle("quire:listTree", () => publicTree(listTree(ctx.getVault())));
  handle("quire:searchExclude", () => readSearchExclude(ctx.getVault()));
  // Written outside the self-write list on purpose: the watcher's tree-changed updates every window.
  handle("quire:setSearchExcluded", (relPath, excluded) => {
    const vault = ctx.getVault();
    const list = setSearchExcluded(vault, relPath, !!excluded);
    scheduleAutosave(vault, null);
    return list;
  });

  handle("quire:readEntry", (pagePath) => {
    const vault = ctx.getVault();
    const node = findPage(vault, pagePath);
    const lock = lockOf(vault, node);
    if (lock) {
      // Locked: show what the page looked like when the edit began (same as the iframe).
      const file = editFile(node);
      const full = path.join(snapshotDir(vault, lock.id), file);
      if (fs.existsSync(full)) {
        return { file, format: /\.md$/i.test(file) ? "md" : "html", content: fs.readFileSync(full, "utf8"), path: node.path };
      }
    }
    return readEntry(vault, pagePath);
  });

  handleFrom("quire:writeEntry", (sender, pagePath, content) => {
    const vault = ctx.getVault();
    const node = findPage(vault, pagePath);
    assertWritable(vault, node);
    markSelfWrite(path.join(node.dir, editFile(node)));
    writeEntry(vault, node.path, String(content ?? ""));
    scheduleAutosave(vault, node.path);
    rebuild(vault, node, true);
    written(node.path, sender);
    return null;
  });

  // A page's own files, for the sidebar's source view. While locked, the snapshot (data/
  // isn't snapshotted, so it comes from the live folder).
  const filesDir = (vault, node, rel = "") => {
    const lock = lockOf(vault, node);
    if (lock && rel.split("/")[0] !== "data") return snapshotDir(vault, lock.id);
    return node.dir;
  };

  handle("quire:listFiles", (pagePath) => {
    const vault = ctx.getVault();
    const node = findPage(vault, pagePath);
    if (!lockOf(vault, node)) return listPageFiles(node.dir);
    const data = listPageFiles(node.dir).filter((f) => f.path === "data");
    return [...data, ...listPageFiles(filesDir(vault, node))];
  });

  // `pagePath` is a page, or for a plain file sitting in a folder, that folder ("" = top).
  const pageOrNull = (vault, ref) => {
    try {
      return findPage(vault, ref);
    } catch {
      return null;
    }
  };
  const looseDir = (vault, ref, rel) => {
    if (String(rel).includes("/")) throw new Error(`Bad file: ${rel}`);
    const dir = ref ? pathDir(vault, ref) : vault;
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || isPageDir(dir)) throw new Error(`No page: ${ref}`);
    return dir;
  };

  handle("quire:readFile", (pagePath, rel) => {
    const vault = ctx.getVault();
    const node = pageOrNull(vault, pagePath);
    if (!node) return readPageFile(looseDir(vault, pagePath, rel), String(rel));
    return readPageFile(filesDir(vault, node, String(rel)), String(rel));
  });

  handle("quire:inspectDb", (pagePath, rel, opts) => {
    const vault = ctx.getVault();
    const node = pageOrNull(vault, pagePath);
    const r = String(rel);
    if (!node) return inspectDb(pageFilePath(looseDir(vault, pagePath, r), r), opts || {});
    return inspectDb(pageFilePath(filesDir(vault, node, r), r), opts || {});
  });

  handle("quire:openFileExternally", (pagePath, rel) => {
    const vault = ctx.getVault();
    const node = pageOrNull(vault, pagePath);
    const r = String(rel);
    return ctx.shell.openPath(pageFilePath(node ? node.dir : looseDir(vault, pagePath, r), r)).then((err) => {
      if (err) throw new Error(err);
      return null;
    });
  });

  handleFrom("quire:writeFile", (sender, pagePath, rel, content) => {
    const vault = ctx.getVault();
    const loose = pageOrNull(vault, pagePath) ? null : looseDir(vault, pagePath, rel);
    if (loose) {
      markSelfWrite(pageFilePath(loose, String(rel)));
      writePageFile(loose, String(rel), String(content ?? ""));
      scheduleAutosave(vault, null);
      return null;
    }
    const node = findPage(vault, pagePath);
    assertWritable(vault, node);
    markSelfWrite(pageFilePath(node.dir, String(rel)));
    writePageFile(node.dir, String(rel), String(content ?? ""));
    scheduleAutosave(vault, node.path);
    // The manifest may have just gained (or changed) its build command: re-read it. Commands the
    // person typed into the manifest here are theirs, so they're approved (trust.mjs).
    const fresh = findPage(vault, node.path);
    if (isManifestName(String(rel))) approveCommands(vault, fresh);
    if (fresh.build && !isBuildOutput(buildInfo(fresh.dir), String(rel))) rebuild(vault, fresh, true);
    written(node.path, sender);
    return null;
  });

  // The page's default renderer, kept in its manifest ("quire" is the default and isn't written).
  handle("quire:setRenderer", (pagePath, renderer) => {
    const vault = ctx.getVault();
    const node = findPage(vault, pagePath);
    if (!RENDERERS.includes(renderer)) throw new Error(`Unknown renderer: ${renderer}`);
    const m = readManifest(node.dir) || {};
    if (renderer === "quire") delete m.renderer;
    else m.renderer = renderer;
    for (const f of [path.join(node.dir, ".noteblock"), manifestFile(node.dir)]) markSelfWrite(f);
    writeManifest(node.dir, m);
    scheduleAutosave(vault, node.path);
    return null;
  });

  /**
   * A publish refused by the plan (hosting.mjs `code: "plan_limit"`): the fields publish-status
   * carries so the window can offer Upgrade to Pro. `upgrade` is false on Pro, where it can't help.
   */
  const planLimitOf = async (err) => {
    if (err?.code !== "plan_limit") return {};
    const plan = err.plan || (await hostingAccount().catch(() => null))?.plan || "free";
    return { code: "plan_limit", limit: err.limit || null, upgrade: plan !== "pro" };
  };
  const sendPublish = (msg) => {
    const win = ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("publish-status", msg);
  };

  handle("quire:publishStatus", async (pagePath) => {
    const vault = ctx.getVault();
    const status = await publishStatusAsync(vault, pagePath);
    return { ...status, busy: publishing.has(vault + "\0" + pagePath) };
  });

  // Publish / unpublish run in the background; progress and the result arrive as publish-status.
  // Anything that touches Quire's hosting (publishing there, or taking a page down from it) needs
  // the Quire account: signed out, it stops with state "signin" and the window asks the user to
  // sign in (SignInDialog). Cloudflare-only work never asks.
  const publishJob = (pagePath, kind, host) => {
    const vault = ctx.getVault();
    const key = vault + "\0" + pagePath;
    if (publishing.has(key)) return null;
    if (host != null && !HOSTS.includes(host)) throw new Error(`Unknown host: ${host}`);
    if (kind === "publish") gatePublish(vault, [findPage(vault, pagePath)]);
    publishing.add(key);
    const env = buildEnv();
    const run = async () => {
      const live = publicRecord(vault, pagePath);
      const target = host || live?.host || "quire";
      const touchesQuire = live?.host === "quire" || (kind === "publish" && target === "quire");
      if (touchesQuire && !(await hostingAccount()).signedIn) throw Object.assign(new Error(`Sign in to ${BRAND.name} first.`), { code: "signin" });
      if (kind === "unpublish") {
        sendPublish({ path: pagePath, state: "unpublishing" });
        return unpublishPage(vault, pagePath, { env });
      }
      sendPublish({ path: pagePath, state: "publishing" });
      return publishPage(vault, pagePath, { env, host: target });
    };
    const settled = async () => sendPublish({ path: pagePath, state: "done", ...(await publishStatusAsync(vault, pagePath)) });
    run().then(
      async () => {
        publishing.delete(key);
        scheduleAutosave(vault, pagePath);
        await settled();
        sendHosting();
      },
      async (err) => {
        publishing.delete(key);
        if (err?.code === "cancelled") return settled();
        if (err?.code === "signin") return sendPublish({ path: pagePath, state: "signin", kind, host: host || "quire" });
        sendPublish({ path: pagePath, state: "error", error: String(err?.message || err), output: err?.output || "", ...(await planLimitOf(err)) });
      },
    ).catch((err) => {
      console.error("[quire] publish:", err);
      sendPublish({ path: pagePath, state: "error", error: String(err?.message || err), output: "" });
    });
    return null;
  };
  handle("quire:publish", (pagePath, host) => publishJob(pagePath, "publish", host || null));
  handle("quire:unpublish", (pagePath) => publishJob(pagePath, "unpublish"));

  // A plain folder on managed hosting: the same background job and publish-status events, but they
  // name `folder` instead of `path`, so a window showing a page never takes one for its own.
  handle("quire:folderPublishStatus", async (folderPath) => {
    const vault = ctx.getVault();
    const norm = normPath(folderPath);
    return { ...(await folderPublishStatus(vault, norm)), busy: publishing.has(vault + "\0" + norm) };
  });

  const folderJob = (folderPath, kind) => {
    const vault = ctx.getVault();
    const folder = normPath(folderPath);
    const key = vault + "\0" + folder;
    if (publishing.has(key)) return null;
    if (kind === "publish") gatePublish(vault, pagesUnder(vault, folder));
    publishing.add(key);
    const env = buildEnv();
    const settled = async () => sendPublish({ folder, state: "done", ...(await folderPublishStatus(vault, folder)) });
    const run = async () => {
      if (!(await hostingAccount()).signedIn) throw Object.assign(new Error(`Sign in to ${BRAND.name} first.`), { code: "signin" });
      sendPublish({ folder, state: kind === "unpublish" ? "unpublishing" : "publishing" });
      return kind === "unpublish" ? unpublishFolder(vault, folder, { env }) : publishFolder(vault, folder, { env });
    };
    run().then(
      async () => {
        publishing.delete(key);
        scheduleAutosave(vault, folder);
        await settled();
        sendHosting();
      },
      async (err) => {
        publishing.delete(key);
        if (err?.code === "cancelled") return settled();
        if (err?.code === "signin") return sendPublish({ folder, state: "signin", kind, host: "quire" });
        sendPublish({ folder, state: "error", error: String(err?.message || err), output: err?.output || "", failed: err?.failed || [], ...(await planLimitOf(err)) });
      },
    ).catch((err) => console.error("[quire] folder publish:", err));
    return null;
  };
  handle("quire:publishFolder", (folderPath) => folderJob(folderPath, "publish"));
  handle("quire:unpublishFolder", (folderPath) => folderJob(folderPath, "unpublish"));

  /* Settings → Publishing: the Quire account, self-hosting and the Cloudflare login. */
  const sendHosting = () => {
    const win = ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("hosting-changed");
  };
  const selfHostOn = () => loadConfig().publishing?.selfHost === true;
  /** "quire" | "cloudflare": where Publish goes first (cloudflare only counts with self-hosting on). */
  const defaultHostPref = () => (loadConfig().publishing?.defaultHost === "cloudflare" ? "cloudflare" : "quire");
  /** Cloudflare's login state, or null when self-hosting is off (no wrangler call then). */
  const cloudflareState = async (fresh) => {
    if (!selfHostOn()) return null;
    if (cloudflareLoginRunning()) return { loggingIn: true, loggedIn: false, email: null, accounts: [] };
    try {
      return await cloudflareAccount({ env: buildEnv(), fresh });
    } catch (err) {
      return { loggedIn: false, email: null, accounts: [], error: String(err?.message || err) };
    }
  };
  handle("quire:publishingInfo", async (fresh) => ({
    selfHost: selfHostOn(),
    defaultHost: defaultHostPref(),
    quire: await hostingAccount({ fresh: !!fresh }),
    cloudflare: await cloudflareState(!!fresh),
  }));
  // What the Publish button offers for a page: Quire always; Cloudflare when self-hosting is on
  // and wrangler is logged in. quireHost previews where a Quire publish lands.
  handle("quire:publishTargets", async (pagePath) => {
    const vault = ctx.getVault();
    const node = findPage(vault, pagePath);
    const pub = publicRecord(vault, pagePath);
    // A new address gets a random tag from the server (hosting limits.ts withTag), so there is
    // nothing to preview until it's published once.
    const slug = pub?.host === "quire" && pub.slug ? pub.slug : null;
    const cf = await cloudflareState(false);
    const quireSignedIn = !!(await hostingAccount()).signedIn;
    return { quireHost: slug ? siteHost(slug) : null, quireSignedIn, cloudflare: !!cf?.loggedIn, defaultHost: cf?.loggedIn ? defaultHostPref() : "quire" };
  });
  handle("quire:setSelfHost", async (on) => {
    const cfg = loadConfig();
    saveConfig({ ...cfg, publishing: { ...(cfg.publishing || {}), selfHost: !!on } });
    sendHosting();
    return { selfHost: !!on, cloudflare: await cloudflareState(false) };
  });
  handle("quire:setDefaultHost", (host) => {
    const cfg = loadConfig();
    saveConfig({ ...cfg, publishing: { ...(cfg.publishing || {}), defaultHost: host === "cloudflare" ? "cloudflare" : "quire" } });
    sendHosting();
    return defaultHostPref();
  });
  handle("quire:hostingSignIn", async () => {
    const acct = await hostingSignIn({ openExternal: (url) => ctx.shell.openExternal(url) });
    sendHosting();
    return acct;
  });
  handle("quire:hostingCancelSignIn", () => hostingCancelSignIn());

  /* Settings → Plan (docs/hosting-api.md "Plans and billing"). Checkout and the portal open in the browser. */
  handle("quire:billing", () => hostingBilling());
  handle("quire:billingCheckout", (item) => hostingCheckout(String(item || ""), { openExternal: (url) => ctx.shell.openExternal(url) }));
  handle("quire:billingPortal", () => hostingPortal({ openExternal: (url) => ctx.shell.openExternal(url) }));

  /* Settings → Debug (dev and Next builds): fake billing data in memory, and a fake plan-limit publish error. */
  const debugOn = () => !!(ctx.dev || ctx.next);
  handle("quire:debugBilling", (mode) => {
    if (!debugOn()) throw new Error("Debug tools are only in dev and Next builds.");
    const next = setBillingFake(mode);
    sendHosting();
    return next;
  });
  handle("quire:debugPublishError", (pagePath) => {
    if (!debugOn()) throw new Error("Debug tools are only in dev and Next builds.");
    if (!pagePath) throw new Error("Open a page first.");
    sendPublish({
      path: String(pagePath),
      state: "error",
      error: "You've used all 3 sites on the Free plan. Unpublish one, or upgrade to Pro.",
      output: "",
      code: "plan_limit",
      limit: "sites",
      upgrade: true,
    });
    return null;
  });
  handle("quire:hostingSignOut", async () => {
    const acct = await hostingSignOut();
    sendHosting();
    return acct;
  });
  const sendCloudflare = (msg) => {
    const win = ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("cloudflare-status", msg);
  };
  // `wrangler login` opens the browser and returns by itself; its output streams as cloudflare-status.
  handle("quire:cloudflareLogin", () => {
    if (cloudflareLoginRunning()) return null;
    sendCloudflare({ state: "waiting", log: "" });
    cloudflareLogin({ env: buildEnv(), onLog: (log) => sendCloudflare({ state: "waiting", log }) }).then(
      (acct) => {
        sendCloudflare({ state: "done", account: acct });
        sendHosting();
      },
      (err) => sendCloudflare({ state: "error", error: String(err?.message || err), output: err?.output || "" }),
    );
    return null;
  });
  handle("quire:cloudflareCancelLogin", () => cancelCloudflareLogin());
  handle("quire:cloudflareLogout", async () => {
    const acct = await cloudflareLogout({ env: buildEnv() });
    sendHosting();
    return acct;
  });

  handle("quire:buildPage", (pagePath) => {
    const vault = ctx.getVault();
    const node = findPage(vault, pagePath);
    if (!node.build) throw new Error(`${node.path} has no build command`);
    askAgain(vault, node);
    rebuild(vault, node, true);
    return null;
  });

  handle("quire:createPage", (pagePath, opts = {}) => {
    const vault = ctx.getVault();
    // The window opens the page itself. Unmarked, the watcher takes these writes for an outside
    // edit 150 ms later and reloads the frame the page just opened in. The new folder still goes
    // through as tree-changed, which is what the other windows need.
    const newDir = pathDir(vault, pagePath);
    for (const f of [".noteblock", "index.html", "index.md"]) markSelfWrite(path.join(newDir, f));
    let node = createPage(vault, pagePath, { format: opts && opts.format === "md" ? "md" : "html" });
    const view = editorPrefs(loadConfig().editor).defaultRenderer;
    if (view !== "quire") {
      const m = readManifest(node.dir) || {};
      m.renderer = view;
      for (const f of [path.join(node.dir, ".noteblock"), manifestFile(node.dir)]) markSelfWrite(f);
      writeManifest(node.dir, m);
      node = findPage(vault, node.path);
    }
    scheduleAutosave(vault, node.path);
    return publicNode(node);
  });

  // Templates (core/templates.mjs): page folders in <configDir>/templates, outside the vault.
  const templatesState = () => ({ dir: templatesDir(), templates: listTemplates().map(({ dir, ...t }) => t) });
  handle("quire:listTemplates", () => templatesState());
  handle("quire:createFromTemplate", (template, folder, name) => {
    const vault = ctx.getVault();
    const node = createFromTemplate(vault, String(template || ""), String(folder || ""), name ? String(name) : undefined);
    // A template's commands were shown when it was added (addTemplateFromUrl): a page made from it here is approved.
    approveCommands(vault, node);
    scheduleAutosave(vault, node.path);
    rebuild(vault, node, true);
    return publicNode(node);
  });
  handle("quire:saveAsTemplate", (pagePath, name) => {
    flushAutosaves();
    saveAsTemplate(ctx.getVault(), String(pagePath || ""), name ? String(name) : undefined);
    return templatesState();
  });
  // Only allowCode and the commands the person was shown cross over: never core's test flags.
  handle("quire:addTemplateFromUrl", async (url, opts) => {
    const res = await addTemplateFromUrl(String(url || ""), { allowCode: opts?.allowCode, commands: opts?.commands });
    return res.added ? { added: res.added.map(({ dir, ...t }) => t) } : res;
  });
  handle("quire:restoreTemplates", () => {
    seedTemplates({ restore: true });
    return templatesState();
  });
  handle("quire:revealTemplate", (rel) => {
    if (rel) ctx.shell.showItemInFolder(templatePath(rel));
    else {
      seedTemplates();
      ctx.shell.openPath(templatesDir());
    }
    return null;
  });
  handle("quire:trashTemplate", async (rel) => {
    await ctx.shell.trashItem(templatePath(rel));
    return templatesState();
  });
  // Settings → Templates watches the folder while it's open; "templates-changed" on any change.
  let templatesWatch = null;
  handle("quire:watchTemplates", (on) => {
    if (templatesWatch) templatesWatch.close();
    templatesWatch = null;
    if (!on) return null;
    seedTemplates();
    let timer = null;
    try {
      templatesWatch = fs.watch(templatesDir(), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const win = ctx.getWindow();
          if (win && !win.isDestroyed()) win.webContents.send("templates-changed");
        }, 200);
      });
    } catch {}
    return null;
  });

  handle("quire:createFolder", (folderPath) => {
    const vault = ctx.getVault();
    const node = createFolder(vault, folderPath);
    scheduleAutosave(vault, node.path);
    const { dir, ...rest } = node;
    return rest;
  });

  // Native context menu. items: [{id, label, enabled?} | {type: "separator"}]; resolves the
  // clicked id, or null when dismissed.
  handle("quire:contextMenu", (items) => {
    const win = ctx.getWindow();
    return new Promise((resolve) => {
      let done = false;
      const pick = (id) => {
        if (done) return;
        done = true;
        resolve(id);
      };
      const template = (Array.isArray(items) ? items : []).map((it) =>
        it && it.type === "separator"
          ? { type: "separator" }
          : {
              label: String(it.label),
              type: it.type === "radio" || it.type === "checkbox" ? it.type : undefined,
              checked: !!it.checked,
              enabled: it.enabled !== false,
              accelerator: it.accelerator || undefined,
              registerAccelerator: false,
              click: () => pick(it.id),
            },
      );
      if (!template.length) return resolve(null);
      ctx.Menu.buildFromTemplate(template).popup({
        window: win || undefined,
        callback: () => setTimeout(() => pick(null), 50),
      });
    });
  });

  /**
   * Move a page, folder or file (vault-relative path) to the Trash and commit the removal.
   * Finder's "Put Back" undoes it, and git keeps the history. Never the vault's own .noteblock
   * (or .quire) or .git, a page's manifest, or anything in a page Claude is editing.
   */
  handle("quire:trash", (relPath) => trashPath(ctx, relPath));

  // Page and file paths in a job's way stay put until the job is done.
  const refuseIfAiWorking = (src) => {
    for (const j of ai.jobs()) {
      if (AI_BUSY.has(j.state) && j.page && (j.page === src || j.page.startsWith(src + "/"))) throw new Error(`${BRAND.name} AI is working on ${j.page}`);
    }
  };

  /** Tell every window a path moved: tabs, selection, history and expansion follow it. */
  const announceMoved = (from, to) => {
    const event = { type: "moved", from, to };
    if (ctx.broadcast) ctx.broadcast("ai-event", event);
    else ctx.getWindow()?.webContents.send("ai-event", event);
  };

  /** Move a page, folder or plain file and commit. `verb` starts the commit message. */
  const moveRow = async (from, to, verb, finish) => {
    const vault = ctx.getVault();
    const src = normPath(from);
    refuseIfAiWorking(src);
    const move = async (a, b) => {
      if (!isPlainFile(vault, a)) return movePagePath(ctx, a, b);
      flushAutosaves();
      return moveFile(vault, a, b);
    };
    let m;
    if (sameFile(vault, src, to)) {
      // Only the case changed on a disk that ignores case: the target "exists", so go through a spare name.
      const spare = `${to} renaming`;
      await move(src, spare);
      m = { ...(await move(spare, to)), from: src };
    } else {
      m = await move(src, to);
    }
    finish?.(m);
    try {
      const orderOf = (p) => [...p.split("/").slice(0, -1), ORDER_FILE].join("/");
      commitPaths(vault, `${verb} ${m.from} to ${m.to}`, [m.from, m.to, ...(m.relinked || []), orderOf(m.from)]);
    } catch {}
    announceMoved(m.from, m.to);
    return m;
  };

  /**
   * A sidebar row dropped on a folder: a page, folder or plain file moved into it and committed.
   * Null when that changes nothing. Every window follows through the "moved" event, as with
   * the assistant's move_page.
   */
  handle("quire:moveInto", async (from, folder, place) => {
    const vault = ctx.getVault();
    const to = dropMoveTarget(vault, String(from || ""), String(folder || ""));
    const m = to ? await moveRow(from, to, "Move") : null;
    // Dropped on a row's edge: the folder's order (core/order.mjs) puts it before or after that row.
    if (place && typeof place.anchor === "string") {
      const at = m ? m.to : normPath(String(from || ""));
      const name = at.split("/").pop();
      const parent = at.split("/").slice(0, -1).join("/");
      if (place.anchor !== name) {
        const names = listFolder(vault, parent).map((n) => n.path.split("/").pop());
        const dir = parent ? pathDir(vault, parent) : vault;
        markSelfWrite(path.join(dir, ORDER_FILE));
        writeOrder(dir, placeName(names, name, place.anchor, !!place.after));
        const rel = parent ? `${parent}/${ORDER_FILE}` : ORDER_FILE;
        try {
          commitPaths(vault, `Reorder ${parent || "vault"}`, [rel]);
        } catch {}
      }
      return m || { reordered: true };
    }
    return m;
  });

  /** A sidebar row renamed in place: same as a move, null when the name didn't change. */
  handle("quire:rename", async (from, name) => {
    const to = renameTarget(String(from || ""), name);
    if (!to) return null;
    return moveRow(from, to, "Rename", (m) => {
      // The renamed row keeps its place in its folder's order.
      const parent = m.from.split("/").slice(0, -1).join("/");
      const folderDir = parent ? pathDir(ctx.getVault(), parent) : ctx.getVault();
      try {
        markSelfWrite(path.join(folderDir, ORDER_FILE));
        renameInOrder(folderDir, m.from.split("/").pop(), m.to.split("/").pop());
      } catch {}
      // The row shows a manifest title over the folder name, so it has to change with it.
      if (m.kind !== "page") return;
      const dir = pathDir(ctx.getVault(), m.to);
      const manifest = readManifest(dir);
      const next = to.split("/").pop();
      if (manifest?.title) {
        for (const f of [path.join(dir, ".noteblock"), manifestFile(dir)]) markSelfWrite(f);
        writeManifest(dir, { ...manifest, title: next });
      }
      // A header that said the old name says the new one. Not a built page: its entry is generated.
      try {
        const node = findPage(ctx.getVault(), m.to);
        if (node.build) return;
        const file = path.join(node.dir, node.entry);
        const raw = fs.readFileSync(file, "utf8");
        const out = renameHeader(raw, node.format === "md" ? "md" : "html", manifest?.title || m.from.split("/").pop(), next);
        if (out !== raw) {
          markSelfWrite(file);
          fs.writeFileSync(file, out);
        }
      } catch (err) {
        console.error("[noteblock] header didn't follow the rename:", err.message);
      }
    });
  });

  /** A plain .html, .htm or .md file in the vault made into a page where it sits (core/drop.mjs). */
  handle("quire:convertToPage", (rel) => {
    const src = normPath(String(rel || ""));
    refuseIfAiWorking(src);
    flushAutosaves();
    const m = convertFileToPage(ctx.getVault(), src);
    announceMoved(m.from, m.to);
    return m;
  });

  /** Files and folders dropped from Finder or Explorer on the sidebar (core/drop.mjs). */
  handle("quire:importDropped", (sources, folder) => {
    flushAutosaves();
    return importDropped(ctx.getVault(), { sources: Array.isArray(sources) ? sources.map(String) : [], folder: String(folder || "") });
  });

  /** App preferences kept in config.json. confirmDelete: ask before moving to the Trash.
   * editor.*: page text size, readable width, font, spellcheck, default view for new pages. */
  handle("quire:getPrefs", () => appPrefs());
  /** The spellcheck dictionary (Settings › Editor; the right-click menu adds to it, spelling.mjs). */
  const spelling = async () => [(await import("electron")).session.defaultSession, await import("./spelling.mjs")];
  handle("quire:dictionaryWords", async () => {
    const [ses, sp] = await spelling();
    return sp.dictionaryWords(ses);
  });
  handle("quire:addDictionaryWord", async (word) => {
    const [ses, sp] = await spelling();
    return sp.addDictionaryWord(ses, word);
  });
  handle("quire:removeDictionaryWord", async (word) => {
    const [ses, sp] = await spelling();
    return sp.removeDictionaryWord(ses, word);
  });
  handle("quire:setPref", (key, value) => setAppPref(ctx, key, value));

  handle("quire:reveal", (relPath) => {
    const vault = ctx.getVault();
    const abs = relPath ? path.join(vault, ...String(relPath).split("/").filter((s) => s && s !== "..")) : vault;
    ctx.shell.showItemInFolder(abs);
    return null;
  });

  /** Absolute path of a vault-relative path ("" = the vault itself). */
  const absPath = (relPath) => {
    const vault = ctx.getVault();
    const segs = String(relPath || "").split("/").filter((s) => s && s !== "." && s !== "..");
    return segs.length ? path.join(vault, ...segs) : vault;
  };

  handle("quire:copyPath", async (relPath) => {
    const abs = absPath(relPath);
    const clipboard = ctx.clipboard || (await import("electron")).clipboard;
    clipboard.writeText(abs);
    return abs;
  });

  // A published page opens its public URL; any other page is served by the local
  // browser server (browser-server.mjs), started on first use.
  handle("quire:openInBrowser", async (pagePath) => {
    const vault = ctx.getVault();
    const node = findPage(vault, pagePath);
    const pub = publicRecord(vault, node.path);
    let url = pub && pub.url;
    if (!url) {
      const server = await getBrowserServer({
        getVault: () => ctx.getVault(),
        runRpc,
        proxyPort: (v, p) => proxyPort(v, p),
        onEntry: (p) => ensureBackend(ctx.getVault(), p).catch(() => {}),
        isRestricted: (v) => !isTrusted(v),
      });
      url = server.urlFor(node.path);
    }
    await ctx.shell.openExternal(url);
    return url;
  });

  handle("quire:getShortcuts", () => shortcutList());
  handle("quire:setShortcut", (id, accelerator) => setAppShortcut(ctx, id, accelerator));
  handle("quire:resetShortcuts", () => {
    resetShortcuts();
    ctx.rebuildMenu();
    return shortcutList();
  });
  // While the settings screen records a key, the menu must not swallow it.
  handle("quire:suspendShortcuts", (on) => {
    ctx.rebuildMenu({ suspended: !!on });
    suspendShortcutPriority(!!on);
    if (ctx.floating) ctx.floating.suspend(!!on);
    return null;
  });
  // Quire first / page first, for all shortcuts and per shortcut (app/main/keys.mjs).
  handle("quire:getShortcutPriority", () => shortcutPriority());
  handle("quire:setShortcutPriority", (value) => setShortcutPriority(value));
  handle("quire:setShortcutPriorityOverride", (id, value) => {
    setShortcutPriorityOverride(id, value ?? null);
    return shortcutList();
  });

  // `origin` is the sending frame's origin (MessageEvent.origin in App.jsx / Floating.jsx, which
  // the page can't forge): quire://p-<page id>. That, not anything in params, says which page
  // is calling.
  handleFrom("quire:rpc", (sender, origin, method, params) => {
    const vault = ctx.getVault();
    const pagePath = pageForOrigin(vault, String(origin || ""));
    if (!pagePath) throw new Error(`This frame isn't a ${BRAND.name} page`);
    if (method === "devtools.inspectEmbed") {
      // An embed's Inspect (runtime.js): the embed of params.page inside the calling page.
      if (!ctx.devtools) throw new Error("Inspect isn't available");
      const target = findPage(vault, String(params.page || "")).path;
      return ctx.devtools.inspect(sender, { path: target, embedOf: pagePath }).then(() => null);
    }
    if (method === "storage.migrated") {
      if (ctx.pageStorage) ctx.pageStorage.markMigrated(idOfOrigin(origin));
      return null;
    }
    const result = runRpc(vault, pagePath, method, params);
    if (RPC_WRITES.has(method)) written(method === "embed.setHeight" ? findPage(vault, params.page).path : pagePath, sender);
    return result;
  });

  // Noteblock AI (ai.mjs, docs/ai.md): jobs run in main; every window hears "ai-event".
  const ai = createAi({
    getVault: () => ctx.getVault(),
    send: (event) => (ctx.broadcast ? ctx.broadcast("ai-event", event) : ctx.getWindow()?.webContents.send("ai-event", event)),
    onWritten: (pagePath, sender) => written(pagePath, sender),
    onRebuild: (vault, node) => rebuild(vault, node, true),
    trash: (relPath, opts) => trashPath(ctx, relPath, opts),
    move: (from, to) => movePagePath(ctx, from, to),
    getPrefs: () => appPrefs(),
    setPref: (key, value) => setAppPref(ctx, key, value),
    getShortcuts: () => shortcutList(),
    setShortcut: (id, accelerator) => setAppShortcut(ctx, id, accelerator),
  });
  handle("quire:aiStatus", () => ai.status());
  // A "block" job is one a page started (an /ai block, runtime.js): never in restricted mode.
  handle("quire:aiStart", (opts) => {
    const o = opts && typeof opts === "object" ? opts : {};
    if (o.target === "block" && !isTrusted(ctx.getVault())) throw new Error(`Restricted mode. Pages can't start ${BRAND.name} AI.`);
    return ai.start(o);
  });
  handle("quire:aiStop", (jobId) => ai.stop(jobId));
  handle("quire:aiAnswer", (jobId, askId, allow, always) => ai.answer(jobId, askId, !!allow, !!always));
  // The window that applies (or undoes) reloads the page itself; the others hear page-files-changed.
  handleFrom("quire:aiApply", (sender, jobId) => ai.apply(jobId, { sender }));
  handleFrom("quire:aiUndo", (sender, jobId) => ai.undo(jobId, { sender }));
  handle("quire:aiJobs", () => ai.jobs());
  // ⌘J conversations (ai-chats.mjs), saved per vault outside it.
  handle("quire:aiChats", () => ai.chats());
  handle("quire:aiChat", (id) => ai.chat(id));
  handle("quire:aiDeleteChat", (id) => ai.deleteChat(id));
  handle("quire:aiPermissions", () => ai.permissions());
  handle("quire:aiSetPermissions", (patch) => ai.setPermissions(patch && typeof patch === "object" ? patch : {}));

  // Floating note (floating.mjs): config under "floating" in config.json, the window itself.
  const floating = () => {
    if (!ctx.floating) throw new Error("Floating note isn't available");
    return ctx.floating;
  };
  handle("quire:getFloating", () => floating().getConfig());
  handle("quire:setFloating", (patch) => floating().setConfig(patch && typeof patch === "object" ? patch : {}));
  handle("quire:openFloating", () => {
    floating().show();
    return null;
  });
  handle("quire:hideFloating", () => {
    floating().hide();
    return null;
  });
  handle("quire:floatingPage", () => floating().resolvePage());
  handle("quire:newFloatingNote", () => floating().newNote());
  handle("quire:floatingPicking", (on) => {
    floating().setPicking(!!on);
    return null;
  });

  const stateOf = (vault) => ({ vault, vaultName: vaultName(vault), user: currentUser(), dev: ctx.dev || null, trust: vaultTrust(vault) });

  /** Settings → Vault: this vault plus every remembered one. */
  handle("quire:vaultInfo", () => {
    const vault = ctx.getVault();
    const cfg = loadConfig();
    const vaults = [...new Set([vault, ...(cfg.vaults || [])].map((v) => path.resolve(v)))].map((v) => ({
      path: v,
      name: isVault(v) ? vaultName(v) : path.basename(v),
      missing: !isVault(v),
      current: v === path.resolve(vault),
    }));
    return { ...stateOf(vault), vaults };
  });

  // Rename and move keep the window: the renderer swaps in the new state.
  const relocate = (next, from = ctx.getVault()) => {
    moveSyncSetting(from, next);
    moveTrust(from, next);
    rememberVault(next);
    ctx.setVault(next);
    return stateOf(next);
  };

  handle("quire:renameVault", (name) => {
    flushAutosaves();
    const from = ctx.getVault();
    return relocate(renameVault(from, name), from);
  });

  handle("quire:moveVault", async () => {
    const vault = ctx.getVault();
    const win = ctx.getWindow();
    const opts = {
      title: "Move Vault",
      message: `Choose the folder to move “${path.basename(vault)}” into`,
      buttonLabel: "Move Here",
      defaultPath: path.dirname(vault),
      properties: ["openDirectory", "createDirectory"],
    };
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    flushAutosaves();
    return relocate(moveVault(vault, path.join(path.resolve(res.filePaths[0]), path.basename(vault))), vault);
  });

  // Switching vaults reloads the window, like opening one.
  const switchTo = (dir) => {
    flushAutosaves();
    rememberVault(dir);
    ctx.setVault(dir);
    const win = ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.reload();
    return stateOf(dir);
  };

  handle("quire:switchVault", (dir) => {
    const abs = path.resolve(String(dir || ""));
    if (!isVault(abs)) throw new Error(`Not a ${BRAND.name} vault: ${abs}`);
    return switchTo(abs);
  });

  handle("quire:createVault", async () => {
    const win = ctx.getWindow();
    const opts = {
      title: "Create Vault",
      buttonLabel: "Create",
      nameFieldLabel: "Vault name:",
      defaultPath: path.join(path.dirname(ctx.getVault()), "New vault"),
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const res = win ? await ctx.dialog.showSaveDialog(win, opts) : await ctx.dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    const dir = path.resolve(res.filePath);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already exists and isn't empty`);
    return switchTo(createVault(dir, { name: path.basename(dir), seed: false }));
  });

  handle("quire:forgetVault", (dir) => {
    const abs = path.resolve(String(dir || ""));
    if (abs === path.resolve(ctx.getVault())) throw new Error("Can't remove the open vault from the list");
    const cfg = loadConfig();
    saveConfig({ ...cfg, vaults: (cfg.vaults || []).filter((v) => path.resolve(v) !== abs) });
    return null;
  });

  handle("quire:openVault", async () => {
    const win = ctx.getWindow();
    const opts = {
      title: "Open Vault",
      buttonLabel: "Open",
      properties: ["openDirectory", "createDirectory"],
    };
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    const dir = path.resolve(res.filePaths[0]);
    // A folder made into a vault here is trusted only when it was empty (core createVault). Any
    // other folder this Mac hasn't trusted opens as "ask": restricted until the window's trust
    // prompt is answered (App.jsx TrustDialog).
    const vault = isVault(dir) ? dir : createVault(dir, { seed: false });
    rememberVault(vault);
    ctx.setVault(vault);
    if (win && !win.isDestroyed()) win.webContents.reload();
    return stateOf(vault);
  });
}
