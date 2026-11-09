// The OS the UI is drawn for, from the preload (window.quireApp.platform). Mac is the default,
// so a renderer without the bridge (tests, the browser view) looks like it always has.
export const platform = (typeof window !== "undefined" && window.quireApp && window.quireApp.platform) || "darwin";
export const isMac = platform === "darwin";
export const isWin = platform === "win32";

/** <html class="platform-darwin|platform-win32">: Windows-only CSS (title bar room, scrollbars). */
export function applyPlatformClass() {
  if (typeof document !== "undefined") document.documentElement.classList.add(`platform-${platform}`);
}

// One shortcut label for every place a shortcut is shown (palette, Settings, tooltips, hints):
// Mac glyphs (⇧⌘N) on a Mac, spelled out elsewhere (Ctrl+Shift+N). Takes an Electron
// accelerator ("CmdOrCtrl+Shift+N").
const MAC_MODS = { CmdOrCtrl: "⌘", CommandOrControl: "⌘", Command: "⌘", Cmd: "⌘", Ctrl: "⌃", Control: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Super: "⌘", Meta: "⌘" };
const MAC_KEYS = { Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "↩", Return: "↩", Backspace: "⌫", Delete: "⌦", Tab: "⇥" };
const MAC_ORDER = ["Ctrl", "Control", "Alt", "Option", "Shift", "CmdOrCtrl", "CommandOrControl", "Command", "Cmd", "Super", "Meta"];
const PC_MODS = { CmdOrCtrl: "Ctrl", CommandOrControl: "Ctrl", Ctrl: "Ctrl", Control: "Ctrl", Command: "Win", Cmd: "Win", Super: "Win", Meta: "Win", Alt: "Alt", Option: "Alt", Shift: "Shift" };
const PC_ORDER = ["Ctrl", "Win", "Alt", "Shift"];
const PC_KEYS = { Return: "Enter", Plus: "+" };

export function formatAccelerator(acc, os = platform) {
  if (!acc) return "";
  const parts = acc.endsWith("++") ? [...acc.slice(0, -2).split("+"), "+"] : String(acc).split("+");
  const key = parts.pop();
  if (os === "darwin") {
    const mods = parts.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)).map((m) => MAC_MODS[m] || m);
    return mods.join("") + (MAC_KEYS[key] || key);
  }
  const mods = [...new Set(parts.map((m) => PC_MODS[m] || m))].sort((a, b) => PC_ORDER.indexOf(a) - PC_ORDER.indexOf(b));
  return [...mods, PC_KEYS[key] || key].join("+");
}

/** Words that name the OS's own things: Finder / File Explorer, Trash / Recycle Bin. */
export const words = isWin
  ? { reveal: "Show in File Explorer", fileManager: "File Explorer", trash: "Recycle Bin", moveToTrash: "Move to Recycle Bin", computer: "this PC", computers: "this PC's" }
  : { reveal: "Reveal in Finder", fileManager: "Finder", trash: "Trash", moveToTrash: "Move to Trash", computer: "this Mac", computers: "this Mac's" };
