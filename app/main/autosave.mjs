// Autosave commits: 5 s after the last app write, `Edit <pages>`. Never while any lock exists,
// so an agent's in-progress files never land in an app commit.
//
// The file write itself happens right away (ipc.mjs); only the commit waits. The commit runs
// git async (commitAllAsync): a sync git call in the main process blocks the browser process,
// so keystrokes stall for the whole commit (~200-300 ms on a 5k-file vault). One commit at a
// time per vault; writes that land mid-commit get the next one. flushAutosaves stays sync for
// quit and explicit actions; flushAutosavesAsync is for anything that runs while typing (sync).
import { commitAll, commitAllAsync, listLocks } from "../../core/index.mjs";

export const AUTOSAVE_DELAY = 5000;

/** @type {Map<string, {timer: NodeJS.Timeout|null, pages: Set<string>, running: Promise<void>|null}>} */
const pending = new Map();
let afterCommit = () => {};

/** Called after each autosave commit (sync uses it to push soon after an edit). */
export function onAutosaveCommit(fn) {
  afterCommit = fn;
}

function entry(vault) {
  let e = pending.get(vault);
  if (!e) {
    e = { timer: null, pages: new Set(), running: null };
    pending.set(vault, e);
  }
  return e;
}

/**
 * Schedule (or push back) an autosave for this vault.
 * @param {string} vault
 * @param {string|null} [pagePath] named in the commit message; null for data-only writes
 */
export function scheduleAutosave(vault, pagePath = null) {
  const e = entry(vault);
  if (pagePath) e.pages.add(pagePath);
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => run(vault), AUTOSAVE_DELAY);
}

function message(pages) {
  return pages.size ? `Edit ${[...pages].join(", ")}` : "Edit pages";
}

function locked(vault) {
  try {
    return listLocks(vault).length > 0;
  } catch {
    return false;
  }
}

/** Start an async commit of what's on disk now; resolves when it (and nothing else) is done. */
function commitNow(vault, e) {
  const pages = e.pages;
  e.pages = new Set();
  const job = commitAllAsync(vault, message(pages))
    .then((sha) => {
      if (sha) afterCommit(vault);
    })
    .catch((err) => {
      console.error("[quire] autosave commit failed:", err.message);
      // Keep the page names for the retry the next write (or flush) brings.
      for (const p of pages) e.pages.add(p);
    })
    .finally(() => {
      if (e.running === job) e.running = null;
    });
  e.running = job;
  return job;
}

function run(vault) {
  const e = entry(vault);
  e.timer = null;
  if (locked(vault)) {
    e.timer = setTimeout(() => run(vault), AUTOSAVE_DELAY);
    return;
  }
  if (e.running) {
    // Previous commit still going: try again once it's done.
    e.running.then(() => {
      if (!e.timer && !e.running) run(vault);
    });
    return;
  }
  commitNow(vault, e);
}

/**
 * Commit everything pending without blocking the main process (sync uses it before a push).
 * Waits for a commit already in flight. Skips vaults with locks.
 */
export async function flushAutosavesAsync(vault = null) {
  for (const [v, e] of pending) {
    if (vault && v !== vault) continue;
    if (e.running) await e.running;
    if (!e.timer) continue;
    if (locked(v)) continue;
    clearTimeout(e.timer);
    e.timer = null;
    await commitNow(v, e);
  }
}

/** Commit everything pending right now, synchronously (on quit). Skips vaults with locks. */
export function flushAutosaves() {
  for (const [vault, e] of pending) {
    // An async commit in flight holds the index lock at moments; git() waits that out, and
    // whatever it hasn't staged yet is committed here.
    if (!e.timer && !e.running) continue;
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    try {
      if (listLocks(vault).length) continue;
      commitAll(vault, message(e.pages));
      e.pages = new Set();
    } catch (err) {
      console.error("[quire] autosave commit failed:", err.message);
    }
  }
}
