// Page crashes and freezes, from the main process's side. See docs/contract.md, "Crashes,
// freezes and errors".
//
// The app UI (file://) and the pages run in different renderer processes: every page frame and
// embed is an out-of-process iframe of the window, and since each page has its own origin
// (quire://p-<id>, its own site) each page gets its own process too; an embed of another page
// runs apart from the page holding it. Electron reports nothing when an out-of-process iframe's
// process dies (no render-process-gone, no child-process-gone), so the app renderer heartbeats
// the page frame (postMessage ping → runtime pong; each runtime does the same for its embeds)
// and, when the pongs stop, asks here what happened:
// probePage() looks the frame up, checks its process is still alive and tries to run one line of
// script in it. killPageProcess() ends a hung page process so a fresh iframe gets a new one;
// it refuses the app UI's own process.
//
// watchWindow() covers the window itself: its own renderer hanging (`unresponsive`) or dying
// (`render-process-gone`, which does fire for the main frame).
import { app, dialog, webContents as allWebContents } from "electron";
import { BRAND } from "../../core/brand.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Every live frame under `root` (not root itself), skipping ones whose process has gone. */
function framesUnder(root) {
  const out = [];
  const walk = (f, depth) => {
    let kids = [];
    try {
      kids = f.frames;
    } catch {
      return;
    }
    for (const k of kids) {
      let info = null;
      try {
        if (k.detached) continue;
        info = { frame: k, url: k.url, pid: k.osProcessId, depth };
      } catch {
        continue; // "Render frame was disposed": its process is gone
      }
      out.push(info);
      walk(k, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** quire://p-<id>/A/B/ or quire://vault/A/B/ (or …/B/file.html) → "A/B". */
export function pagePathOf(url) {
  const m = /^quire:\/\/(vault|p-[a-z0-9]+)\//i.exec(url || "");
  if (!m) return null;
  const clean = url.replace(/[?#].*$/, "").slice(m[0].length);
  let segs = clean.split("/");
  if (segs.length && segs[segs.length - 1] !== "" && /\.[a-z0-9]+$/i.test(segs[segs.length - 1])) segs = segs.slice(0, -1);
  try {
    return segs.filter(Boolean).map(decodeURIComponent).join("/");
  } catch {
    return segs.filter(Boolean).join("/");
  }
}

const strip = (u) => String(u || "").replace(/[?#].*$/, "");

/** The frame showing `src` in `wc`: the shallowest one whose URL starts with it. */
function findFrame(wc, src) {
  const want = strip(src);
  const hits = framesUnder(wc.mainFrame).filter((f) => strip(f.url).startsWith(want));
  hits.sort((a, b) => a.depth - b.depth);
  return hits[0] || null;
}

/** Page paths shown by any frame, in any window, hosted by process `pid`. */
function pagesOnProcess(pid) {
  const pages = [];
  for (const wc of allWebContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    for (const f of framesUnder(wc.mainFrame)) {
      const p = f.pid === pid ? pagePathOf(f.url) : null;
      if (p != null && !pages.includes(p)) pages.push(p);
    }
  }
  return pages;
}

/**
 * Every renderer process showing a page, in any window: [{pid, memoryMB, pages: [path…]}],
 * biggest first. Settings → Activity & limits lists them.
 */
export function pageProcesses() {
  const byPid = new Map();
  for (const wc of allWebContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    for (const f of framesUnder(wc.mainFrame)) {
      if (!/^quire:\/\/p-/i.test(f.url || "")) continue; // a page's own origin (not the vault host)
      const p = pagePathOf(f.url);
      if (p == null || !f.pid) continue;
      if (!byPid.has(f.pid)) byPid.set(f.pid, { pid: f.pid, memoryMB: null, pages: [] });
      const e = byPid.get(f.pid);
      if (!e.pages.includes(p)) e.pages.push(p);
    }
  }
  const metrics = new Map(app.getAppMetrics().map((m) => [m.pid, m]));
  for (const e of byPid.values()) {
    const m = metrics.get(e.pid);
    e.memoryMB = m && m.memory ? Math.round(m.memory.workingSetSize / 1024) : null;
  }
  return [...byPid.values()].sort((a, b) => (b.memoryMB || 0) - (a.memoryMB || 0));
}

/** Resident memory of a renderer, in MB, from app.getAppMetrics(); null when unknown. */
function memoryMB(pid) {
  const m = app.getAppMetrics().find((x) => x.pid === pid);
  return m && m.memory ? Math.round(m.memory.workingSetSize / 1024) : null;
}

// Once a page process has died its frames can no longer be asked anything, so remember, every
// second, which process each page frame was on and how much memory that process used: a page
// whose process vanished at 1.5 GB or more is reported as out of memory.
const lastPid = new Map(); // frame URL (no query) → pid
const peakMB = new Map(); // pid → highest resident MB seen
const deadSince = new Map(); // pid → when the sampler first found it gone
let sampler = null;
function startSampler() {
  if (sampler) return;
  sampler = setInterval(() => {
    const wcs = allWebContents.getAllWebContents().filter((w) => !w.isDestroyed());
    if (!wcs.length) return;
    const pids = new Set();
    for (const w of wcs) {
      for (const f of framesUnder(w.mainFrame)) {
        if (!/^quire:/i.test(f.url)) continue;
        lastPid.set(strip(f.url), f.pid);
        pids.add(f.pid);
      }
    }
    for (const m of app.getAppMetrics()) {
      if (!pids.has(m.pid) || !m.memory) continue;
      const mb = Math.round(m.memory.workingSetSize / 1024);
      if (mb > (peakMB.get(m.pid) || 0)) peakMB.set(m.pid, mb);
    }
    if (lastPid.size > 500) lastPid.clear();
    // Dead processes are forgotten a minute later (a probe asks within seconds).
    const now = Date.now();
    for (const pid of peakMB.keys()) {
      if (pidAlive(pid)) continue;
      if (!deadSince.has(pid)) deadSince.set(pid, now);
      else if (now - deadSince.get(pid) > 60000) {
        peakMB.delete(pid);
        deadSince.delete(pid);
      }
    }
  }, 1000);
  sampler.unref?.();
}
const OOM_MB = 1536;

/**
 * What is going on with the page frame showing `src` in `wc` (the window that asked).
 * state: "ok" (answered a script call: alive, maybe without the runtime), "frozen" (process
 * alive, script call timed out), "gone" (no frame, or its process has exited).
 */
export async function probePage(wc, src, { timeoutMs = 1000 } = {}) {
  const appPid = wc.getOSProcessId();
  const hit = findFrame(wc, src);
  const gone = (pid) => {
    const peak = pid ? peakMB.get(pid) || null : null;
    return { state: "gone", pid, pages: [], appPid, peakMB: peak, reason: peak != null && peak >= OOM_MB ? "oom" : "crashed" };
  };
  if (!hit) return gone(lastPid.get(strip(src)) || null);
  const { frame, pid } = hit;
  if (!pidAlive(pid)) return gone(pid);
  const answered = await Promise.race([
    frame.executeJavaScript("1").then(
      () => true,
      () => false,
    ),
    sleep(timeoutMs).then(() => null),
  ]);
  const base = { pid, appPid, sharesAppProcess: pid === appPid, pages: pagesOnProcess(pid), memoryMB: memoryMB(pid) };
  if (answered === true) return { state: "ok", ...base };
  if (answered === false || !pidAlive(pid)) return gone(pid);
  return { state: "frozen", ...base };
}

/**
 * End the process hosting the page frame showing `src`, so the next iframe gets a new one.
 * Refuses the app UI's process, and (with `keep`, the src of another frame) that frame's
 * process: an embed's Reload must not take down the page holding it. Waits until the process
 * has exited (up to 3 s).
 */
export async function killPageProcess(wc, src, { keep = null } = {}) {
  const hit = findFrame(wc, src);
  if (!hit) return { killed: false, reason: "gone" };
  const { pid } = hit;
  if (pid === wc.getOSProcessId()) throw new Error("This page runs in the app window's own process; reload the window instead (View → Reload)");
  const kept = keep ? findFrame(wc, keep) : null;
  if (kept && kept.pid === pid) return { killed: false, reason: "shared", pid };
  const m = app.getAppMetrics().find((x) => x.pid === pid);
  if (!m || m.type !== "Tab") throw new Error("Could not find the page's process");
  const pages = pagesOnProcess(pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  for (let i = 0; i < 60 && pidAlive(pid); i++) await sleep(50);
  await sleep(150); // let the browser notice before a new frame asks for a process
  return { killed: true, pid, pages };
}

/** The window's own renderer (the app UI): hung → ask to wait or reload; gone → reload. */
export function watchWindow(win, { quiet = false } = {}) {
  startSampler();
  const wc = win.webContents;
  let asking = null;
  const crashes = [];

  wc.on("unresponsive", async () => {
    if (asking || quiet) return;
    asking = new AbortController();
    const res = await dialog
      .showMessageBox(win, {
        type: "warning",
        message: `${BRAND.name} isn't responding`,
        detail: "The window has been busy for a while. Pages keep their changes; reloading the window only restarts the app's interface.",
        buttons: ["Wait", "Reload window"],
        defaultId: 0,
        cancelId: 0,
        signal: asking.signal,
      })
      .catch(() => ({ response: 0 }));
    asking = null;
    if (res.response === 1 && !wc.isDestroyed()) {
      wc.forcefullyCrashRenderer();
      wc.reload();
    }
  });
  wc.on("responsive", () => {
    if (asking) asking.abort();
  });

  wc.on("render-process-gone", async (_e, details) => {
    console.error("[quire] window renderer gone:", details.reason, details.exitCode);
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60000) crashes.shift();
    crashes.push(now);
    if (crashes.length <= 3 || quiet) {
      setTimeout(() => !wc.isDestroyed() && wc.reload(), 300);
      return;
    }
    const res = await dialog
      .showMessageBox(win, {
        type: "error",
        message: details.reason === "oom" ? `${BRAND.name}'s window ran out of memory` : `${BRAND.name}'s window keeps crashing`,
        detail: `It stopped ${crashes.length} times in the last minute (${details.reason}).`,
        buttons: ["Reload window", "Quit"],
        defaultId: 0,
      })
      .catch(() => ({ response: 0 }));
    if (res.response === 1) app.quit();
    else if (!wc.isDestroyed()) wc.reload();
  });
}
