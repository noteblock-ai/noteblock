// Folders and pages left out of search (⌘P, page pickers, the AI's page listing). They stay in
// the sidebar and open normally. Stored in the vault so they travel with sync:
// <vault>/.noteblock/settings.json, key searchExclude: ["Archive", "Old/Stuff"].
// Its own file because core/pages.mjs (listTree) needs it and core/vault.mjs imports pages.
import fs from "node:fs";
import path from "node:path";
import { metaPath, newMetaPath } from "./names.mjs";

const SETTINGS_FILE = "settings.json";

const clean = (p) => String(p ?? "").split("/").map((s) => s.trim()).filter(Boolean).join("/");

/** The outermost entry of `list` that covers `p` (p itself or an ancestor), or null. */
export function excludedBy(p, list) {
  const at = clean(p);
  if (!at) return null;
  let by = null;
  for (const raw of list || []) {
    const e = clean(raw);
    if (e && (at === e || at.startsWith(e + "/")) && (by === null || e.length < by.length)) by = e;
  }
  return by;
}

/** True when `p` is an entry of `list` or sits under one. "Archive" doesn't cover "Archive 2". */
export function isExcluded(p, list) {
  return excludedBy(p, list) !== null;
}

/** The vault's synced settings; {} when there are none or the file is unreadable. */
export function readVaultSettings(vault) {
  try {
    const s = JSON.parse(fs.readFileSync(metaPath(vault, SETTINGS_FILE), "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the vault's settings, keeping every other key. */
export function writeVaultSettings(vault, patch) {
  const file = newMetaPath(vault, SETTINGS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...readVaultSettings(vault), ...patch }, null, 2) + "\n");
}

/** The vault's excluded paths, cleaned: no blanks, dot segments or duplicates. */
export function readSearchExclude(vault) {
  const list = readVaultSettings(vault).searchExclude;
  if (!Array.isArray(list)) return [];
  const out = list.filter((e) => typeof e === "string").map(clean).filter((e) => e && !e.split("/").some((s) => s.startsWith(".")));
  return [...new Set(out)];
}

/**
 * Add `p` to the list (dropping entries it now covers) or remove it. Adding needs a folder or
 * page that exists; removing never does, so a stale entry can be cleared. Returns the new list.
 */
export function setSearchExcluded(vault, p, excluded) {
  const at = clean(p);
  if (!at || at.split("/").some((s) => s.startsWith("."))) throw new Error(`Bad path: ${p}`);
  const list = readSearchExclude(vault);
  let next;
  if (excluded) {
    let st = null;
    try {
      st = fs.statSync(path.join(vault, ...at.split("/")));
    } catch {}
    if (!st || !st.isDirectory()) throw new Error(`No page or folder ${at}`);
    if (isExcluded(at, list)) return list;
    next = [...list.filter((e) => !e.startsWith(at + "/")), at];
  } else {
    next = list.filter((e) => e !== at);
    if (next.length === list.length) return list;
  }
  writeVaultSettings(vault, { searchExclude: next });
  return next;
}

/** A page or folder moved: entries at or under `from` follow it. True when any did. */
export function moveSearchExclude(vault, from, to) {
  const list = readSearchExclude(vault);
  if (!list.some((e) => isExcluded(e, [from]))) return false;
  writeVaultSettings(vault, { searchExclude: [...new Set(list.map((e) => (isExcluded(e, [from]) ? to + e.slice(from.length) : e)))] });
  return true;
}

/** A page or folder is gone: its entries go too, or a new one with that name would inherit them. */
export function dropSearchExclude(vault, gone) {
  const list = readSearchExclude(vault);
  const next = list.filter((e) => !isExcluded(e, [gone]));
  if (next.length === list.length) return false;
  writeVaultSettings(vault, { searchExclude: next });
  return true;
}

/** Flag every node at or under an entry: searchExcluded, and searchExcludedBy (the entry). */
export function markSearchExcluded(nodes, list) {
  if (!list.length) return nodes;
  for (const n of nodes) {
    const by = excludedBy(n.path, list);
    if (by) {
      n.searchExcluded = true;
      n.searchExcludedBy = by;
    }
    markSearchExcluded(n.children || [], list);
  }
  return nodes;
}
