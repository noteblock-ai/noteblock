// Vault sync: push the vault's git history to a remote (a private GitHub repo) and pull what
// another machine pushed. The remote is the vault repo's `origin`; whether it syncs on its own
// is kept per vault in config.json under "sync", and how often it checks under
// "syncEverySec". A check is one `git ls-remote`; it only fetches, rebases or pushes when the
// remote moved or there are local commits. It also syncs a few seconds after an edit and when
// the window comes back into focus. Git runs async so a slow network never freezes the window.
//
// Conflicts: when a local commit and the remote changed the same file, the remote version
// wins in place and the local one is kept beside it as "name (conflict <date>).ext".
//
// Trust: what a pull writes reaches the app through the watcher like any outside edit, so a
// page's new or changed `backend.run` / `build` command doesn't run until the person approves it
// on this machine (trust.mjs commandGate, asked once in the window). Nothing here approves.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitCommand, loadConfig, saveConfig } from "../../core/index.mjs";
import { flushAutosavesAsync } from "./autosave.mjs";
import { buildEnv } from "./builds.mjs";

export const SYNC_INTERVALS = [15, 30, 60, 300];
export const DEFAULT_SYNC_SEC = 30;
export const SOON_MS = 5000;
export const FOCUS_THROTTLE_MS = 10000;

function git(vault, args, { allowFail = false, raw = false } = {}) {
  // The same git as the vault's commits (core/git.mjs useGit: Quire's own unless Settings →
  // Tools says the Mac's), with the login shell's PATH for ssh and credential helpers.
  const { bin, env } = gitCommand();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-C", vault, ...args],
      {
        env: { ...buildEnv(), ...(env || {}), GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
        timeout: 120000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: raw ? "buffer" : "utf8",
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (allowFail) return resolve(null);
        const msg = String(stderr || err.message || "").trim().split("\n").filter(Boolean).pop() || "unknown error";
        reject(new Error(`git ${args[0]} failed: ${msg}`));
      },
    );
  });
}

const key = (vault) => path.resolve(vault);

function enabledIn(vault) {
  const s = loadConfig().sync;
  return !!(s && typeof s === "object" && s[key(vault)]);
}

/** @type {{vault: string|null, timer: NodeJS.Timeout|null, running: Promise<any>|null, last: any, notify: (s: any) => void}} */
const state = { vault: null, timer: null, soon: null, lastFocus: 0, running: null, last: null, notify: () => {} };

/** Conflict copies stay in the status line this long, even as later syncs come and go. */
const CONFLICT_NOTE_MS = 10 * 60 * 1000;

export async function syncInfo(vault) {
  const remote = ((await git(vault, ["remote", "get-url", "origin"], { allowFail: true })) || "").trim();
  return { remote, enabled: enabledIn(vault), everySec: syncEverySec(), syncing: !!state.running, last: state.vault === vault ? state.last : null };
}

/** Set (or with "" remove) the vault's origin. */
export async function setRemote(vault, url) {
  const clean = String(url || "").trim();
  const has = (await git(vault, ["remote", "get-url", "origin"], { allowFail: true })) != null;
  if (!clean) {
    if (has) await git(vault, ["remote", "remove", "origin"]);
  } else await git(vault, ["remote", has ? "set-url" : "add", "origin", clean]);
  return syncInfo(vault);
}

/** A renamed or moved vault keeps its sync setting, which is keyed by path. */
export function moveSyncSetting(from, to) {
  const cfg = loadConfig();
  const sync = cfg.sync && typeof cfg.sync === "object" ? { ...cfg.sync } : null;
  if (!sync || !sync[key(from)] || key(from) === key(to)) return;
  delete sync[key(from)];
  sync[key(to)] = true;
  saveConfig({ ...cfg, sync });
}

export function setEnabled(vault, on) {
  const cfg = loadConfig();
  const sync = { ...(cfg.sync && typeof cfg.sync === "object" ? cfg.sync : {}) };
  if (on) sync[key(vault)] = true;
  else delete sync[key(vault)];
  saveConfig({ ...cfg, sync });
  schedule();
  return syncInfo(vault);
}

export function syncEverySec() {
  const n = Number(loadConfig().syncEverySec);
  return SYNC_INTERVALS.includes(n) ? n : DEFAULT_SYNC_SEC;
}

export function setSyncEvery(vault, sec) {
  const n = Number(sec);
  if (!SYNC_INTERVALS.includes(n)) throw new Error(`Pick one of ${SYNC_INTERVALS.join(", ")} seconds`);
  saveConfig({ ...loadConfig(), syncEverySec: n });
  schedule();
  return syncInfo(vault);
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
};

/** "a/index.html" → "a/index (conflict 2026-10-21 1403).html", never an existing file. */
export function conflictName(vault, rel, when = new Date()) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const dot = base.lastIndexOf(".");
  const [name, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  for (let i = 1; ; i++) {
    const tag = `conflict ${stamp(when)}${i > 1 ? ` ${i}` : ""}`;
    const out = (dir === "." ? "" : dir + "/") + `${name} (${tag})${ext}`;
    if (!fs.existsSync(path.join(vault, out))) return out;
  }
}

const rebasing = (vault) => fs.existsSync(path.join(vault, ".git", "rebase-merge")) || fs.existsSync(path.join(vault, ".git", "rebase-apply"));

/** Stage `rel` at index stage n (2 = upstream/remote, 3 = the local commit being replayed). */
const stageBlob = (vault, n, rel) => git(vault, ["show", `:${n}:${rel}`], { allowFail: true, raw: true });

/**
 * Settle every conflicted file of the current rebase step. During `git rebase origin/main`
 * stage 2 ("ours") is the remote and stage 3 ("theirs") is the local commit being replayed.
 * @returns {Promise<string[]>} conflict copies written (vault-relative)
 */
async function resolveStep(vault) {
  const out = await git(vault, ["diff", "--name-only", "-z", "--diff-filter=U"]);
  const files = out.split("\0").filter(Boolean);
  const copies = [];
  for (const rel of files) {
    const remote = await stageBlob(vault, 2, rel);
    const local = await stageBlob(vault, 3, rel);
    const abs = path.join(vault, rel);
    if (remote == null) {
      // Deleted on the remote, changed here: keep the local file.
      if (local != null) fs.writeFileSync(abs, local);
      await git(vault, ["add", "-A", "--", rel]);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, remote);
    const hidden = path.posix.basename(rel).startsWith(".");
    if (local != null && !hidden && !local.equals(remote)) {
      const copy = conflictName(vault, rel);
      fs.writeFileSync(path.join(vault, copy), local);
      await git(vault, ["add", "--", copy]);
      copies.push(copy);
    }
    await git(vault, ["add", "-A", "--", rel]);
  }
  return copies;
}

/** Rebase onto origin/main, settling conflicts file by file. */
async function rebaseOntoRemote(vault) {
  const copies = [];
  let ok = await git(vault, ["-c", "rebase.autoStash=true", "rebase", "-q", "origin/main"], { allowFail: true });
  for (let guard = 0; ok == null && rebasing(vault); guard++) {
    if (guard > 500) {
      await git(vault, ["rebase", "--abort"], { allowFail: true });
      throw new Error("Couldn't finish merging with the repo. Nothing was changed.");
    }
    copies.push(...(await resolveStep(vault)));
    const staged = (await git(vault, ["diff", "--cached", "--name-only"])).trim();
    ok = staged
      ? await git(vault, ["-c", "core.editor=true", "rebase", "--continue"], { allowFail: true })
      : await git(vault, ["rebase", "--skip"], { allowFail: true });
  }
  if (ok == null && !rebasing(vault)) {
    // The rebase finished but the autostash didn't apply cleanly; it's kept in `git stash`.
    throw new Error("Pulled, but some unsaved edits are parked in git stash.");
  }
  return copies;
}

/**
 * Commit pending edits, rebase onto the remote's main and push. Cheap when nothing moved:
 * one ls-remote and two local rev lookups.
 */
export async function syncOnce(vault) {
  // Async: the 30 s check lands mid-typing, and a sync commit here froze input for ~250 ms.
  await flushAutosavesAsync(vault);
  const remote = ((await git(vault, ["remote", "get-url", "origin"], { allowFail: true })) || "").trim();
  if (!remote) throw new Error("No repo set");
  const remoteHead = ((await git(vault, ["ls-remote", "origin", "refs/heads/main"])) || "").split(/\s/)[0] || "";
  const known = ((await git(vault, ["rev-parse", "--verify", "-q", "refs/remotes/origin/main"], { allowFail: true })) || "").trim();
  const local = ((await git(vault, ["rev-parse", "--verify", "-q", "main"], { allowFail: true })) || "").trim();
  if (remoteHead && remoteHead === known && local === known) return { pulled: 0, pushed: 0, conflicts: [] };

  if (remoteHead && remoteHead !== known) await git(vault, ["fetch", "-q", "origin"]);
  const hasRemote = (await git(vault, ["rev-parse", "--verify", "-q", "refs/remotes/origin/main"], { allowFail: true })) != null;
  let pulled = 0;
  let conflicts = [];
  if (hasRemote) {
    const [, behind] = (await git(vault, ["rev-list", "--left-right", "--count", "main...origin/main"])).trim().split(/\s+/).map(Number);
    if (behind > 0) {
      conflicts = await rebaseOntoRemote(vault);
      pulled = behind;
    }
  }
  const pushed = Number((await git(vault, ["rev-list", "--count", hasRemote ? "origin/main..main" : "main"])).trim());
  if (pushed > 0) await git(vault, ["push", "-q", "-u", "origin", "main"]);
  return { pulled, pushed, conflicts };
}

export function syncNow(vault) {
  if (state.running) return state.running;
  state.notify({ vault, syncing: true, last: state.last });
  state.running = syncOnce(vault)
    .then((r) => {
      const at = new Date().toISOString();
      const prev = state.last;
      if (r.conflicts.length) return { ok: true, at, ...r, conflictsAt: at };
      if (prev?.conflicts?.length && Date.now() - Date.parse(prev.conflictsAt) < CONFLICT_NOTE_MS) {
        return { ok: true, at, ...r, conflicts: prev.conflicts, conflictsAt: prev.conflictsAt };
      }
      return { ok: true, at, ...r };
    })
    .catch((err) => ({ ok: false, at: new Date().toISOString(), error: String(err.message || err) }))
    .then((last) => {
      state.running = null;
      if (state.vault === vault) state.last = last;
      state.notify({ vault, syncing: false, last });
      return last;
    });
  return state.running;
}

function schedule() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  const vault = state.vault;
  if (!vault || !enabledIn(vault)) return;
  state.timer = setInterval(() => syncNow(vault), syncEverySec() * 1000);
  state.timer.unref?.();
}

/** Sync SOON_MS after the last call: an edit, a commit, a file an agent wrote. */
export function syncSoon() {
  const vault = state.vault;
  if (!vault || !enabledIn(vault)) return;
  if (state.soon) clearTimeout(state.soon);
  state.soon = setTimeout(() => {
    state.soon = null;
    if (state.vault === vault) syncNow(vault);
  }, SOON_MS);
  state.soon.unref?.();
}

/** The window came back to the front: pick up what other machines pushed. */
export function syncOnFocus() {
  const vault = state.vault;
  if (!vault || !enabledIn(vault) || Date.now() - state.lastFocus < FOCUS_THROTTLE_MS) return;
  state.lastFocus = Date.now();
  syncNow(vault);
}

/** Call whenever the open vault changes. Syncs once right away when it's on. */
export function startSync(vault, notify) {
  if (notify) state.notify = notify;
  if (state.vault !== vault) state.last = null;
  state.vault = vault;
  schedule();
  if (enabledIn(vault)) setTimeout(() => state.vault === vault && syncNow(vault), 3000);
}
