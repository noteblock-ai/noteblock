// Agent edit lock: lock + snapshot → edit files → done (commit) or abort (restore).
import fs from "node:fs";
import path from "node:path";
import { findPage, ensureManifest } from "./pages.mjs";
import { commitAll, authorFor } from "./git.mjs";
import { runBuildSync } from "./build.mjs";
import { allMetaPaths, metaPath, newMetaPath } from "./names.mjs";

// Locks and snapshots are written under <vault>/.noteblock/ and read from there or from an
// older install's <vault>/.quire/ (core/names.mjs).
function locksDir(vault) {
  return newMetaPath(vault, "locks");
}

function lockFile(vault, id) {
  return metaPath(vault, "locks", `${id}.json`);
}

/** Where a page's snapshot is: the new metadata dir's, else an older install's. */
export function snapshotDir(vault, id) {
  return metaPath(vault, "snapshots", id);
}

/** A page's own files: everything in its folder except data/ (personal, never snapshotted). */
function ownEntries(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && e.name === "data"))
    .map((e) => e.name);
}

/**
 * Who is editing, from the agent's environment: Claude Code, Codex, Cursor, else "An agent".
 * Shown in the app's banner ("Codex is editing this page") and used as the commit author.
 */
export function detectAgent(env = process.env) {
  const keys = Object.keys(env);
  const has = (prefix) => keys.some((k) => k.startsWith(prefix));
  if (env.CLAUDECODE === "1" || has("CLAUDE_CODE_")) return "Claude";
  if (env.CODEX_HOME || has("CODEX_")) return "Codex";
  if (has("CURSOR_")) return "Cursor";
  return "An agent";
}

export function getLock(vault, id) {
  if (!id) return null;
  try {
    return JSON.parse(fs.readFileSync(lockFile(vault, id), "utf8"));
  } catch {
    return null;
  }
}

export function listLocks(vault) {
  const names = new Set();
  for (const dir of allMetaPaths(vault, "locks")) {
    try {
      for (const n of fs.readdirSync(dir)) names.add(n);
    } catch {}
  }
  return [...names]
    .filter((n) => n.endsWith(".json"))
    .map((n) => getLock(vault, n.slice(0, -5)))
    .filter(Boolean);
}

/**
 * Lock a page for an agent and snapshot its own files.
 * @returns {{lock: object, dir: string}}
 */
export function beginEdit(vault, ref, { by = detectAgent(), message = "", force = false, extra = null } = {}) {
  const node = findPage(vault, ref);
  const { id } = ensureManifest(node.dir);
  const existing = getLock(vault, id);
  if (existing && !force) {
    throw new Error(`Already being edited by ${existing.by || "an agent"} since ${existing.startedAt}`);
  }

  for (const old of allMetaPaths(vault, "snapshots", id)) fs.rmSync(old, { recursive: true, force: true });
  const snap = newMetaPath(vault, "snapshots", id);
  fs.mkdirSync(snap, { recursive: true });
  for (const name of ownEntries(node.dir)) {
    fs.cpSync(path.join(node.dir, name), path.join(snap, name), { recursive: true });
  }

  const lock = { ...(extra || {}), id, path: node.path, by, message, startedAt: new Date().toISOString() };
  fs.mkdirSync(locksDir(vault), { recursive: true });
  for (const old of allMetaPaths(vault, "locks", `${id}.json`)) fs.rmSync(old, { force: true });
  fs.writeFileSync(path.join(locksDir(vault), `${id}.json`), JSON.stringify(lock, null, 2) + "\n");
  return { lock, dir: node.dir };
}

function lockedPage(vault, ref) {
  const node = findPage(vault, ref);
  const lock = getLock(vault, node.id);
  if (!lock) throw new Error(`Not being edited: ${node.path}`);
  return { node, lock };
}

function clear(vault, id) {
  for (const f of allMetaPaths(vault, "locks", `${id}.json`)) fs.rmSync(f, { force: true });
  for (const d of allMetaPaths(vault, "snapshots", id)) fs.rmSync(d, { recursive: true, force: true });
}

/** Unlock and commit everything. Message defaults to the lock message. */
export function endEdit(vault, ref, { message, by } = {}) {
  const { node, lock } = lockedPage(vault, ref);
  // A built page is rebuilt before the commit, so its output lands with the change.
  const build = node.build ? runBuildSync(node.dir) : null;
  clear(vault, lock.id);
  const msg = message || lock.message || `Edit ${node.path}`;
  const commit = commitAll(vault, msg, { author: authorFor(by || lock.by) });
  return build ? { commit, build: { ok: build.ok, output: build.output, ms: build.ms } } : { commit };
}

/** Unlock without committing or restoring: the lock's owner has written and committed its own
 * changes (Noteblock AI's apply, ai.mjs). */
export function releaseEdit(vault, id) {
  clear(vault, id);
}

/** Put the snapshot back over the page's own files, then unlock. No commit. */
export function abortEdit(vault, ref) {
  const { node, lock } = lockedPage(vault, ref);
  const snap = snapshotDir(vault, lock.id);
  if (fs.existsSync(snap)) {
    for (const name of ownEntries(node.dir)) {
      fs.rmSync(path.join(node.dir, name), { recursive: true, force: true });
    }
    for (const name of fs.readdirSync(snap)) {
      fs.cpSync(path.join(snap, name), path.join(node.dir, name), { recursive: true });
    }
  }
  clear(vault, lock.id);
}
