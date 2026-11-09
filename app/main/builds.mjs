// Builds for pages with a `.noteblock` "build" command, run by the app: after a prose save, after
// a file is saved in the editor, and when the page's source files change on disk. One build
// per page at a time; changes that land mid-build queue exactly one more.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildInfo, findPage, getLock, isBuildOutput, runBuild } from "../../core/index.mjs";
import { pagePath, setShellPath } from "./tools.mjs";
import { commandGate } from "./trust.mjs";

export const BUILD_DEBOUNCE_MS = 400;
/** After a build, its own output changes are still arriving through the watcher; ignore them. */
export const QUIET_MS = 1500;

/**
 * Content hash of a page's source files: everything but build output, node_modules, data/
 * and lockfiles. A watcher-triggered build only runs when this differs from the last build's,
 * so files a build touches on its way through (pnpm's _tmp_* files, vite's temp config) can't
 * start another one.
 */
export function sourceFingerprint(dir) {
  const info = buildInfo(dir);
  const h = crypto.createHash("sha1");
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.name === "node_modules" || e.name === ".DS_Store" || isBuildOutput(info, r)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        h.update(r + "\0");
        try {
          h.update(fs.readFileSync(path.join(dir, r)));
        } catch {}
      }
    }
  };
  walk("");
  return h.digest("hex");
}

/** @type {Map<string, {timer: NodeJS.Timeout|null, running: boolean, again: boolean, reload: boolean, force: boolean, fp: string|null, quietUntil: number}>} */
const pages = new Map();

let shellEnv = null;
/**
 * The environment page builds and backends run in. A Finder-launched app gets a bare PATH (no
 * pnpm, node, bun…), so ask the login shell for the person's real one, once, and put Quire's
 * node/pnpm shims (tools.mjs) in front of it.
 */
export function buildEnv() {
  if (shellEnv) return shellEnv;
  shellEnv = { ...process.env };
  if (process.platform === "win32") {
    // A Windows app gets the full user PATH already; there is no login shell to ask. The copy
    // keeps Windows' own spelling (Path): settle on one key so spawn doesn't see two.
    const k = Object.keys(shellEnv).find((x) => x.toUpperCase() === "PATH");
    const p = k ? shellEnv[k] : "";
    if (k && k !== "PATH") delete shellEnv[k];
    setShellPath(p);
    shellEnv.PATH = pagePath(p);
    return shellEnv;
  }
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = spawnSync(shell, ["-ilc", 'printf "__QPATH__%s__QPATH__" "$PATH"'], { timeout: 5000, encoding: "utf8" });
    const m = /__QPATH__(.*)__QPATH__/.exec(r.stdout || "");
    if (m && m[1]) shellEnv.PATH = m[1];
  } catch {}
  setShellPath(shellEnv.PATH);
  shellEnv.PATH = pagePath(shellEnv.PATH);
  return shellEnv;
}

function state(key) {
  let s = pages.get(key);
  if (!s) {
    s = { timer: null, running: false, again: false, reload: false, force: false, fp: null, quietUntil: 0 };
    pages.set(key, s);
  }
  return s;
}

/** Builds running right now: [{vault, path, startedAt, pid}] (pid of the build's /bin/sh). */
export function listBuilds() {
  const out = [];
  for (const [key, s] of pages) {
    if (!s.running) continue;
    const [vault, pagePath] = key.split("\0");
    out.push({ vault, path: pagePath, startedAt: s.startedAt || null, pid: s.pid || null });
  }
  return out;
}

/** True while the app is building this page or just finished: its output churn is ours. */
export function isBuilding(vault, pagePath) {
  const s = pages.get(vault + "\0" + pagePath);
  return !!s && (s.running || !!s.timer || Date.now() < s.quietUntil);
}

/**
 * Build a page soon. reload: the page's code changed, so reload it when the build is done
 * (a prose save already shows the edit, so it doesn't need one). ifChanged: only build when the
 * page's source files differ from the last build's (watcher events); saves always build.
 * @param {(msg: {path: string, state: "building"|"ok"|"error"|"blocked", output?: string, reason?: string, ms?: number, reload?: boolean}) => void} notify
 */
export function scheduleBuild(vault, pagePath, { reload = false, ifChanged = false, notify }) {
  const s = state(vault + "\0" + pagePath);
  s.reload = s.reload || reload;
  s.force = s.force || !ifChanged;
  if (s.running) {
    s.again = true;
    return;
  }
  clearTimeout(s.timer);
  s.timer = setTimeout(() => run(vault, pagePath, notify), BUILD_DEBOUNCE_MS);
}

async function run(vault, pagePath, notify) {
  const s = state(vault + "\0" + pagePath);
  s.timer = null;
  let node;
  try {
    node = findPage(vault, pagePath);
  } catch {
    return; // page is gone
  }
  if (!node.build) return;
  // An agent holds the page: `quire done` builds it.
  if (node.id && getLock(vault, node.id)) return;
  // Restricted vault, or a build command this Mac hasn't approved (trust.mjs): no build. The
  // window says why ("blocked"); a committed build output still shows.
  const gate = commandGate(vault, node);
  if (!gate.ok) {
    s.reload = false;
    s.force = false;
    notify({ path: pagePath, state: "blocked", reason: gate.reason, output: gate.message });
    return;
  }
  const fp = sourceFingerprint(node.dir);
  if (!s.force && fp === s.fp) {
    s.reload = false;
    return;
  }
  s.force = false;
  s.fp = fp;
  s.running = true;
  s.startedAt = Date.now();
  const reload = s.reload;
  s.reload = false;
  notify({ path: pagePath, state: "building" });
  const r = await runBuild(node.dir, { env: buildEnv(), onSpawn: (pid) => (s.pid = pid) });
  s.running = false;
  s.pid = null;
  s.quietUntil = Date.now() + QUIET_MS;
  notify({ path: pagePath, state: r.ok ? "ok" : "error", output: r.output, ms: r.ms, reload: reload && r.ok });
  if (s.again) {
    s.again = false;
    scheduleBuild(vault, pagePath, { ifChanged: true, notify });
  }
}
