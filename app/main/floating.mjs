// Floating note: one small always-on-top window showing one vault page in the editor, toggled
// from anywhere by a global shortcut (like Raycast's Floating Notes). Any page works (HTML,
// markdown, app pages) because the window hosts the same quire:// page iframe the main window
// does (renderer/floating.html → src/Floating.jsx). The default page, "Floating note" in the
// vault root, is created the first time the window opens (floating-page.mjs).
// Settings live in ~/.noteblock/config.json under "floating": {enabled, shortcut, page, bounds}.
//
// Windows: the same window (frameless, always on top, no taskbar button), minus the Mac-only
// parts: no panel, no setVisibleOnAllWorkspaces. Showing it takes
// keyboard focus with show + focus, and a topmost toggle when Windows' foreground lock
// refused; hiding it lets Windows hand focus to the window below, which is the app it was
// opened from. With the note enabled, Quire stays in the tray after its last window closes
// (main.mjs), so the shortcut keeps working.
import fs from "node:fs";
import { app, autoUpdater as nativeUpdater, BrowserWindow, globalShortcut, screen } from "electron";
import { loadConfig, saveConfig, findPage } from "../../core/index.mjs";
import { scheduleAutosave } from "./autosave.mjs";
import { DEFAULT_FLOATING_PAGE, createFloatingNote, resolveFloatingPage } from "./floating-page.mjs";
import { SHORTCUTS, shortcutFor } from "./shortcuts.mjs";
import { BRAND } from "../../core/brand.mjs";
import { attachEditMenu } from "./spelling.mjs";

export { DEFAULT_FLOATING_PAGE };
// Quire Dev gets its own default so it can run next to the installed app.
// On Windows CmdOrCtrl is Ctrl: Ctrl+Shift+Space.
export const DEFAULT_FLOATING_SHORTCUT = app.isPackaged ? "CmdOrCtrl+Shift+Space" : "CmdOrCtrl+Alt+Shift+Space";
const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";
const DEFAULT_SIZE = { width: 380, height: 460 };

/**
 * True for an accelerator whose only modifiers are Alt/Option (and Shift). Electron registers
 * those as global hotkeys but macOS never delivers them (checked 2026-10-22 on macOS 26: ⌥M
 * and ⌥; registered fine and never fired; ⌥⌘⇧Space fired). Apps like Raycast get ⌥ shortcuts
 * through an Accessibility event tap, which Quire doesn't have.
 */
export function optionOnly(acc) {
  const parts = String(acc).split("+").map((p) => p.trim().toLowerCase());
  const mods = new Set(parts.slice(0, -1));
  const strong = ["cmd", "command", "cmdorctrl", "commandorcontrol", "ctrl", "control", "super", "meta"].some((m) => mods.has(m));
  return !strong && (mods.has("alt") || mods.has("option") || mods.has("altgr"));
}

/** Windows keeps every Win-key combination for itself; RegisterHotKey refuses or never fires them. */
export function usesWinKey(acc) {
  const mods = String(acc).split("+").slice(0, -1).map((p) => p.trim().toLowerCase());
  return mods.some((m) => m === "super" || m === "meta" || m === "cmd" || m === "command");
}

/** Why `acc` can't be the global shortcut on this OS, or "" when it can. */
export function globalShortcutProblem(acc, platform = process.platform) {
  if (!acc) return "";
  if (platform === "darwin" && optionOnly(acc)) return `A global shortcut needs ⌘ or ⌃. macOS doesn't pass ⌥-only shortcuts to ${BRAND.name}.`;
  if (platform === "win32" && usesWinKey(acc)) return "Windows keeps shortcuts with the Windows key for itself. Use Ctrl or Alt.";
  return "";
}

/** The "floating" block of config.json with defaults filled in. picked: a page was ever chosen. */
export function floatingConfig() {
  const f = loadConfig().floating;
  const c = f && typeof f === "object" ? f : {};
  return {
    enabled: c.enabled !== false,
    shortcut: typeof c.shortcut === "string" ? c.shortcut : DEFAULT_FLOATING_SHORTCUT,
    page: typeof c.page === "string" && c.page ? c.page : DEFAULT_FLOATING_PAGE,
    picked: typeof c.page === "string" && !!c.page,
    bounds: c.bounds && typeof c.bounds === "object" ? c.bounds : null,
  };
}

function writeFloating(patch) {
  const cfg = loadConfig();
  const cur = cfg.floating && typeof cfg.floating === "object" ? cfg.floating : {};
  saveConfig({ ...cfg, floating: { ...cur, ...patch } });
}

/** Saved bounds, when they still land on a connected display. */
function usableBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40);
  return visible ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
}

/** Top-right corner of the display the pointer is on. */
function defaultBounds() {
  const { workArea: a } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return { ...DEFAULT_SIZE, x: a.x + a.width - DEFAULT_SIZE.width - 24, y: a.y + 24 };
}

/**
 * @param {{preload: string, htmlFile: string, devUrl?: string|null, getVault: () => string,
 *          shell: import("electron").Shell, isExternal: (url: string, frame?: import("electron").WebFrameMain) => boolean, disabled?: boolean}} opts
 *   disabled: never register the global shortcut (capture runs).
 */
export function createFloating(opts) {
  /** @type {BrowserWindow | null} */
  let win = null;
  let registered = "";
  let suspended = false;
  let lastError = "";
  let quitting = false;
  /** Set when the note was opened from another app: {front, appWasHidden} (only used on the Mac). */
  let boundsTimer = null;
  let picking = false;

  app.on("before-quit", () => {
    quitting = true;
  });
  // quitAndInstall closes every window BEFORE before-quit fires (Electron docs), so without this
  // the close handler below would refuse, the windows never all close and the app never restarts.
  nativeUpdater.on("before-quit-for-update", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    if (registered) globalShortcut.unregister(registered);
    registered = "";
  });

  const alive = () => win && !win.isDestroyed();

  function send(channel, ...args) {
    if (alive()) win.webContents.send(channel, ...args);
  }

  /** (Re)register the global shortcut from config. Sets lastError when it can't. */
  function register() {
    if (registered) {
      try {
        globalShortcut.unregister(registered);
      } catch {}
      registered = "";
    }
    lastError = "";
    const c = floatingConfig();
    if (opts.disabled || suspended || !c.enabled || !c.shortcut) return;
    const problem = globalShortcutProblem(c.shortcut);
    if (problem) {
      lastError = problem;
      console.log(`[quire] floating note shortcut ${c.shortcut}: not registered (${problem})`);
      return;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(c.shortcut, toggle);
    } catch (err) {
      lastError = String(err?.message || err);
    }
    if (ok) registered = c.shortcut;
    else lastError ||= "Another app is using that shortcut";
    console.log(`[quire] floating note shortcut ${c.shortcut}: ${ok ? "registered" : "not registered (" + lastError + ")"}`);
  }

  function createWindow() {
    win = new BrowserWindow({
      ...(usableBounds(floatingConfig().bounds) || defaultBounds()),
      minWidth: 240,
      minHeight: 160,
      show: false,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // A non-activating panel on the Mac: the note takes the keyboard while the app you were in
      // stays frontmost, so Noteblock's main window doesn't come forward and an iTerm hotkey window
      // doesn't hide. The cost: window managers (Raycast, Rectangle) act on the frontmost app's
      // window, not the note. Rhett chose this on 2026-11-03; the activating version was 87645e5.
      ...(MAC ? { type: "panel" } : {}),
      title: "Floating note",
      backgroundColor: "#FFFFFF",
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Mac: above other apps' floating windows, such as an iTerm hotkey window.
    // Windows has one topmost band (the level only matters above "floating", where it would sit
    // over the taskbar and the Start menu): plain always-on-top there.
    if (MAC) win.setAlwaysOnTop(true, "pop-up-menu");
    else win.setAlwaysOnTop(true);
    // skipTransformProcessType: Electron would otherwise hide Quire's Dock icon (app.dock.hide())
    // to let the window onto other apps' full-screen Spaces. Mac only (Spaces).
    if (MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });

    const saveBounds = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (alive()) writeFloating({ bounds: win.getBounds() });
      }, 400);
    };
    // Also fires when Raycast, Rectangle & co. move it through the Accessibility API.
    win.on("resize", saveBounds);
    win.on("move", saveBounds);
    // Closing only hides it; it goes for real when the app quits.
    win.on("close", (e) => {
      if (quitting) return;
      e.preventDefault();
      hide();
    });
    win.on("closed", () => {
      win = null;
    });

    const wc = win.webContents;
    attachEditMenu(wc);
    // Esc and ⌘W hide the note (⌘W would otherwise close a tab in the main window).
    // While the page picker is open, Esc closes the picker instead.
    wc.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown") return;
      if (picking && input.key === "Escape") return;
      const plain = !input.meta && !input.control && !input.alt && !input.shift;
      const cmdW = (input.meta || input.control) && !input.alt && !input.shift && String(input.key).toLowerCase() === "w";
      if ((input.key === "Escape" && plain) || cmdW) {
        e.preventDefault();
        hide();
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) opts.shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("will-frame-navigate", (event) => {
      if (opts.isExternal(event.url, event.frame)) {
        event.preventDefault();
        opts.shell.openExternal(event.url);
      }
    });

    if (opts.devUrl) win.loadURL(new URL("floating.html", opts.devUrl).toString());
    else win.loadFile(opts.htmlFile);
    return win;
  }

  /**
   * Windows' foreground lock can refuse focus to a background app. A hotkey press usually counts
   * as input to Quire, but when it didn't, re-asserting topmost and focusing again brings it to
   * the front with the keyboard. The Mac's panel needs none of this.
   */
  function activate() {
    if (!WIN || !alive() || !win.isVisible() || opts.disabled || win.isFocused()) return;
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true);
    win.moveTop();
    win.focus();
    win.webContents.focus();
  }

  function show() {
    if (!alive()) {
      createWindow();
      win.once("ready-to-show", () => {
        if (!alive()) return;
        win.show();
        win.focus();
        activate();
      });
      return;
    }
    win.show();
    win.focus();
    activate();
    send("floating-shown");
  }

  function hide() {
    if (!alive() || !win.isVisible()) return;
    // The Mac's panel never activated Noteblock, so the app underneath still has the focus. On
    // Windows, hide activates the next window down, the app it was opened from.
    win.hide();
  }

  function toggle() {
    if (alive() && win.isVisible() && win.isFocused()) hide();
    else show();
  }

  /**
   * The page the note shows: {path, title, build, renderer}, or {missing: page} when the
   * configured page is gone. With no page picked yet, "Floating note" is created and saved.
   */
  function resolvePage() {
    const vault = opts.getVault();
    const c = floatingConfig();
    const r = resolveFloatingPage(vault, c.picked ? c.page : null);
    if (r.missing) return { missing: r.missing };
    if (r.created) scheduleAutosave(vault, r.node.path);
    if (!c.picked) writeFloating({ page: r.node.path });
    const n = r.node;
    return { path: n.path, id: n.id || null, title: n.title, build: !!n.build, renderer: n.renderer || "quire" };
  }

  /** "New floating note": a fresh note in the vault root (de-duped name), now the note's page. */
  function newNote() {
    const vault = opts.getVault();
    const node = createFloatingNote(vault);
    scheduleAutosave(vault, node.path);
    writeFloating({ page: node.path });
    send("floating-changed");
    return resolvePage();
  }

  function getConfig() {
    const c = floatingConfig();
    let pageExists = false;
    try {
      pageExists = !!findPage(opts.getVault(), c.page);
    } catch {}
    return {
      platform: process.platform,
      enabled: c.enabled,
      shortcut: c.shortcut,
      default: DEFAULT_FLOATING_SHORTCUT,
      page: c.page,
      defaultPage: DEFAULT_FLOATING_PAGE,
      pageExists,
      registered: !!registered,
      error: lastError,
      open: !!(alive() && win.isVisible()),
    };
  }

  /** patch: {enabled?, shortcut?, page?}. A shortcut another app holds is refused. */
  function setConfig(patch = {}) {
    const prev = floatingConfig();
    const next = {};
    if ("enabled" in patch) next.enabled = !!patch.enabled;
    if ("page" in patch) {
      const p = String(patch.page || "") || DEFAULT_FLOATING_PAGE;
      let exists = true;
      try {
        findPage(opts.getVault(), p);
      } catch (err) {
        if (p !== DEFAULT_FLOATING_PAGE) throw err; // "No page: …"
        exists = false;
      }
      // The default page that isn't there yet: unpicked, so it's created when the note opens.
      next.page = exists ? p : null;
    }
    if ("shortcut" in patch) {
      const acc = String(patch.shortcut || "");
      const problem = globalShortcutProblem(acc);
      if (problem) throw new Error(problem);
      const clash = acc && SHORTCUTS.find((s) => shortcutFor(s.id) === acc);
      if (clash) throw new Error(`Already used by ${clash.label}`);
      next.shortcut = acc;
    }
    writeFloating(next);
    register();
    if ("shortcut" in next && next.shortcut && !registered && !suspended && floatingConfig().enabled && !opts.disabled) {
      const err = lastError;
      writeFloating({ shortcut: prev.shortcut });
      register();
      throw new Error(err || "Another app is using that shortcut");
    }
    if ("page" in next && (next.page || DEFAULT_FLOATING_PAGE) !== prev.page) send("floating-changed");
    if (next.enabled === false) hide();
    return getConfig();
  }

  /** While Settings records a key, the global shortcut must not fire. */
  function suspend(on) {
    if (suspended === !!on) return;
    suspended = !!on;
    register();
  }

  /**
   * Capture runs (QUIRE_OPEN_FLOATING=1): render the note hidden and save a PNG of it.
   * menu: menu actions sent to the note first; evalJs: runs in the note window after them.
   * hold: ms to keep the window ordered in at opacity 0 (so the AX API can read it) first.
   */
  async function capture(file, { menu = [], evalJs = "", hold = 0, delay = 2500 } = {}) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!alive()) createWindow();
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    await wait(delay);
    if (hold) {
      win.setOpacity(0);
      win.showInactive();
      console.log("[quire-ax] pid", process.pid);
      await wait(hold);
    }
    for (const action of menu) {
      send("menu", action);
      await wait(500);
    }
    if (evalJs) {
      const out = await win.webContents.executeJavaScript(evalJs).catch((e) => "error: " + e.message);
      console.log("[quire-eval-floating]", JSON.stringify(out));
      await wait(1200);
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
  }

  return {
    capture,
    register,
    newNote,
    /** The note's page picker is open: Esc closes it instead of hiding the note. */
    setPicking: (on) => {
      picking = !!on;
    },
    /** True when bw is the note's window (menu items act on it when it's focused). */
    owns: (bw) => !!bw && alive() && bw === win,
    show,
    hide,
    toggle,
    send,
    suspend,
    resolvePage,
    getConfig,
    setConfig,
    /** The vault changed: the note shows that vault's page. */
    vaultChanged: () => send("floating-changed"),
    webContents: () => (alive() ? win.webContents : null),
  };
}
