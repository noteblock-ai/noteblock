// Keyboard shortcuts: Electron accelerators kept in ~/.noteblock/config.json under "shortcuts"
// (only the ones that differ from the defaults). The app menu is built from these.
import { loadConfig, saveConfig } from "../../core/index.mjs";

// `win`: the default on Windows (and Linux) where the Mac one can't work there. ⌃⌘N is Ctrl+Ctrl+N
// off the Mac, and Ctrl+Alt+<letter> is AltGr on many keyboards (it types ń on a Polish one).
const TABLE = [
  { id: "command-palette", label: "Command palette", default: "CmdOrCtrl+P" },
  { id: "new-page", label: "New page", default: "CmdOrCtrl+N" },
  { id: "new-from-template", label: "New page from template", default: "CmdOrCtrl+Alt+N", win: "Ctrl+Shift+A" },
  { id: "new-folder", label: "New folder", default: "CmdOrCtrl+Ctrl+N", win: "Ctrl+Shift+D" },
  { id: "new-tab", label: "New tab", default: "CmdOrCtrl+T" },
  { id: "new-window", label: "New window", default: "CmdOrCtrl+Shift+N" },
  { id: "close-tab", label: "Close tab", default: "CmdOrCtrl+W" },
  { id: "next-tab", label: "Next tab", default: "Shift+CmdOrCtrl+]" },
  { id: "prev-tab", label: "Previous tab", default: "Shift+CmdOrCtrl+[" },
  { id: "back", label: "Back", default: "CmdOrCtrl+[", win: "Alt+Left" },
  { id: "forward", label: "Forward", default: "CmdOrCtrl+]", win: "Alt+Right" },
  { id: "toggle-source", label: "Cycle view", default: "CmdOrCtrl+E" },
  { id: "toggle-sidebar", label: "Toggle sidebar", default: "CmdOrCtrl+\\" },
  { id: "find", label: "Find", default: "CmdOrCtrl+F" },
  { id: "ai-bar", label: "Noteblock AI", default: "CmdOrCtrl+J" },
  { id: "developer-tools", label: "Inspect page", default: "CmdOrCtrl+Alt+J", win: "F12" },
  { id: "app-developer-tools", label: "App developer tools", default: "Alt+CmdOrCtrl+I", win: "Ctrl+Shift+I" },
  { id: "open-vault", label: "Open vault", default: "CmdOrCtrl+O" },
  { id: "settings", label: "Settings", default: "CmdOrCtrl+," },
];

/** The shortcut table with each default for `platform` (the Mac defaults on darwin, unchanged). */
export function shortcutTable(platform = process.platform) {
  return TABLE.map(({ win, ...s }) => (platform !== "darwin" && win ? { ...s, default: win } : s));
}

export const SHORTCUTS = shortcutTable();

function overrides() {
  const s = loadConfig().shortcuts;
  return s && typeof s === "object" ? s : {};
}

/** Accelerator for an action ("" = no shortcut). */
export function shortcutFor(id) {
  const o = overrides();
  if (typeof o[id] === "string") return o[id];
  return SHORTCUTS.find((s) => s.id === id)?.default || "";
}

export function shortcutList() {
  const { overrides: prio } = shortcutPriority();
  return SHORTCUTS.map((s) => ({ ...s, accelerator: shortcutFor(s.id), priority: prio[s.id] || null }));
}

// Who gets a shortcut first when a page also uses it (app/main/keys.mjs does the routing):
// config.json "shortcutPriority": "quire" (default, like a browser) | "page", and
// "shortcutPriorityOverrides": {<shortcut id>: "quire" | "page"} for single shortcuts.
const PRIORITIES = new Set(["quire", "page"]);

export function shortcutPriority(cfg = loadConfig()) {
  const raw = cfg.shortcutPriorityOverrides && typeof cfg.shortcutPriorityOverrides === "object" ? cfg.shortcutPriorityOverrides : {};
  const overrides = {};
  for (const [id, v] of Object.entries(raw)) if (PRIORITIES.has(v)) overrides[id] = v;
  return { default: cfg.shortcutPriority === "page" ? "page" : "quire", overrides };
}

/** value: "quire" | "page". */
export function setShortcutPriority(value) {
  if (!PRIORITIES.has(value)) throw new Error(`Unknown shortcut priority: ${value}`);
  const cfg = loadConfig();
  if (value === "quire") delete cfg.shortcutPriority;
  else cfg.shortcutPriority = value;
  saveConfig(cfg);
  return shortcutPriority();
}

/** One shortcut: "quire" | "page", or null to follow the default. */
export function setShortcutPriorityOverride(id, value) {
  if (!SHORTCUTS.some((s) => s.id === id)) throw new Error(`Unknown shortcut: ${id}`);
  if (value != null && !PRIORITIES.has(value)) throw new Error(`Unknown shortcut priority: ${value}`);
  const cfg = loadConfig();
  const next = { ...shortcutPriority(cfg).overrides };
  if (value == null) delete next[id];
  else next[id] = value;
  if (Object.keys(next).length) cfg.shortcutPriorityOverrides = next;
  else delete cfg.shortcutPriorityOverrides;
  saveConfig(cfg);
  return shortcutPriority();
}

/** Set one shortcut ("" clears it). Throws when another action already uses it. */
export function setShortcut(id, accelerator) {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown shortcut: ${id}`);
  const acc = String(accelerator || "");
  if (acc) {
    const clash = SHORTCUTS.find((s) => s.id !== id && shortcutFor(s.id) === acc);
    if (clash) throw new Error(`Already used by ${clash.label}`);
  }
  const cfg = loadConfig();
  const next = { ...overrides() };
  if (acc === def.default) delete next[id];
  else next[id] = acc;
  saveConfig({ ...cfg, shortcuts: next });
}

/** Every key back to its default, and every per-shortcut priority back to the default too. */
export function resetShortcuts() {
  const { shortcuts, shortcutPriorityOverrides, ...cfg } = loadConfig();
  saveConfig(cfg);
}
