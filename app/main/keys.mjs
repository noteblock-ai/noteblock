// Shortcut priority: who gets a ⌘-key first when the focused page also listens for it.
//
// On macOS Chromium hands a ⌘-key to the focused page first and skips the menu item when the
// page calls preventDefault, so by itself a page can take ⌘P away from Quire. With priority
// "quire" (the default, like a browser) every window's before-input-event — which fires for
// keys typed inside page iframes too, out-of-process ones included — catches the key before the
// page sees it and runs the app menu item it belongs to. The menu is the one table: whatever
// item owns an accelerator, its own click handler runs, so both paths always agree.
//
// Never taken from a page: the Edit roles (undo, redo, cut, copy, paste, select all), ⌘S, any
// role item, items the window handles itself (registerAccelerator: false, e.g. ⌘⌫), keys with
// neither ⌘ nor Ctrl, and anything while Settings is recording a shortcut.
//
// No electron import here, so the matcher can be tested in plain node (scripts/smoke-keys.mjs).
import { SHORTCUTS, shortcutPriority } from "./shortcuts.mjs";

const MODS = {
  command: "cmd", cmd: "cmd", control: "ctrl", ctrl: "ctrl", commandorcontrol: "cmdorctrl", cmdorctrl: "cmdorctrl",
  alt: "alt", option: "alt", altgr: "alt", shift: "shift", super: "meta", meta: "meta",
};

// Punctuation and digits match on input.code (the physical key), like the menu on non-US layouts.
const CODES = {
  ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight",
  "\\": "Backslash", "-": "Minus", "=": "Equal", "`": "Backquote",
};
const SHIFTED = {
  "<": ",", ">": ".", "?": "/", ":": ";", '"': "'", "{": "[", "}": "]", "|": "\\", _: "-", "+": "=", plus: "=", "~": "`",
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
};
const NAMED = {
  tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", insert: "Insert", return: "Enter", enter: "Enter",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", escape: "Escape", esc: "Escape",
};

/**
 * Electron accelerator → {meta, control, alt, shift, code, letter?}, or null when it can't be
 * matched. platform decides what CmdOrCtrl means.
 */
export function parseAccelerator(acc, platform = process.platform) {
  if (!acc || typeof acc !== "string") return null;
  // "CmdOrCtrl++" / "CmdOrCtrl+Plus": a trailing "+" is the key itself.
  const parts = acc.endsWith("++") ? [...acc.slice(0, -2).split("+"), "+"] : acc.split("+");
  let rawKey = parts.pop();
  if (!rawKey) return null;
  const mac = platform === "darwin";
  const out = { meta: false, control: false, alt: false, shift: false, code: null, letter: null };
  for (const m of parts) {
    const kind = MODS[m.toLowerCase()];
    if (!kind) return null;
    if (kind === "cmd" || kind === "meta") out.meta = true;
    else if (kind === "ctrl") out.control = true;
    else if (kind === "cmdorctrl") out[mac ? "meta" : "control"] = true;
    else out[kind] = true;
  }
  const lower = rawKey.toLowerCase();
  if (SHIFTED[lower] !== undefined || SHIFTED[rawKey] !== undefined) {
    out.shift = true;
    rawKey = SHIFTED[rawKey] ?? SHIFTED[lower];
  }
  if (/^[a-z]$/i.test(rawKey)) {
    out.letter = rawKey.toLowerCase();
    out.code = "Key" + rawKey.toUpperCase();
  } else if (/^\d$/.test(rawKey)) out.code = "Digit" + rawKey;
  else if (CODES[rawKey]) out.code = CODES[rawKey];
  else if (/^f([1-9]|1\d|2[0-4])$/i.test(rawKey)) out.code = rawKey.toUpperCase();
  else if (NAMED[lower]) out.code = NAMED[lower];
  else return null;
  return out;
}

/**
 * Does a before-input-event input ({key, code, meta, control, alt, shift}) press this
 * accelerator? Letters follow the layout (input.key, so ⌘P is the key labelled P on Dvorak),
 * falling back to the physical key when the layout types something else (Cyrillic, ⌥ glyphs).
 */
export function matchesAccelerator(input, acc, platform = process.platform) {
  const a = typeof acc === "string" ? parseAccelerator(acc, platform) : acc;
  if (!a || !input) return false;
  if (!!input.meta !== a.meta || !!input.control !== a.control || !!input.alt !== a.alt || !!input.shift !== a.shift) return false;
  if (a.letter) {
    const k = String(input.key || "");
    if (/^[a-z]$/i.test(k)) return k.toLowerCase() === a.letter;
    return input.code === a.code;
  }
  if (a.code === "Enter") return input.code === "Enter" || input.code === "NumpadEnter";
  return input.code === a.code;
}

/** Keys the page editor owns, whatever the menu says. */
const NEVER = ["CmdOrCtrl+S", "CmdOrCtrl+Z", "CmdOrCtrl+Shift+Z", "Ctrl+Y", "CmdOrCtrl+X", "CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+A", "CmdOrCtrl+Shift+V", "CmdOrCtrl+Alt+Shift+V"];

const norm = (label) => String(label || "").replace(/…|\.\.\.$/g, "").trim().toLowerCase();
const BY_LABEL = new Map(SHORTCUTS.map((s) => [norm(s.label), s.id]));

/** Shortcut id for a menu item: its SHORTCUTS id (by label), "tab-3" for the hidden tab keys. */
export function shortcutIdFor(item) {
  const n = norm(item.label);
  if (BY_LABEL.has(n)) return BY_LABEL.get(n);
  const tab = /^tab (\d)$/.exec(n);
  if (tab) return "tab-" + tab[1];
  return n.replace(/[^a-z0-9]+/g, "-");
}

/** Menu items Quire may take a key for: [{id, accelerator, item}]. */
export function quireKeyItems(menu) {
  const out = [];
  (function walk(items) {
    for (const item of items || []) {
      if (item.submenu) walk(item.submenu.items);
      if (!item.accelerator || item.role || item.registerAccelerator === false || item.enabled === false) continue;
      if (item.type && item.type !== "normal") continue;
      out.push({ id: shortcutIdFor(item), accelerator: item.accelerator, item });
    }
  })(menu?.items);
  return out;
}

/**
 * The item Quire takes this key for, or null to leave it to the page (and then the menu).
 * opts: {priority: {default, overrides}, suspended, platform}.
 */
export function decide(input, items, { priority, suspended = false, platform = process.platform } = {}) {
  if (suspended || !input || input.type !== "keyDown") return null;
  if (!input.meta && !input.control) return null;
  if (NEVER.some((acc) => matchesAccelerator(input, acc, platform))) return null;
  const hit = items.find((it) => matchesAccelerator(input, it.accelerator, platform));
  if (!hit) return null;
  const p = (priority && priority.overrides && priority.overrides[hit.id]) || (priority && priority.default) || "quire";
  return p === "quire" ? hit : null;
}

let suspended = false;
/** While Settings records a shortcut, every key goes to Settings. */
export function suspendShortcutPriority(on) {
  suspended = !!on;
}

/**
 * Route Quire's shortcuts in every window (main and floating note) by priority. Call once,
 * before the first window: it hooks windows as they're created. Listeners go on after the
 * window's own (setImmediate), so a key the window already handled (the floating note's
 * Esc / ⌘W) is left alone.
 */
export function installShortcutPriority({ app, Menu, BrowserWindow }) {
  app.on("web-contents-created", (_e, wc) => {
    if (wc.getType() !== "window") return;
    setImmediate(() => {
      if (wc.isDestroyed()) return;
      wc.on("before-input-event", (event, input) => {
        if (event.defaultPrevented || suspended || input.type !== "keyDown" || (!input.meta && !input.control)) return;
        // A page inspector (page-devtools.mjs) keeps DevTools' own keys (⌘P opens a file there).
        if (/^devtools:/.test(wc.getURL())) return;
        const menu = Menu.getApplicationMenu();
        if (!menu) return;
        const hit = decide(input, quireKeyItems(menu), { priority: shortcutPriority() });
        if (!hit) return;
        event.preventDefault();
        try {
          hit.item.click(undefined, BrowserWindow.fromWebContents(wc), wc);
        } catch (err) {
          console.error("[quire] shortcut", hit.id, err);
        }
      });
    });
  });
}
