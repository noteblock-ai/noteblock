// The one-time localStorage migration to per-page origins (origins.mjs).
//
// Before every page had its own origin they all shared `quire://vault`, so its localStorage
// held every page's keys, with no way to tell which page wrote which. On a page's first load on
// its own origin, the protocol puts a copy of all of them into the entry's head
// (protocol.mjs legacyStorageScript); the runtime copies the keys it doesn't have yet into the
// page's own localStorage before any page script runs, sets `quire:origin-migrated`, and tells
// main (`storage.migrated`), which stops sending the copy to that page.
//
// localStorage is partitioned by the top-level site, so the old data is read the way pages saw
// it: from a `quire://vault` frame inside a hidden file:// window, like the app window.
// IndexedDB is not migrated.
import fs from "node:fs";
import path from "node:path";
import { legacyStorageScript, LEGACY_STORAGE_PATH } from "./protocol.mjs";

let stateFile = null;
let state = { legacy: null, migrated: [] }; // legacy: null (unknown) | "empty" | "present"
let legacy = null; // Promise<string|null>: the old keys as JSON, read once per run

function save() {
  if (!stateFile) return;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    console.error("[quire] could not save page-origins state:", err.message);
  }
}

/** Read the old shared localStorage, once per run (null when there is none). */
function readLegacy(BrowserWindow, dir) {
  if (state.legacy === "empty") return Promise.resolve(null);
  if (legacy) return legacy;
  legacy = (async () => {
    const html = path.join(dir, "legacy-storage.html");
    fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><iframe src="quire://vault${LEGACY_STORAGE_PATH}"></iframe>`);
    const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await win.loadFile(html);
      let frame = null;
      for (let i = 0; i < 40 && !frame; i++) {
        frame = win.webContents.mainFrame.frames.find((f) => String(f.url).startsWith("quire://vault/")) || null;
        if (!frame) await new Promise((r) => setTimeout(r, 50));
      }
      if (!frame) throw new Error("no legacy frame");
      const json = await Promise.race([
        frame.executeJavaScript("(function(){var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k);}return JSON.stringify(o);})()"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 3000)),
      ]);
      const keys = Object.keys(JSON.parse(json || "{}"));
      state.legacy = keys.length ? "present" : "empty";
      save();
      return keys.length ? json : null;
    } catch (err) {
      console.error("[quire] could not read the old page localStorage:", err.message);
      legacy = null; // try again on the next page load
      return null;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  })();
  return legacy;
}

/**
 * @param {{BrowserWindow: typeof import("electron").BrowserWindow, userData: string}} opts
 * @returns {{extraHead: (vault: string, id: string) => Promise<string>, markMigrated: (id: string) => void, warm: () => void}}
 */
export function createPageStorage({ BrowserWindow, userData }) {
  stateFile = path.join(userData, "page-origins.json");
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state = { legacy: s.legacy || null, migrated: Array.isArray(s.migrated) ? s.migrated : [] };
  } catch {}
  return {
    /** Head markup for a page entry: the old keys, until that page has taken them. */
    async extraHead(_vault, id) {
      if (state.legacy === "empty" || state.migrated.includes(id)) return "";
      const json = await readLegacy(BrowserWindow, userData);
      return json ? legacyStorageScript(json) : "";
    },
    markMigrated(id) {
      if (!id || state.migrated.includes(id)) return;
      state.migrated.push(id);
      save();
    },
    /** Start reading the old data now, so the first page load doesn't wait for it. */
    warm() {
      readLegacy(BrowserWindow, userData).catch(() => {});
    },
  };
}
