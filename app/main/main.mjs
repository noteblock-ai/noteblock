// Electron main process (ESM).
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, protocol, session, shell } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../../core/brand.mjs";
import { loadConfig, saveConfig, createVault, listLocks, migrateVault, migrateVaultNames, migrateConfigDirName, isVaultDir, isManifestName, ensureGitignore, configureRepo, findPage, buildInfo, isBuildOutput } from "../../core/index.mjs";
import { scheduleBuild, isBuilding } from "./builds.mjs";
import { registerQuireProtocol, originGuard, opensInBrowser } from "./protocol.mjs";
import { createPageStorage } from "./page-storage.mjs";
import { ensurePageIds, idForPath, pathsForId } from "./origins.mjs";
import { createPageDevtools } from "./page-devtools.mjs";
import { registerIpc, rememberVault } from "./ipc.mjs";
import { watchVault } from "./watcher.mjs";
import { flushAutosaves, onAutosaveCommit } from "./autosave.mjs";
import { shortcutFor } from "./shortcuts.mjs";
import { installShortcutPriority } from "./keys.mjs";
import { createFloating, floatingConfig } from "./floating.mjs";
import { startSync, syncSoon, syncOnFocus } from "./sync.mjs";
import { startUpdateChecks, checkForUpdate, readVersion } from "./updater.mjs";
import { backupPageData, oneAtATime, useNextConfig } from "./next.mjs";
import { watchWindow } from "./page-health.mjs";
import { initTools } from "./tools.mjs";
import { ensureBackend, proxyPort, backendFilesChanged, onBackendStatus, stopAllBackends, killAllBackendsNow } from "./backend.mjs";
import { attachEditMenu } from "./spelling.mjs";
import { migrateTrust, isTrusted, ensureBaseline, noteLocks, onTrustRequest, restrictedCsp, setVaultTrust, forgetTrust, trustCreated, vaultTrust, ASK, TRUSTED, RESTRICTED } from "./trust.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_INDEX = path.resolve(HERE, "..", "renderer", "dist", "index.html");
const FLOATING_HTML = path.resolve(HERE, "..", "renderer", "dist", "floating.html");
const PRELOAD = path.join(HERE, "preload.cjs");

// Every page has its own origin, quire://p-<page id>/ (origins.mjs). `standard` gives each host
// its own origin and site, so Chromium's site isolation puts each page in its own renderer
// process; `secure` makes them secure contexts; `corsEnabled` lets pages load the shared
// quire://runtime/ module scripts and fonts. Electron does not run CORS checks for a custom
// scheme, so cross-page reads are refused by originGuard (session.webRequest, below).
protocol.registerSchemesAsPrivileged([
  {
    scheme: "quire",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// Run from a checkout (`pnpm dev`) this is Quire Dev: its own name, Dock icon, profile, config
// (~/.noteblock-dev, once ~/.quire-dev) and vault (~/Quire/Dev Vault, or QUIRE_VAULT), so a branch never touches the
// notes the installed Quire has open. Several checkouts can run at once.
const DEV = !app.isPackaged && (!process.env.QUIRE_CAPTURE || process.env.QUIRE_DEV === "1");
const REPO_ROOT = path.resolve(HERE, "..", "..");
const WIN = process.platform === "win32";
// QUIRE_FAKE_PLATFORM=win32 draws the renderer as on Windows (platform class, menu button,
// shortcut labels) on a Mac, for hidden capture checks. Main-process behaviour is unchanged.
const FAKE_PLATFORM = process.env.QUIRE_FAKE_PLATFORM || "";

/** Window chrome per OS: traffic lights inset on Mac; Windows draws its own caption buttons over a hidden title bar. */
const TITLE_BAR = WIN
  ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#FFFFFF", symbolColor: "#15171C", height: 44 } }
  : { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } };

// The name the app had through 0.2.x, set before ready on purpose. Chromium names the macOS
// keychain item that safeStorage and the cookie store encrypt with after the app's name at this
// point ("Quire Safe Storage"), and userData defaults to it, so an install that auto-updated keeps
// its keychain key, tabs, settings and page storage. The public name (BRAND.name, from
// core/brand.mjs) replaces it once the app is ready, before any menu or window reads app.name.
// Noteblock Next has no history to keep, so both of its names are the new one (app/main/next.mjs).
const NEXT = app.isPackaged && !process.env.QUIRE_CAPTURE && readVersion()?.channel === "next";
const LEGACY_NAME = DEV ? "Quire Dev" : NEXT ? `${BRAND.name} Next` : "Quire";
const PUBLIC_NAME = DEV ? `${BRAND.name} Dev` : NEXT ? `${BRAND.name} Next` : BRAND.name;
app.setName(LEGACY_NAME);
app.setPath("userData", path.join(app.getPath("appData"), LEGACY_NAME));
// The dev config is an override, so configDir() never migrates it: move ~/.quire-dev to
// ~/.noteblock-dev here (leaving a symlink), the way configDir() does for ~/.quire.
if (DEV && !process.env.NOTEBLOCK_CONFIG_DIR && !process.env.QUIRE_CONFIG_DIR) {
  const devConfig = path.join(os.homedir(), ".noteblock-dev");
  migrateConfigDirName(path.join(os.homedir(), ".quire-dev"), devConfig);
  // Both names, so a CLI from before the rename that this app spawns reads the same config.
  process.env.NOTEBLOCK_CONFIG_DIR = devConfig;
  process.env.QUIRE_CONFIG_DIR = devConfig;
}

if (NEXT) useNextConfig();

/** Branch (and worktree folder, when it differs) of a dev checkout, shown in the top bar. */
function devLabel() {
  try {
    const branch = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const folder = path.basename(REPO_ROOT);
    return folder === branch || folder === "quire" ? branch : `${branch} · ${folder}`;
  } catch {
    return "dev";
  }
}

// Capture runs (QUIRE_CAPTURE) get their own profile so they never collide with a running Quire.
// QUIRE_USER_DATA reuses one profile across capture runs (checks that need two launches).
if (process.env.QUIRE_CAPTURE) app.setPath("userData", process.env.QUIRE_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), "quire-capture-")));

const LINK_SCHEME = "noteblock";

/** The noteblock:// URL in a launch's argv (Windows, Linux), if any. */
function linkFromArgv(argv) {
  return (Array.isArray(argv) ? argv : []).find((a) => typeof a === "string" && a.toLowerCase().startsWith(LINK_SCHEME + ":")) || null;
}

/** noteblock://open?path=<vault-relative path> → that path; null for another action or a bad path. */
function parseLink(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== LINK_SCHEME + ":") return null;
  const action = (u.hostname || u.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
  if (action !== "open") return null;
  const raw = u.searchParams.get("path");
  if (!raw) return null;
  const segs = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segs.length || segs.some((s) => s === ".." || s === ".")) return null;
  return segs.join("/");
}

if (!process.env.QUIRE_CAPTURE && !DEV && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  // Quire's own git, Node and pnpm (tools.mjs): before anything commits or builds.
  initTools({ dir: path.join(app.getPath("userData"), "tools") });
  // Quire's shortcuts reach Quire before the page (Settings → Keyboard shortcuts): app/main/keys.mjs.
  installShortcutPriority({ app, Menu, BrowserWindow });

  // Every main window (File → New Window, ⌘⇧N). `win` is the one focused last: the target for
  // dialogs, status updates and anything else that needs a single window.
  /** @type {Set<BrowserWindow>} */
  const wins = new Set();
  /** @type {BrowserWindow | null} */
  let win = null;
  let vault = null;
  let stopWatch = null;
  /** @type {ReturnType<typeof createFloating> | null} */
  let floating = null;

  // Inspect page (⌘⌥J): a DevTools window per page or embed (page-devtools.mjs).
  const devtools = createPageDevtools({
    idForPath: (p) => (vault ? idForPath(vault, p) : null),
    pathForId: (id) => (vault ? pathsForId(vault, id)[0] || null : null),
    titleFor: (p) => {
      try {
        return findPage(vault, p).title || p.split("/").pop();
      } catch {
        return p.split("/").pop();
      }
    },
    show: !process.env.QUIRE_CAPTURE,
  });
  /** The window a menu item acts on: the floating note when it is in front, else the main one. */
  const targetWindow = (bw) => (bw && !bw.isDestroyed() && !devtools.isInspector(bw) && (wins.has(bw) || (floating && floating.owns(bw))) ? bw : win);
  /** The main window a menu item acts on: the one in front, else the one focused last. */
  const frontMain = (bw) => (bw && !bw.isDestroyed() && wins.has(bw) ? bw : win);

  const send = (channel, ...args) => {
    for (const w of wins) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
    if (floating) floating.send(channel, ...args);
  };

  /** A menu action: the main window in front (never every window), and the floating note. */
  const menuSend = (bw, action) => {
    const w = frontMain(bw);
    if (w && !w.isDestroyed()) w.webContents.send("menu", action);
    if (floating) floating.send("menu", action);
  };

  /** A menu action for the window in front only (the floating note when it's focused). */
  const sendToFront = (bw, action) => {
    if (floating && floating.owns(bw)) floating.send("menu", action);
    else {
      const w = frontMain(bw);
      if (w && !w.isDestroyed()) w.webContents.send("menu", action);
    }
  };

  const isVault = (dir) => isVaultDir(dir);

  function initialVault() {
    const forced = process.env.QUIRE_VAULT && path.resolve(process.env.QUIRE_VAULT);
    if (forced) {
      const dir = isVault(forced) ? forced : createVault(forced, { name: path.basename(forced), seed: true });
      // QUIRE_VAULT is the person (or a check script) pointing the app at a folder, so it's
      // trusted unless QUIRE_TRUST says otherwise: "restricted", or "ask" to get the prompt.
      const want = process.env.QUIRE_TRUST;
      if (want === TRUSTED || want === RESTRICTED) setVaultTrust(dir, want);
      else if (want === ASK) forgetTrust(dir);
      else trustCreated(dir);
      rememberVault(dir);
      return dir;
    }
    const cfg = loadConfig();
    if (isVault(cfg.current)) return cfg.current;
    const def = path.join(os.homedir(), "Quire", DEV ? "Dev Vault" : "My First Vault");
    const dir = isVault(def) ? def : createVault(def, { name: DEV ? "Dev Vault" : "My First Vault", seed: true });
    // The app's own default vault, made by it on this Mac (createVault trusts a new one already).
    trustCreated(dir);
    rememberVault(dir);
    return dir;
  }

  const notifyBuild = (msg) => send("build-status", msg);

  function setVault(dir) {
    if (stopWatch) stopWatch();
    if (vault && vault !== dir) {
      stopAllBackends().catch(() => {});
      devtools.closeAll();
    }
    try {
      migrateVaultNames(dir); // .quire → .noteblock (core/vault.mjs); before anything reads it
    } catch (err) {
      console.error("[quire] vault rename failed:", err.message);
    }
    try {
      migrateVault(dir);
    } catch (err) {
      console.error("[quire] vault migration failed:", err.message);
    }
    try {
      ensureGitignore(dir);
    } catch {}
    try {
      configureRepo(dir); // autocrlf off, long paths on (core/git.mjs)
    } catch {}
    try {
      ensurePageIds(dir); // every page's origin is quire://p-<id> (origins.mjs)
    } catch {}
    vault = dir;
    // Trust (trust.mjs): a trusted vault's commands as they are now are approved, before sync
    // or the watcher can bring in new ones; and the locks agents hold are noted.
    try {
      ensureBaseline(dir);
      noteLocks(dir);
    } catch (err) {
      console.error("[noteblock] trust baseline failed:", err.message);
    }
    if (floating) floating.vaultChanged();
    if (!process.env.QUIRE_CAPTURE) startSync(dir, (status) => send("sync-status", status));
    stopWatch = watchVault(dir, {
      onLocks: () => {
        noteLocks(dir); // a lock that went away approves what its agent wrote
        send("locks-changed", listLocks(dir));
        syncSoon();
      },
      onTree: () => {
        send("tree-changed");
        devtools.pagesChanged();
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
        // Restricted: no builds, so a built page just reloads like any other.
        const info = node && node.build && isTrusted(dir) ? buildInfo(node.dir) : null;
        if (info) {
          // A built page reloads when its build finishes (build-status), never on the raw file
          // churn: an install or bundler touches files mid-build, and a reload then would throw
          // away whatever the person is typing.
          if (isBuilding(dir, p)) return;
          if (files.some((f) => f && !isBuildOutput(info, f))) {
            scheduleBuild(dir, p, { reload: true, ifChanged: true, notify: notifyBuild });
            return;
          }
        }
        send("page-files-changed", p);
      },
    });
  }

  function isExternal(url, frame) {
    return opensInBrowser(url, frame) && !(process.env.QUIRE_DEV_URL && url.startsWith(process.env.QUIRE_DEV_URL));
  }

  /**
   * Open a link a frame navigated to in the browser. In restricted mode a page's navigation asks
   * first: a page could otherwise send what it read to the web by opening a URL.
   */
  async function openFromFrame(url, frame, owner) {
    let fromPage = false;
    try {
      fromPage = /^quire:/i.test(String(frame && frame.url));
    } catch {}
    if (fromPage && vault && !isTrusted(vault)) {
      const opts = {
        type: "question",
        message: "Open this link in your browser?",
        detail: url.length > 300 ? url.slice(0, 300) + "…" : url,
        buttons: ["Open", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      };
      const { response } = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, opts) : await dialog.showMessageBox(opts);
      if (response !== 0) return;
    }
    shell.openExternal(url);
  }

  onAutosaveCommit(() => syncSoon());

  // Windows: closing the last window quits, unless the floating note is on. Then Quire stays in
  // the notification area with a tray icon, so the note's global shortcut keeps working, and
  // says so once ("Quire is still running").
  /** @type {Tray | null} */
  let tray = null;
  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });

  /** Open Quire from the tray: the window used last, or a new one when every window is closed. */
  function openQuire() {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else createWindow();
  }

  async function ensureTray() {
    if (tray) return;
    let icon;
    try {
      icon = await app.getFileIcon(process.execPath, { size: "small" });
    } catch {}
    if (tray || !icon) return;
    tray = new Tray(icon);
    tray.setToolTip(app.name);
    const fmt = (acc) => String(acc || "").replace(/CmdOrCtrl|CommandOrControl/g, "Ctrl");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${app.name}`, click: () => openQuire() },
        { label: "New window", click: () => createWindow({ fresh: !!win }) },
        { label: "Floating note", accelerator: fmt(floatingConfig().shortcut) || undefined, registerAccelerator: false, click: () => floating && floating.show() },
        { type: "separator" },
        { label: `Quit ${app.name}`, click: () => app.quit() },
      ]),
    );
    tray.on("click", () => openQuire());
  }

  /** The one-time notice, the first time the last window closes with the note on. */
  function stillRunningNotice() {
    const cfg = loadConfig();
    if (cfg.trayNoticeShown || !Notification.isSupported()) return;
    saveConfig({ ...cfg, trayNoticeShown: true });
    const key = String(floatingConfig().shortcut || "").replace(/CmdOrCtrl|CommandOrControl/g, "Ctrl");
    new Notification({
      title: `${app.name} is still running`,
      body: `${key ? `Press ${key} for your floating note. ` : ""}Quit from the tray icon.`,
    }).show();
  }

  /** Off the Mac, the last main window just closed: quit, or stay in the tray for the floating note. */
  function afterLastWindow() {
    if (process.platform === "darwin" || quitting) return;
    if (WIN && !process.env.QUIRE_CAPTURE && floatingConfig().enabled) {
      ensureTray().catch(() => {});
      stillRunningNotice();
      return;
    }
    app.quit();
  }

  /** fresh: a New Window — no restored tabs, offset from the window in front. */
  function createWindow({ fresh = false } = {}) {
    const from = fresh && win && !win.isDestroyed() ? win.getBounds() : null;
    const w = new BrowserWindow({
      ...(from ? { x: from.x + 28, y: from.y + 28 } : {}),
      width: from ? from.width : 1440,
      height: from ? from.height : 960,
      minWidth: 900,
      minHeight: 600,
      title: app.name,
      ...TITLE_BAR,
      backgroundColor: "#FFFFFF",
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        plugins: true, // the built-in PDF viewer, for PDFs in the file view
        ...(FAKE_PLATFORM ? { additionalArguments: [`--quire-platform=${FAKE_PLATFORM}`] } : {}),
      },
    });
    attachEditMenu(w.webContents);
    wins.add(w);
    if (WIN) altOpensMenu(w);
    win = w;
    // QUIRE_CAPTURE=/path.png renders hidden, saves a screenshot and quits (for checks that
    // must not take over the screen). QUIRE_OPEN_PAGE=<page path> opens that page.
    const capture = fresh ? null : process.env.QUIRE_CAPTURE;
    if (capture) {
      app.dock?.hide();
      w.webContents.once("did-finish-load", () => {
        setTimeout(async () => {
          // QUIRE_TEST_SCRIPT=<module> runs its default export in main with the window and
          // helpers instead of the usual shot (scripts/verify-origins.mjs).
          if (process.env.QUIRE_TEST_SCRIPT) {
            let code = 0;
            try {
              const mod = await import(path.resolve(process.env.QUIRE_TEST_SCRIPT));
              await mod.default({ app, win: w, floating, devtools, getVault: () => vault, BrowserWindow, capture });
            } catch (err) {
              console.error("[quire-test] failed:", err && err.stack ? err.stack : err);
              code = 1;
            }
            app.exit(code);
            return;
          }
          // QUIRE_OPEN_FLOATING=1 captures the floating note instead (QUIRE_MENU and
          // QUIRE_EVAL_FLOATING go to it; QUIRE_AX_HOLD=<ms> orders it in, invisible, first).
          if (process.env.QUIRE_OPEN_FLOATING === "1" && floating) {
            await floating.capture(capture, {
              menu: (process.env.QUIRE_MENU || "").split(",").filter(Boolean),
              evalJs: process.env.QUIRE_EVAL_FLOATING || "",
              hold: Number(process.env.QUIRE_AX_HOLD || 0),
            });
            app.exit(0);
            return;
          }
          // QUIRE_EVAL_PAGE=<js> runs inside the page iframe first (used by scripts/smoke-app.mjs).
          if (process.env.QUIRE_EVAL_PAGE) {
            const frame = w.webContents.mainFrame.frames[0];
            const out = await frame?.executeJavaScript(process.env.QUIRE_EVAL_PAGE).catch((e) => "error: " + e.message);
            console.log("[quire-eval]", JSON.stringify(out));
            await new Promise((r) => setTimeout(r, 1500));
          }
          // QUIRE_MENU=settings,new-folder fires menu actions before the shot.
          for (const action of (process.env.QUIRE_MENU || "").split(",").filter(Boolean)) {
            send("menu", action);
            await new Promise((r) => setTimeout(r, 400));
          }
          // QUIRE_EVAL_APP=<js> runs in the app window itself, after the menu actions.
          if (process.env.QUIRE_EVAL_APP) {
            const out = await w.webContents.executeJavaScript(process.env.QUIRE_EVAL_APP).catch((e) => "error: " + e.message);
            console.log("[quire-eval-app]", JSON.stringify(out));
            await new Promise((r) => setTimeout(r, 800));
          }
          const img = await w.webContents.capturePage();
          fs.writeFileSync(capture, img.toPNG());
          app.exit(0);
        }, Number(process.env.QUIRE_CAPTURE_DELAY || 3000));
      });
    } else {
      w.once("ready-to-show", () => !w.isDestroyed() && w.show());
    }
    watchWindow(w, { quiet: !!capture });
    w.on("focus", () => {
      win = w;
      syncOnFocus();
    });
    w.on("closed", () => {
      wins.delete(w);
      if (win === w) win = [...wins].pop() || null;
      if (!wins.size) afterLastWindow();
    });

    const wc = w.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    // Links clicked inside the app or a page iframe: external ones go to the browser.
    wc.on("will-frame-navigate", (event) => {
      if (isExternal(event.url, event.frame)) {
        event.preventDefault();
        openFromFrame(event.url, event.frame, w).catch(() => {});
      }
    });

    if (process.env.QUIRE_DEV_URL) w.loadURL(process.env.QUIRE_DEV_URL);
    else w.loadFile(RENDERER_INDEX, fresh ? { query: { window: "new" } } : process.env.QUIRE_OPEN_PAGE ? { query: { page: process.env.QUIRE_OPEN_PAGE } } : undefined);
    return w;
  }

  /** Windows: the app menu as a popup (the menu button left of the vault name, or Alt). */
  function popupAppMenu(w, x = 18, y = 50) {
    const menu = Menu.getApplicationMenu();
    if (menu && w && !w.isDestroyed()) menu.popup({ window: w, x, y });
  }

  /** Windows: Alt pressed and released on its own opens the app menu, like a menu bar would. */
  function altOpensMenu(w) {
    let alone = false;
    w.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown") alone = input.key === "Alt" && !input.isAutoRepeat && !input.control && !input.shift && !input.meta;
      else if (input.type === "keyUp" && input.key === "Alt") {
        if (alone) popupAppMenu(w);
        alone = false;
      }
    });
  }

  /** suspended: no custom accelerators (the settings screen is recording a key). */
  function buildMenu({ suspended = false } = {}) {
    const isMac = process.platform === "darwin";
    const key = (id) => (suspended ? undefined : shortcutFor(id) || undefined);
    const template = [
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" },
                ...(DEV ? [] : [{ label: "Check for Updates…", click: () => checkFromMenu() }]),
                { type: "separator" },
                { label: "Settings…", accelerator: key("settings"), click: (_item, bw) => menuSend(bw, "settings") },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ]
        : []),
      {
        label: "File",
        submenu: [
          { label: "New Page", accelerator: key("new-page"), click: (_item, bw) => menuSend(bw, "new-page") },
          { label: "New Page from Template…", accelerator: key("new-from-template"), click: (_item, bw) => menuSend(bw, "new-from-template") },
          { label: "New Folder", accelerator: key("new-folder"), click: (_item, bw) => menuSend(bw, "new-folder") },
          { label: "New Tab", accelerator: key("new-tab"), click: (_item, bw) => menuSend(bw, "new-tab") },
          { label: "New Window", accelerator: key("new-window"), click: () => createWindow({ fresh: true }) },
          // ⌘⌫ is handled by the window (outside text fields), so typing keeps it for deleting text.
          { label: WIN ? "Move to Recycle Bin" : "Move to Trash", accelerator: "CmdOrCtrl+Backspace", registerAccelerator: false, click: (_item, bw) => menuSend(bw, "trash") },
          { type: "separator" },
          { label: "Open Vault…", accelerator: key("open-vault"), click: () => openVaultFromMenu() },
          { label: "Import from Obsidian…", click: (_item, bw) => menuSend(bw, "import-obsidian") },
          { label: "Import from Claude…", click: (_item, bw) => menuSend(bw, "import-claude") },
          { label: WIN ? "Show Vault in File Explorer" : "Reveal Vault in Finder", click: () => vault && shell.showItemInFolder(vault) },
          { type: "separator" },
          { label: "Close Tab", accelerator: key("close-tab"), click: (_item, bw) => menuSend(bw, "close-tab") },
          ...(isMac
            ? [{ role: "close", accelerator: "CmdOrCtrl+Shift+W" }]
            : [
                // No app menu off the Mac: Settings, updates and Exit live in File.
                { type: "separator" },
                { label: "Settings", accelerator: key("settings"), click: (_item, bw) => menuSend(bw, "settings") },
                ...(DEV ? [] : [{ label: "Check for Updates…", click: () => checkFromMenu() }]),
                { type: "separator" },
                { role: "quit", label: "Exit" },
              ]),
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "selectAll" },
          { type: "separator" },
          // Find in page (renderer/src/FindBar.jsx), in the window in front: the floating note
          // searches its own page. ⌘G / ⇧⌘G are fixed, like a browser's.
          { label: "Find…", accelerator: key("find"), click: (_item, bw) => sendToFront(bw, "find") },
          { label: "Find Next", accelerator: suspended ? undefined : "CmdOrCtrl+G", click: (_item, bw) => sendToFront(bw, "find-next") },
          { label: "Find Previous", accelerator: suspended ? undefined : "Shift+CmdOrCtrl+G", click: (_item, bw) => sendToFront(bw, "find-previous") },
          { type: "separator" },
          // The prompt bar (docs/ai.md), in the window in front: the floating note changes its own page.
          { label: `${BRAND.name} AI…`, accelerator: key("ai-bar"), click: (_item, bw) => sendToFront(bw, "ai-bar") },
        ],
      },
      {
        label: "View",
        submenu: [
          // In the floating note it opens the note's page picker instead.
          {
            label: "Command Palette…",
            accelerator: key("command-palette"),
            click: (_item, bw) => {
              if (floating && floating.owns(bw)) floating.send("menu", "command-palette");
              else menuSend(bw, "command-palette");
            },
          },
          { label: "Cycle View", accelerator: key("toggle-source"), click: (_item, bw) => menuSend(bw, "toggle-source") },
          { label: "Toggle Sidebar", accelerator: key("toggle-sidebar"), click: (_item, bw) => menuSend(bw, "toggle-sidebar") },
          { label: "Backend Logs", click: (_item, bw) => menuSend(bw, "backend") },
          { type: "separator" },
          { label: "Back", accelerator: key("back"), click: (_item, bw) => sendToFront(bw, "back") },
          { label: "Forward", accelerator: key("forward"), click: (_item, bw) => sendToFront(bw, "forward") },
          { type: "separator" },
          { label: "Next Tab", accelerator: key("next-tab"), click: (_item, bw) => menuSend(bw, "next-tab") },
          { label: "Previous Tab", accelerator: key("prev-tab"), click: (_item, bw) => menuSend(bw, "prev-tab") },
          // Ctrl+Tab / Ctrl+⇧Tab always cycle tabs too, whatever the two above are bound to.
          { label: "Next Tab", accelerator: "Ctrl+Tab", visible: false, click: (_item, bw) => menuSend(bw, "next-tab") },
          { label: "Previous Tab", accelerator: "Ctrl+Shift+Tab", visible: false, click: (_item, bw) => menuSend(bw, "prev-tab") },
          // ⌘1…⌘8 pick a tab, ⌘9 the last one.
          ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: "Tab " + n, accelerator: "CmdOrCtrl+" + n, visible: false, click: (_item, bw) => menuSend(bw, "tab-" + n) })),
          { type: "separator" },
          { role: "reload" },
          // Inspect page: DevTools for just the focused page or embed (page-devtools.mjs).
          // App Developer Tools: Electron's DevTools for the whole window in front, to debug
          // Quire itself (in an inspector window, DevTools for that inspector).
          {
            label: "Inspect Page",
            accelerator: key("developer-tools"),
            click: (_item, bw) => {
              const w = targetWindow(bw);
              if (w && !w.isDestroyed()) devtools.inspectFocused(w.webContents).catch((err) => console.error("[quire] inspect page:", err.message));
            },
          },
          { label: "App Developer Tools", accelerator: key("app-developer-tools"), click: (_item, bw) => (bw || win)?.webContents.toggleDevTools() },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      ...(isMac ? [] : [{ label: "Help", submenu: [{ label: `About ${app.name}`, click: () => app.showAboutPanel() }] }]),
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  async function checkFromMenu() {
    const s = await checkForUpdate();
    if (s.state === "available") {
      send("update-status", { ...s, manual: true }); // show the toast even after "Later"
      return;
    }
    if (s.state === "downloading" || s.state === "ready") return send("update-status", { ...s, manual: true });
    const detail = `You have ${BRAND.name} ${app.getVersion()}${s.current?.sha ? ` (built from ${s.current.sha.slice(0, 7)})` : ""}.`;
    dialog.showMessageBox({ message: s.error || `${BRAND.name} is up to date.`, detail });
  }

  // Same path as quireApp.openVault(), for the menu item.
  let openVaultHandler = null;
  async function openVaultFromMenu() {
    if (openVaultHandler) {
      try {
        await openVaultHandler();
      } catch (err) {
        dialog.showErrorBox("Could not open vault", String((err && err.message) || err));
      }
    }
  }

  // noteblock://open?path=<vault-relative path> (docs/contract.md, "Deep links"). macOS hands the
  // URL to open-url (before ready on a cold start), Windows and Linux put it in argv: on the
  // first launch, and through second-instance once Noteblock is running.
  if (!process.env.QUIRE_CAPTURE) {
    if (!DEV) app.setAsDefaultProtocolClient(LINK_SCHEME);
    // Dev (Electron docs): register the dev binary plus the app path, only when asked so a dev
    // run never takes the scheme from the installed Noteblock.
    else if (process.env.NOTEBLOCK_DEV_SCHEME === "1" && process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    }
  }
  let pendingLink = linkFromArgv(process.argv);
  let linksReady = false; // set once the vault is open and the first window made (whenReady)
  app.on("open-url", (event, url) => {
    event.preventDefault();
    openLink(url);
  });

  /** Show the main window, then (a known action) hand the path to its renderer once it has loaded. */
  function openLink(url) {
    if (!linksReady) {
      pendingLink = url;
      return;
    }
    openQuire();
    const target = parseLink(url);
    const w = win;
    if (!target || !w || w.isDestroyed()) return;
    const deliver = () => !w.isDestroyed() && w.webContents.send("open-path", target);
    if (w.webContents.isLoading()) w.webContents.once("did-finish-load", deliver);
    else deliver();
  }

  app.on("second-instance", (_event, argv) => {
    const link = linkFromArgv(argv);
    if (link) return openLink(link);
    // The taskbar jump list's New window (app.setUserTasks, below) starts Quire with --new-window.
    if (Array.isArray(argv) && argv.includes("--new-window")) return createWindow({ fresh: !!win });
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    app.setName(PUBLIC_NAME); // see LEGACY_NAME above
    if (!process.env.QUIRE_CAPTURE && !DEV) await oneAtATime({ next: NEXT, app, dialog });
    if (NEXT) {
      try {
        backupPageData(loadConfig().current, app.getVersion());
      } catch (err) {
        console.error("page data backup:", err);
      }
    }
    // First launch with vault trust: every vault the config already knows is trusted (trust.mjs).
    try {
      migrateTrust();
    } catch (err) {
      console.error("[noteblock] trust migration failed:", err.message);
    }
    try {
      setVault(initialVault());
    } catch (err) {
      dialog.showErrorBox(`Could not open your ${BRAND.name} vault`, String((err && err.message) || err));
      app.quit();
      return;
    }

    const pageStorage = createPageStorage({ BrowserWindow, userData: app.getPath("userData") });
    registerQuireProtocol(protocol, () => vault, {
      proxyPort: (v, page) => proxyPort(v, page),
      onEntry: (page) => ensureBackend(vault, page).catch((err) => console.error("[quire] backend:", err.message)),
      extraHead: (v, id) => pageStorage.extraHead(v, id),
      // Restricted (or not yet answered): pages stay on their own origin. Trusted: no CSP, as before.
      csp: (v) => (vaultTrust(v) === TRUSTED ? null : restrictedCsp()),
    });
    // A page may fetch only its own origin and the runtime (protocol.mjs originGuard).
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      if (!details.url.startsWith("quire:")) return cb({});
      let initiator = null;
      try {
        initiator = details.frame ? details.frame.origin : null;
      } catch {}
      const ok = originGuard({ url: details.url, resourceType: details.resourceType, initiator });
      if (!ok && process.env.QUIRE_LOG_GUARD) console.log("[quire] refused cross-page request", details.resourceType, details.url, "from", initiator);
      cb({ cancel: !ok });
    });
    pageStorage.warm();
    onBackendStatus((status) => send("backend-status", status));
    // A new command from outside this app (a sync, another program) waits for the person: trust.mjs.
    onTrustRequest((req) => send("trust-request", req));

    floating = createFloating({
      preload: PRELOAD,
      htmlFile: FLOATING_HTML,
      devUrl: process.env.QUIRE_DEV_URL || null,
      getVault: () => vault,
      shell,
      isExternal,
      disabled: !!process.env.QUIRE_CAPTURE,
    });

    const ctx = {
      dialog,
      Menu,
      shell,
      rebuildMenu: (opts) => buildMenu(opts),
      getVault: () => vault,
      setVault,
      notifyBuild,
      getWindow: () => win,
      floating,
      devtools,
      pageStorage,
      // To every window, main ones and the floating note (Noteblock AI's ai-event).
      broadcast: (channel, ...args) => send(channel, ...args),
      // A write from one window (main or floating note): the other one reloads that page.
      onPageWritten: (pagePath, sender) => {
        for (const wc of [...[...wins].filter((w) => !w.isDestroyed()).map((w) => w.webContents), floating.webContents()]) {
          if (wc && wc !== sender) wc.send("page-files-changed", pagePath);
        }
      },
      dev: DEV ? devLabel() : null,
      next: NEXT,
    };
    // Capture the openVault handler for the menu by registering through a recording ipcMain.
    registerIpc(
      {
        handle: (channel, fn) => {
          if (channel === "quire:openVault") {
            openVaultHandler = async () => {
              const res = await fn(null);
              if (res && res.error) throw new Error(res.error);
            };
          }
          ipcMain.handle(channel, fn);
        },
      },
      ctx,
    );

    // Windows: the menu button in the sidebar (Sidebar.jsx) pops the app menu up under itself.
    ipcMain.handle("quire:popupAppMenu", (event, x, y) => {
      popupAppMenu(BrowserWindow.fromWebContents(event.sender), Number(x) || 18, Number(y) || 50);
      return { ok: true };
    });

    if (DEV) app.dock?.setIcon(path.join(REPO_ROOT, "build", "icon-dev.png"));
    buildMenu();
    createWindow();
    linksReady = true;
    if (pendingLink) {
      const link = pendingLink;
      pendingLink = null;
      openLink(link);
    }
    floating.register();
    const built = readVersion();
    app.setAboutPanelOptions({ applicationName: app.name, applicationVersion: app.getVersion(), version: built?.sha ? built.sha.slice(0, 7) : "" });
    // Packaged builds only; a capture run checks too when QUIRE_UPDATE_URL points it at a test feed.
    if (!DEV && (!process.env.QUIRE_CAPTURE || process.env.QUIRE_UPDATE_URL)) startUpdateChecks((status) => send("update-status", status));

    app.on("activate", () => {
      if (!wins.size) createWindow();
    });
    app.dock?.setMenu(Menu.buildFromTemplate([{ label: "New Window", click: () => createWindow({ fresh: !!win }) }]));
    // Windows: the same New window in the taskbar jump list (a second instance hands it over).
    if (WIN && app.isPackaged && !process.env.QUIRE_CAPTURE) {
      try {
        app.setUserTasks([{ program: process.execPath, arguments: "--new-window", iconPath: process.execPath, iconIndex: 0, title: "New window", description: `Open another ${BRAND.name} window` }]);
      } catch (err) {
        console.error("[quire] jump list:", err.message);
      }
    }
  });

  // Mac apps stay in the Dock. Elsewhere the last MAIN window closing decides (afterLastWindow,
  // from each window's "closed"): the hidden floating note and inspector windows don't count,
  // so this event alone can't tell.
  app.on("window-all-closed", () => {});

  // app.exit() (capture runs, a crash) skips will-quit: page backends still go.
  process.on("exit", killAllBackendsNow);

  app.on("will-quit", () => {
    killAllBackendsNow();
    if (stopWatch) stopWatch();
    flushAutosaves();
  });
}
