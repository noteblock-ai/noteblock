// Shortcut priority (app/main/keys.mjs): the accelerator matcher and the Quire-first / page-first
// decision, in plain node (no Electron).
import assert from "node:assert/strict";
import { parseAccelerator, matchesAccelerator, decide, quireKeyItems, shortcutIdFor } from "../app/main/keys.mjs";

const key = (k, code, mods = {}) => ({ type: "keyDown", key: k, code, meta: false, control: false, alt: false, shift: false, ...mods });
const mac = "darwin";
const linux = "linux";

// Parsing.
assert.deepEqual(parseAccelerator("CmdOrCtrl+P", mac), { meta: true, control: false, alt: false, shift: false, code: "KeyP", letter: "p" });
assert.equal(parseAccelerator("CmdOrCtrl+P", linux).control, true);
assert.equal(parseAccelerator("CmdOrCtrl+P", linux).meta, false);
assert.deepEqual(parseAccelerator("CmdOrCtrl+Ctrl+N", mac), { meta: true, control: true, alt: false, shift: false, code: "KeyN", letter: "n" });
assert.equal(parseAccelerator("Shift+CmdOrCtrl+]", mac).code, "BracketRight");
assert.equal(parseAccelerator("CmdOrCtrl+}", mac).shift, true);
assert.equal(parseAccelerator("CmdOrCtrl+}", mac).code, "BracketRight");
assert.equal(parseAccelerator("CmdOrCtrl+,", mac).code, "Comma");
assert.equal(parseAccelerator("CmdOrCtrl++", mac).code, "Equal");
assert.equal(parseAccelerator("CmdOrCtrl+Plus", mac).shift, true);
assert.equal(parseAccelerator("Ctrl+Tab", mac).code, "Tab");
assert.equal(parseAccelerator("F5", mac).code, "F5");
assert.equal(parseAccelerator("Alt+Return", mac).code, "Enter");
assert.equal(parseAccelerator("Hyper+P", mac), null);
assert.equal(parseAccelerator("", mac), null);

// Matching.
assert.ok(matchesAccelerator(key("p", "KeyP", { meta: true }), "CmdOrCtrl+P", mac));
assert.ok(!matchesAccelerator(key("p", "KeyP", { meta: true, shift: true }), "CmdOrCtrl+P", mac), "extra Shift");
assert.ok(!matchesAccelerator(key("p", "KeyP", { control: true }), "CmdOrCtrl+P", mac), "Ctrl isn't Cmd on a Mac");
assert.ok(matchesAccelerator(key("p", "KeyP", { control: true }), "CmdOrCtrl+P", linux));
assert.ok(matchesAccelerator(key("N", "KeyN", { meta: true, shift: true }), "CmdOrCtrl+Shift+N", mac));
assert.ok(matchesAccelerator(key("n", "KeyN", { meta: true, control: true }), "CmdOrCtrl+Ctrl+N", mac));
// Dvorak: the key labelled P sits on KeyR. ⌘P follows the label, ⌘R doesn't fire.
assert.ok(matchesAccelerator(key("p", "KeyR", { meta: true }), "CmdOrCtrl+P", mac));
assert.ok(!matchesAccelerator(key("p", "KeyR", { meta: true }), "CmdOrCtrl+R", mac));
// Cyrillic / ⌥ glyphs: fall back to the physical key.
assert.ok(matchesAccelerator(key("з", "KeyP", { meta: true }), "CmdOrCtrl+P", mac));
assert.ok(matchesAccelerator(key("π", "KeyP", { meta: true, alt: true }), "Alt+CmdOrCtrl+P", mac));
// Brackets, comma, digits go by code, whatever character the layout types.
assert.ok(matchesAccelerator(key("}", "BracketRight", { meta: true, shift: true }), "Shift+CmdOrCtrl+]", mac));
assert.ok(matchesAccelerator(key("{", "BracketLeft", { meta: true, shift: true }), "Shift+CmdOrCtrl+[", mac));
assert.ok(matchesAccelerator(key("ü", "BracketLeft", { meta: true, shift: true }), "Shift+CmdOrCtrl+[", mac), "German layout");
assert.ok(!matchesAccelerator(key("]", "BracketRight", { meta: true }), "Shift+CmdOrCtrl+]", mac));
assert.ok(matchesAccelerator(key(",", "Comma", { meta: true }), "CmdOrCtrl+,", mac));
assert.ok(matchesAccelerator(key(";", "Comma", { meta: true }), "CmdOrCtrl+,", mac), "AZERTY comma key");
assert.ok(matchesAccelerator(key("&", "Digit1", { meta: true }), "CmdOrCtrl+1", mac), "AZERTY digit row");
assert.ok(matchesAccelerator(key("Tab", "Tab", { control: true }), "Ctrl+Tab", mac));
assert.ok(matchesAccelerator(key("Tab", "Tab", { control: true, shift: true }), "Ctrl+Shift+Tab", mac));
assert.ok(!matchesAccelerator(key("Tab", "Tab", { control: true }), "Ctrl+Shift+Tab", mac));

// Ids for menu items.
assert.equal(shortcutIdFor({ label: "Command Palette…" }), "command-palette");
assert.equal(shortcutIdFor({ label: "New Page from Template…" }), "new-from-template");
assert.equal(shortcutIdFor({ label: "Settings…" }), "settings");
assert.equal(shortcutIdFor({ label: "Next Tab" }), "next-tab");
assert.equal(shortcutIdFor({ label: "Tab 3" }), "tab-3");

// A fake app menu shaped like main.mjs's.
const clicked = [];
const it = (label, accelerator, extra = {}) => ({ label, accelerator, type: "normal", enabled: true, click: () => clicked.push(label), ...extra });
const menu = {
  items: [
    { label: "Quire", submenu: { items: [it("Settings…", "CmdOrCtrl+,"), it("Quit", "CmdOrCtrl+Q", { role: "quit" })] } },
    {
      label: "File",
      submenu: {
        items: [it("New Page", "CmdOrCtrl+N"), it("Move to Trash", "CmdOrCtrl+Backspace", { registerAccelerator: false }), it("Close Tab", "CmdOrCtrl+W")],
      },
    },
    { label: "Edit", submenu: { items: [it("Undo", "CmdOrCtrl+Z", { role: "undo" }), it("Copy", "CmdOrCtrl+C", { role: "copy" })] } },
    {
      label: "View",
      submenu: {
        items: [
          it("Command Palette…", "CmdOrCtrl+P"),
          it("Next Tab", "Shift+CmdOrCtrl+]"),
          it("Next Tab", "Ctrl+Tab", { visible: false }),
          it("Tab 1", "CmdOrCtrl+1", { visible: false }),
          it("Save-ish", "CmdOrCtrl+S"),
          it("Bare F5", "F5"),
          it("Reload", "CmdOrCtrl+R", { role: "reload" }),
        ],
      },
    },
  ],
};
const items = quireKeyItems(menu);
assert.deepEqual(
  items.map((i) => i.id),
  ["settings", "new-page", "close-tab", "command-palette", "next-tab", "next-tab", "tab-1", "save-ish", "bare-f5"],
);

const quire = { default: "quire", overrides: {} };
const page = { default: "page", overrides: {} };
const cmdP = key("p", "KeyP", { meta: true });
const opt = (priority, extra = {}) => ({ priority, platform: mac, ...extra });
assert.equal(decide(cmdP, items, opt(quire))?.id, "command-palette");
assert.equal(decide(cmdP, items, opt(page)), null);
assert.equal(decide(cmdP, items, opt({ default: "quire", overrides: { "command-palette": "page" } })), null);
assert.equal(decide(cmdP, items, opt({ default: "page", overrides: { "command-palette": "quire" } }))?.id, "command-palette");
assert.equal(decide(cmdP, items, opt(quire, { suspended: true })), null, "Settings is recording");
assert.equal(decide({ ...cmdP, type: "keyUp" }, items, opt(quire)), null);
assert.equal(decide(key("Tab", "Tab", { control: true }), items, opt(quire))?.id, "next-tab");
assert.equal(decide(key("&", "Digit1", { meta: true }), items, opt(quire))?.id, "tab-1");
assert.equal(decide(key(",", "Comma", { meta: true }), items, opt(quire))?.id, "settings");
// Never taken: editor keys, role items, window-handled keys, keys with no ⌘/Ctrl.
assert.equal(decide(key("s", "KeyS", { meta: true }), items, opt(quire)), null, "⌘S stays with the page");
assert.equal(decide(key("z", "KeyZ", { meta: true }), items, opt(quire)), null);
assert.equal(decide(key("c", "KeyC", { meta: true }), items, opt(quire)), null);
assert.equal(decide(key("r", "KeyR", { meta: true }), items, opt(quire)), null, "role item");
assert.equal(decide(key("Backspace", "Backspace", { meta: true }), items, opt(quire)), null, "⌘⌫ is the window's");
assert.equal(decide(key("F5", "F5"), items, opt(quire)), null, "no ⌘/Ctrl");
assert.equal(decide(key("p", "KeyP"), items, opt(quire)), null);
assert.equal(clicked.length, 0);

// Windows defaults (shortcuts.mjs) and shortcut labels (renderer platform.js).
{
  const { shortcutTable } = await import("../app/main/shortcuts.mjs");
  const { formatAccelerator } = await import("../app/renderer/src/platform.js");
  const def = (p, id) => shortcutTable(p).find((s) => s.id === id).default;
  assert.equal(def("darwin", "new-folder"), "CmdOrCtrl+Ctrl+N", "Mac defaults unchanged");
  assert.equal(def("darwin", "developer-tools"), "CmdOrCtrl+Alt+J");
  assert.equal(def("win32", "new-from-template"), "Ctrl+Shift+A");
  assert.equal(def("win32", "new-folder"), "Ctrl+Shift+D");
  assert.equal(def("win32", "developer-tools"), "F12");
  assert.equal(def("win32", "app-developer-tools"), "Ctrl+Shift+I");
  assert.equal(def("win32", "command-palette"), "CmdOrCtrl+P");
  const ids = shortcutTable("win32").map((s) => s.default);
  assert.equal(new Set(ids).size, ids.length, "no two Windows defaults clash");
  assert.equal(formatAccelerator("CmdOrCtrl+Shift+N", "darwin"), "⇧⌘N");
  assert.equal(formatAccelerator("CmdOrCtrl+Ctrl+N", "darwin"), "⌃⌘N");
  assert.equal(formatAccelerator("Shift+CmdOrCtrl+N", "win32"), "Ctrl+Shift+N");
  assert.equal(formatAccelerator("Alt+CmdOrCtrl+I", "win32"), "Ctrl+Alt+I");
  assert.equal(formatAccelerator("CmdOrCtrl+Enter", "win32"), "Ctrl+Enter");
  assert.equal(formatAccelerator("F12", "win32"), "F12");
  assert.equal(formatAccelerator("CmdOrCtrl++", "win32"), "Ctrl++");
}

console.log("keys smoke ok");
