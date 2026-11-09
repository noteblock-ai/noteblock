// Page backends: the processes a page's `.noteblock` "backend.run" names, run in its backend
// folder. They start the first time the page (or an embed of it) is served. A change under the
// backend folder restarts them; a crash restarts with backoff. Every process gets a port of its
// own ($PORT) that stays the same across restarts, and sees its siblings' as $PORT_<NAME>.
// /api/* from the page is proxied to backend.proxy.
//
// Many pages means many processes: an idle `node server.js` holds ~40 MB, so 100 of them would
// sit on ~4 GB doing nothing. So a backend nobody has used for `backends.idleMinutes` (config,
// default 15, 0 = never) is stopped, and at most `backends.maxRunning` (default 12, 0 = no cap)
// run at once, starting one more stops the least recently used. A stopped one starts again on
// its next use; the /api proxy waits for it to listen.
//
// A watchdog (one `ps -A` every `checkSeconds` while any backend runs) holds each backend
// process to `maxProcesses`, `maxMemoryMB` and `cpuPercent` for `cpuSeconds`, and a process
// that crashes `crashLimit` times within `crashWindowMinutes` stops being restarted. Every
// limit lives in limits.mjs and is read on each check, so a change in Settings applies at once.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { configDir, findPage, shellSpawn } from "../../core/index.mjs";
import { buildEnv } from "./builds.mjs";
import { toolHelpUrl } from "./tools.mjs";
import { limits, setLimits, LIMITS } from "./limits.mjs";
import { processTable, backendUsage } from "./activity.mjs";
import { BRAND } from "../../core/brand.mjs";
import { commandGate } from "./trust.mjs";

export const PORT_MIN = 47000;
export const PORT_MAX = 48999;
const LOG_MAX = 256 * 1024;
const RESTART_DEBOUNCE_MS = 400;
const LISTEN_TIMEOUT_MS = 15000;
export const DEFAULT_IDLE_MINUTES = LIMITS.idleMinutes[2];
export const DEFAULT_MAX_RUNNING = LIMITS.maxRunning[2];
/** First watchdog check this soon after a process starts (a fork bomb doubles fast)… */
const FIRST_CHECK_MS = 250;
/** …then at most this far apart for its first FAST_CHECK_FOR_MS. */
const FAST_CHECK_MS = 500;
const FAST_CHECK_FOR_MS = 10000;
/**
 * macOS `ps` lists processes with sysctl(KERN_PROC_ALL), which retries while the process table
 * keeps growing, so during a fork bomb it doesn't answer until the bomb stops. When it hasn't
 * answered in this long, the watchdog freezes every backend (SIGSTOP; nothing frozen can fork),
 * lists again, and lets the ones within their limits go on (SIGCONT).
 */
const PS_STARVED_MS = 250;
const PS_GIVE_UP_MS = 5000;

/** {idleMs, maxRunning} from limits(); 0 turns either off. (Kept for older callers.) */
export function backendLimits() {
  const l = limits();
  return { idleMs: l.idleMinutes * 60000, maxRunning: Math.floor(l.maxRunning) };
}

const graceMs = () => limits().stopGraceSeconds * 1000;

/* ------------------------------------------------------------ ports */

const portsFile = () => path.join(configDir(), "ports.json");

function readPorts() {
  try {
    const p = JSON.parse(fs.readFileSync(portsFile(), "utf8"));
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function writePorts(p) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(portsFile(), JSON.stringify(p, null, 2) + "\n");
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/**
 * The port for one process of one page: the one it had before when that's still free, else
 * the next free one in [PORT_MIN, PORT_MAX] that no other process was given.
 */
async function portFor(key) {
  const all = readPorts();
  if (all[key] && (await portFree(all[key]))) return all[key];
  const taken = new Set(Object.entries(all).filter(([k]) => k !== key).map(([, v]) => v));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (taken.has(p) || !(await portFree(p))) continue;
    writePorts({ ...readPorts(), [key]: p });
    return p;
  }
  throw new Error("No free port for the backend");
}

/* ------------------------------------------------------------ .env */

/** KEY=value lines; # comments, optional `export`, single/double quotes. */
export function parseDotenv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^"(.*)"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/* ------------------------------------------------------------ missing tools */

/** The first word of a shell command that names a program: `FOO=1 exec python3 x.py` → python3. */
export function commandName(cmd) {
  const words = String(cmd || "").trim().split(/\s+/);
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ["exec", "env", "command", "nohup", "time"].includes(words[0]))) words.shift();
  return words[0] ? path.basename(words[0].replace(/^["']|["']$/g, "")) : null;
}

/**
 * The program a backend couldn't run because it isn't on this Mac, from its exit code and the
 * output of that run; null when that isn't why it stopped. `sh: python9: command not found`
 * (exit 127), `env: python3: No such file or directory` from a shebang, and Apple's stubs
 * (/usr/bin/python3, git, make…) on a Mac without the developer tools.
 */
export function missingToolFrom(code, output, cmd) {
  const out = String(output || "");
  if (/xcode-select: note: No developer tools were found|xcrun: error: invalid active developer path/.test(out)) return commandName(cmd);
  if (code !== 127) return null;
  const m =
    /(?:^|\n)[^\n]*?(?:sh|zsh|bash)(?:: line \d+)?: (?:exec: )?([^\s:'"]+): (?:command )?not found/.exec(out) ||
    /command not found: ([^\s:'"]+)/.exec(out) ||
    /env: ([^\s:'"]+): No such file or directory/.exec(out);
  return m ? path.basename(m[1]) : commandName(cmd);
}

/* ------------------------------------------------------------ processes */

/** @type {Map<string, any>} page id → {vault, path, dir, procs: Map<name, proc>, timer, lastUsed} */
const pages = new Map();
/** page id → promise of a stop in progress (its ports are still held until it resolves) */
const stopping = new Map();
/** page id → "idle" | "cap": why Quire stopped it, until it starts again */
const stoppedBy = new Map();
/** page id → when it was last used, kept after it stops (for Settings → Activity & limits) */
const lastUsedOf = new Map();
let notify = () => {};
/** id → why the trust gate kept a backend from starting (trust.mjs commandGate): {reason, message}. */
const blocked = new Map();

const touch = (entry) => (entry.lastUsed = Date.now());

export function onBackendStatus(fn) {
  notify = fn;
}

const logDir = () => path.join(configDir(), "logs");
const logFile = (id, name) => path.join(logDir(), `${id}-${name}.log`);

function appendLog(proc, text) {
  proc.log = (proc.log + text).slice(-LOG_MAX);
  try {
    fs.appendFileSync(proc.logPath, text);
    if (fs.statSync(proc.logPath).size > LOG_MAX * 4) fs.writeFileSync(proc.logPath, proc.log);
  } catch {}
}

function snapshot(entry) {
  return {
    path: entry.path,
    dir: entry.cfg.dir,
    proxy: entry.cfg.proxy,
    requires: entry.requires || null,
    lastUsed: entry.lastUsed,
    procs: [...entry.procs.values()].map((p) => ({
      name: p.name,
      cmd: p.cmd,
      port: p.port,
      state: p.state, // starting | running | exited | crashed | stopped
      code: p.code,
      startedAt: p.startedAt,
      restarts: p.restarts,
      // Set when Quire stopped (or gave up on) this process for a limit: a sentence, and a code
      // "processes" | "memory" | "cpu" | "crashes".
      ...(p.reason ? { reason: p.reason, limitHit: p.limitHit } : {}),
      // Set when it couldn't start because a program it runs isn't on this Mac.
      ...(p.missingTool ? { missingTool: p.missingTool, missingHelp: toolHelpUrl(p.missingTool) } : {}),
    })),
  };
}

const emit = (entry) => notify(snapshot(entry));

// Windows has no process groups or SIGSTOP: a negative pid (the group) or any kill ends the
// whole tree with taskkill /T /F, and stop/continue are no-ops (the watchdog's ps table is
// empty there, activity.mjs, so nothing gets frozen).
const signal = (pid, sig) => {
  if (process.platform === "win32") {
    if (sig === "SIGSTOP" || sig === "SIGCONT") return;
    try {
      execFile("taskkill", ["/pid", String(Math.abs(pid)), "/T", "/F"], { windowsHide: true }, () => {});
    } catch {}
    return;
  }
  try {
    process.kill(pid, sig);
  } catch {}
};

/**
 * SIGTERM the process group (and `extra` pids: descendants that left the group), SIGKILL
 * whatever is left after stopGraceSeconds. Resolves when the shell exits or the grace ends.
 */
function killTree(child, extra = []) {
  if (!child || child.exitCode != null || child.signalCode != null) {
    for (const p of extra) signal(p, "SIGKILL");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    child.once("exit", done);
    try {
      if (process.platform === "win32") signal(-child.pid, "SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      signal(child.pid, "SIGTERM");
    }
    for (const p of extra) signal(p, "SIGTERM");
    setTimeout(() => {
      signal(-child.pid, "SIGKILL");
      for (const p of extra) signal(p, "SIGKILL");
      done();
    }, graceMs()).unref?.();
  });
}

/**
 * Kill a process tree that may be forking as fast as it can: freeze everything found with
 * SIGSTOP (a stopped process can't fork, and its children keep their parent, so the tree stays
 * walkable), look again until nothing new shows up, then SIGKILL the lot. No grace period.
 * `escaped`: how many of `seen` had left the group. With none, stopping the group (a few times,
 * for children mid-fork) freezes everything and no second look is needed.
 */
async function killBomb(pid, seen, escaped = 1) {
  const all = new Set(seen);
  for (let round = 0; round < 8; round++) {
    signal(-pid, "SIGSTOP");
    for (const p of all) signal(p, "SIGSTOP");
    if (round === 0 && !escaped) {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 10));
        signal(-pid, "SIGSTOP");
      }
      break;
    }
    const use = backendUsage(await processTable(), pid, [...all]);
    const fresh = (use?.pids || []).filter((p) => !all.has(p));
    for (const p of fresh) all.add(p);
    if (!fresh.length) break;
  }
  signal(-pid, "SIGKILL");
  for (const p of all) signal(p, "SIGKILL");
  return all.size;
}

function startProc(entry, proc, env) {
  const stamp = new Date().toLocaleTimeString();
  appendLog(proc, `\n[quire ${stamp}] $ ${proc.cmd}   (PORT=${proc.port})\n`);
  proc.state = "starting";
  proc.code = null;
  proc.startedAt = Date.now();
  proc.reason = null;
  proc.limitHit = null;
  proc.missingTool = null;
  proc.cpuSince = null;
  proc.pids = [];
  proc.outside = [];
  let runOut = ""; // this run's output, for missingToolFrom
  const keep = (text) => (runOut = (runOut + text).slice(-8192));
  let child;
  try {
    const [file, argv, opts] = shellSpawn(proc.cmd);
    child = spawn(file, argv, { ...opts, cwd: entry.dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    appendLog(proc, String(err.message || err) + "\n");
    proc.state = "crashed";
    emit(entry);
    return;
  }
  proc.child = child;
  scheduleWatch(FIRST_CHECK_MS);
  child.stdout.on("data", (b) => (appendLog(proc, b.toString()), keep(b.toString())));
  child.stderr.on("data", (b) => (appendLog(proc, b.toString()), keep(b.toString())));
  child.on("error", (err) => appendLog(proc, String(err.message || err) + "\n"));
  // "running" once it listens on its port (or after a moment, for ones that never do).
  const until = Date.now() + 15000;
  const probe = async () => {
    if (proc.child !== child || proc.state !== "starting") return;
    if (!(await portFree(proc.port)) || Date.now() > until) {
      proc.state = "running";
      emit(entry);
      return;
    }
    setTimeout(probe, 250);
  };
  setTimeout(probe, 150);
  child.on("exit", (code, signal) => {
    if (proc.child !== child) return;
    proc.child = null;
    proc.code = code;
    if (proc.stopping) {
      proc.state = "stopped";
      proc.stopping = false;
      emit(entry);
      return;
    }
    appendLog(proc, `[quire] exited ${signal ? "on " + signal : "with code " + code}\n`);
    proc.state = code === 0 ? "exited" : "crashed";
    // A program it needs isn't on this Mac: restarting won't help, so say which and stop.
    const missing = signal ? null : missingToolFrom(code, runOut, proc.cmd);
    if (missing) {
      proc.missingTool = missing;
      appendLog(proc, `[quire] not restarting: \`${missing}\` isn't on this Mac\n`);
      emit(entry);
      return;
    }
    if (code !== 0) {
      // A crash loop: crashLimit crashes within crashWindowMinutes and it isn't restarted
      // again until a manual Restart (or a change to its files). 0 = always restart.
      const { crashLimit, crashWindowMinutes } = limits();
      const now = Date.now();
      proc.crashes = [...(proc.crashes || []), now].filter((t) => now - t < crashWindowMinutes * 60000);
      if (crashLimit && proc.crashes.length >= crashLimit) {
        proc.reason = `kept crashing (${proc.crashes.length} times in ${crashWindowMinutes} min) — restart to try again`;
        proc.limitHit = "crashes";
        appendLog(proc, `[quire] stopped restarting: ${proc.reason}\n`);
        console.log(`[quire] backend: ${entry.path} ${proc.name} ${proc.reason}`);
        emit(entry);
        return;
      }
    }
    emit(entry);
    if (code !== 0) {
      // Back off 1, 2, 4… up to 30 s; a run that lasted a minute resets it.
      if (Date.now() - proc.startedAt > 60000) proc.restarts = 0;
      const wait = Math.min(30000, 1000 * 2 ** proc.restarts);
      proc.restarts++;
      proc.retry = setTimeout(() => entry.alive && proc.state === "crashed" && startProc(entry, proc, env), wait);
    }
  });
  emit(entry);
}

async function startAll(entry) {
  const env = { ...buildEnv() };
  try {
    Object.assign(env, parseDotenv(fs.readFileSync(path.join(entry.dir, ".env"), "utf8")));
  } catch {}
  for (const proc of entry.procs.values()) env["PORT_" + proc.name.toUpperCase().replace(/-/g, "_")] = String(proc.port);
  env.QUIRE_PAGE = entry.path;
  for (const proc of entry.procs.values()) startProc(entry, proc, { ...env, PORT: String(proc.port) });
}

async function stopAll(entry) {
  await Promise.all(
    [...entry.procs.values()].map((p) => {
      clearTimeout(p.retry);
      if (!p.child) return null;
      p.stopping = true;
      return killTree(p.child, p.outside || []);
    }),
  );
}

/**
 * Start a page's backend if it has one and it isn't running (or its config changed).
 * Resolves once ports are assigned and processes spawned.
 */
export async function ensureBackend(vault, pagePath) {
  let node;
  try {
    node = findPage(vault, pagePath);
  } catch {
    return null;
  }
  if (!node.backend || !node.id || !Object.keys(node.backend.run).length) {
    if (node.id && pages.has(node.id)) await stopBackend(node.id);
    return null;
  }
  // Restricted vault, or a command this Mac hasn't approved (a sync brought it in): don't run it.
  // A running backend whose command changed stops; the old command isn't the page's any more.
  const gate = commandGate(vault, node);
  if (!gate.ok) {
    const was = blocked.get(node.id);
    blocked.set(node.id, gate);
    if (pages.has(node.id)) {
      await stopBackend(node.id);
      notify(backendStatus(vault, node.path));
    } else if (!was || was.reason !== gate.reason) notify(backendStatus(vault, node.path));
    return null;
  }
  blocked.delete(node.id);
  const dir = path.join(node.dir, node.backend.dir);
  const key = JSON.stringify([node.backend, dir, node.requires || null]);
  // An idle/cap stop of this page still holds its ports: let it finish so they're reused.
  if (stopping.has(node.id)) await stopping.get(node.id);
  let entry = pages.get(node.id);
  if (entry && entry.key === key) {
    entry.path = node.path;
    touch(entry);
    return snapshot(entry);
  }
  if (entry) await stopBackend(node.id);
  // No await between here and pages.set, so two callers can't both start it.
  const room = makeRoom(node.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });
  entry = { id: node.id, vault, path: node.path, dir, cfg: node.backend, requires: node.requires || null, key, procs: new Map(), alive: true, timer: null, lastUsed: Date.now() };
  pages.set(node.id, entry);
  stoppedBy.delete(node.id);
  scheduleSweep();
  await room;
  for (const [name, cmd] of Object.entries(node.backend.run)) {
    const port = await portFor(`${node.id}:${name}`);
    entry.procs.set(name, { name, cmd, port, state: "starting", code: null, startedAt: 0, restarts: 0, log: "", logPath: logFile(node.id, name), child: null });
  }
  await startAll(entry);
  return snapshot(entry);
}

/**
 * Stop a page's backend. reason "idle" / "cap" marks it as stopped by Quire (status procs get
 * `reason`), so it shows as "stopped (idle)" and starts again on its next use.
 */
export async function stopBackend(id, reason = null) {
  const entry = pages.get(id);
  if (!entry) return stopping.get(id);
  entry.alive = false;
  clearTimeout(entry.timer);
  pages.delete(id);
  lastUsedOf.set(id, entry.lastUsed);
  if (reason) stoppedBy.set(id, reason);
  else stoppedBy.delete(id);
  const done = stopAll(entry).then(() => {
    stopping.delete(id);
    notify(stoppedSnapshot(snapshot(entry), reason));
  });
  stopping.set(id, done);
  return done;
}

function stoppedSnapshot(snap, reason) {
  return { ...snap, procs: snap.procs.map((p) => ({ ...p, state: "stopped", ...(reason ? { reason } : {}) })) };
}

/**
 * Before starting one more backend: stop least-recently-used ones until it fits under the cap.
 * They leave `pages` synchronously; the promise resolves once their processes are gone.
 */
function makeRoom(exceptId) {
  const { maxRunning } = backendLimits();
  if (!maxRunning) return Promise.resolve();
  const others = [...pages.values()].filter((e) => e.id !== exceptId).sort((a, b) => a.lastUsed - b.lastUsed);
  const stops = [];
  while (others.length >= maxRunning) {
    const lru = others.shift();
    console.log(`[quire] backend: stopping ${lru.path} (least recently used; ${maxRunning} max running)`);
    stops.push(stopBackend(lru.id, "cap"));
  }
  return Promise.all(stops);
}

/* ------------------------------------------------------------ idle sweep */

let sweepTimer = null;

/** Check for idle backends every quarter of the idle time (250 ms … 30 s) while any run. */
function scheduleSweep() {
  if (sweepTimer || !pages.size) return;
  const { idleMs } = backendLimits();
  const every = idleMs ? Math.max(250, Math.min(30000, idleMs / 4)) : 30000;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    sweepIdle();
    scheduleSweep();
  }, every);
  sweepTimer.unref?.();
}

/** Stop every backend unused for longer than the idle time. */
export function sweepIdle(now = Date.now()) {
  const { idleMs } = backendLimits();
  if (!idleMs) return;
  for (const entry of [...pages.values()]) {
    if (now - entry.lastUsed < idleMs) continue;
    console.log(`[quire] backend: stopping ${entry.path} (idle ${Math.round((now - entry.lastUsed) / 1000)} s)`);
    stopBackend(entry.id, "idle").catch(() => {});
  }
}

/* ------------------------------------------------------------ watchdog */

let watchTimer = null;
let watchDue = 0;
let watching = false;

const liveProcs = () => [...pages.values()].flatMap((e) => [...e.procs.values()].filter((p) => p.child).map((p) => [e, p]));

/**
 * Run the next check within `ms` (sooner than one already planned wins). With no delay given:
 * checkSeconds, or FAST_CHECK_MS while some process is in its first FAST_CHECK_FOR_MS.
 */
function scheduleWatch(ms = null, force = false) {
  const live = liveProcs();
  if (!live.length) {
    clearTimeout(watchTimer);
    watchTimer = null;
    return;
  }
  if (ms == null) {
    const now = Date.now();
    ms = limits().checkSeconds * 1000;
    if (live.some(([, p]) => now - p.startedAt < FAST_CHECK_FOR_MS)) ms = Math.min(ms, FAST_CHECK_MS);
  }
  const due = Date.now() + ms;
  if (watchTimer && !force && watchDue <= due) return;
  clearTimeout(watchTimer);
  watchDue = due;
  watchTimer = setTimeout(() => {
    watchTimer = null;
    watchBackends().finally(() => scheduleWatch());
  }, ms);
  watchTimer.unref?.();
}

/**
 * One check of every running backend process against the limits. Exported for tests; the
 * timer calls it. Resolves once any kills it started have been sent.
 */
export async function watchBackends() {
  if (watching) return;
  watching = true;
  /** pids frozen while listing again: shell pid → [pids], SIGCONT'd unless killed */
  const frozen = new Map();
  const thaw = (pid) => {
    for (const p of frozen.get(pid) || []) signal(p, "SIGCONT");
    frozen.delete(pid);
  };
  try {
    const live = liveProcs();
    if (!live.length) return;
    const lim = limits();
    if (!lim.maxProcesses && !lim.maxMemoryMB && !lim.cpuPercent) return;
    const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms).unref?.());
    const first = processTable();
    let table = await Promise.race([first, timeout(PS_STARVED_MS)]);
    if (!table) {
      for (const [, proc] of live) {
        if (!proc.child || proc.stopping) continue;
        signal(-proc.child.pid, "SIGSTOP");
        for (const p of proc.outside || []) signal(p, "SIGSTOP");
        frozen.set(proc.child.pid, [-proc.child.pid, ...(proc.outside || [])]);
      }
      // Children mid-fork when the signal landed weren't stopped: stop the groups again every
      // few ms for a moment first (spawning ps blocks this thread, so not only during it).
      const restopAll = () => {
        for (const pid of frozen.keys()) signal(-pid, "SIGSTOP");
      };
      for (let i = 0; i < 20; i++) {
        await timeout(5);
        restopAll();
      }
      const restop = setInterval(restopAll, 15);
      console.log(`[quire] backend: ps is starved (a fork storm?); froze ${frozen.size} backend processes to look`);
      table = await Promise.race([first, processTable(), timeout(PS_GIVE_UP_MS)]);
      clearInterval(restop);
    }
    if (!table) return;
    const now = Date.now();
    const verdicts = [];
    for (const [entry, proc] of live) {
      if (!proc.child || proc.stopping || !entry.alive) continue;
      const use = backendUsage(table, proc.child.pid, proc.outside);
      if (!use) continue;
      proc.pids = use.pids;
      // Descendants that left the group: a group signal misses them, so they get their own.
      proc.outside = use.pids.filter((p) => table.get(p)?.pgid !== proc.child.pid);
      proc.usage = { memory: use.memory, cpu: use.cpu, processes: use.processes };
      const mb = Math.round(use.memory / (1024 * 1024));
      if (lim.maxProcesses && use.processes > lim.maxProcesses) {
        verdicts.push([entry, proc, "processes", `too many processes (${use.processes})`, `${use.processes} > ${lim.maxProcesses}`, true]);
      } else if (lim.maxMemoryMB && mb > lim.maxMemoryMB) {
        verdicts.push([entry, proc, "memory", `used too much memory (${mb} MB)`, `${mb} MB > ${lim.maxMemoryMB} MB`, false]);
      } else if (lim.cpuPercent && use.cpu >= lim.cpuPercent) {
        if (proc.cpuSince == null) proc.cpuSince = now;
        const secs = Math.round((now - proc.cpuSince) / 1000);
        if (now - proc.cpuSince >= lim.cpuSeconds * 1000) {
          const pct = Math.round(use.cpu);
          verdicts.push([entry, proc, "cpu", `used ${pct}% CPU for ${secs}s`, `${pct}% ≥ ${lim.cpuPercent}% for ${secs}s`, false]);
        }
      } else proc.cpuSince = null;
    }
    // Let everything not being killed outright go on before the graceful stops: a stopped
    // process wouldn't act on SIGTERM until continued.
    const bombs = new Set(verdicts.filter((v) => v[5]).map((v) => v[1].child.pid));
    for (const pid of [...frozen.keys()]) if (!bombs.has(pid)) thaw(pid);
    await Promise.all(verdicts.map((v) => limitStop(...v)));
  } finally {
    // Never leave a backend frozen, whatever happened above (a killed one ignores SIGCONT).
    for (const pid of [...frozen.keys()]) thaw(pid);
    watching = false;
  }
}

/**
 * Stop one backend process because it went over a limit: it stays stopped (with the reason in
 * its status and log) until a manual Restart. `now` kills at once with no grace (fork bombs).
 */
async function limitStop(entry, proc, code, reason, detail, now) {
  const child = proc.child;
  if (!child) return;
  clearTimeout(proc.retry);
  proc.stopping = true;
  proc.reason = reason;
  proc.limitHit = code;
  appendLog(proc, `[quire] stopped: ${reason.replace(/\s*\(.*\)$/, "")} (${detail})\n`);
  console.log(`[quire] backend: stopping ${entry.path} ${proc.name}: ${reason}`);
  if (now) {
    const exited = new Promise((r) => child.once("exit", r));
    await killBomb(child.pid, proc.pids || [], proc.outside ? proc.outside.length : 1);
    // SIGKILL can't be ignored; the exit event follows. Don't wait forever on a stuck shell.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000).unref?.())]);
  } else await killTree(child, proc.outside || []);
  // The exit handler marked it "stopped"; descendants that left the group are gone too.
  emit(entry);
}

export async function restartBackend(vault, pagePath) {
  const node = findPage(vault, pagePath);
  const entry = node.id && pages.get(node.id);
  if (!entry) return ensureBackend(vault, pagePath);
  touch(entry);
  await stopAll(entry);
  for (const p of entry.procs.values()) {
    p.restarts = 0;
    p.crashes = [];
  }
  await startAll(entry);
  return snapshot(entry);
}

/** Restart soon (debounced): files in the backend folder changed. */
export function backendFilesChanged(vault, pagePath) {
  let node;
  try {
    node = findPage(vault, pagePath);
  } catch {
    return;
  }
  const entry = node.id && pages.get(node.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => restartBackend(vault, pagePath).catch(() => {}), RESTART_DEBOUNCE_MS);
}

export function backendStatus(vault, pagePath) {
  let node;
  try {
    node = findPage(vault, pagePath);
  } catch {
    return null;
  }
  const entry = node.id && pages.get(node.id);
  // Asked for by the renderer for the selected page / Backend panel: that's a use.
  if (entry) return (touch(entry), snapshot(entry));
  if (!node.backend || !Object.keys(node.backend.run).length) return null;
  const gate = node.id ? blocked.get(node.id) : null;
  const reason = gate ? gate.message : (node.id && stoppedBy.get(node.id)) || null;
  return {
    ...stoppedSnapshot(
      { path: node.path, dir: node.backend.dir, proxy: node.backend.proxy, requires: node.requires || null, procs: Object.entries(node.backend.run).map(([name, cmd]) => ({ name, cmd, port: null })) },
      reason,
    ),
    ...(gate ? { blocked: gate.reason } : {}),
  };
}

export function backendLog(vault, pagePath, name) {
  const node = findPage(vault, pagePath);
  const proc = node.id && pages.get(node.id)?.procs.get(name);
  if (proc) return proc.log;
  try {
    return fs.readFileSync(logFile(node.id, name), "utf8").slice(-LOG_MAX);
  } catch {
    return "";
  }
}

/** Wait until a process listens on its port (or exits, or `ms` pass). True if it listens. */
async function waitListening(proc, ms) {
  for (const until = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 100))) {
    if (!(await portFree(proc.port))) return true;
    if (!proc.child || Date.now() > until) return false;
  }
}

/**
 * Port of the process /api/* goes to, starting the backend if needed (it may have been stopped
 * for being idle) and waiting for it to listen. With `{wait: false}` it doesn't wait.
 * Throws an Error with .status 503 when it doesn't come up in time.
 */
export async function proxyPort(vault, pagePath, { wait = true } = {}) {
  const snap = await ensureBackend(vault, pagePath);
  if (!snap) {
    // Kept from starting by the trust gate: say why instead of "no backend".
    let node = null;
    try {
      node = findPage(vault, pagePath);
    } catch {}
    const gate = node && node.id ? blocked.get(node.id) : null;
    if (gate) throw Object.assign(new Error(`${gate.message} The backend for ${node.path} isn't running.`), { status: 403 });
  }
  if (!snap || !snap.proxy) return null;
  const p = snap.procs.find((x) => x.name === snap.proxy);
  if (!p) return null;
  if (wait && p.state !== "running") {
    const node = findPage(vault, pagePath);
    const proc = pages.get(node.id)?.procs.get(p.name);
    if (proc && !(await waitListening(proc, LISTEN_TIMEOUT_MS))) {
      const err = new Error(
        proc.reason
          ? `The backend "${p.name}" for ${snap.path} isn't running. ${BRAND.name} stopped it: ${proc.reason.replace(/ — .*$/, "")}. Restart it from the Backend panel.`
          : `The backend "${p.name}" for ${snap.path} didn't start listening on port ${p.port} within ${LISTEN_TIMEOUT_MS / 1000} s (state: ${proc.state}). See its log in the Backend panel.`,
      );
      err.status = 503;
      throw err;
    }
  }
  return p.port;
}

/* ------------------------------------------------------------ activity */

/**
 * Every running backend with its processes' pids, for Settings → Activity & limits. Doesn't count as a
 * use (unlike backendStatus).
 */
export function listBackends() {
  return [...pages.values()].map((e) => ({
    id: e.id,
    vault: e.vault,
    path: e.path,
    proxy: e.cfg.proxy,
    lastUsed: e.lastUsed,
    procs: [...e.procs.values()].map((p) => ({
      name: p.name,
      cmd: p.cmd,
      port: p.port,
      state: p.state,
      pid: p.child?.pid ?? null,
      startedAt: p.startedAt,
      restarts: p.restarts,
      reason: p.reason || null,
      limitHit: p.limitHit || null,
      logPath: p.logPath,
    })),
  }));
}

/** For a page that isn't running: why Quire stopped it ("idle" | "cap" | null) and when it was last used. */
export function stoppedInfo(id) {
  return { reason: stoppedBy.get(id) || null, lastUsed: lastUsedOf.get(id) || null };
}

export const backendLogPath = (id, name) => logFile(id, name);

/**
 * Apply config.json "backends" now rather than at the next check: stop the idle ones, stop
 * least-recently-used ones until the cap fits, and re-time the idle sweep.
 */
export async function applyBackendLimits() {
  clearTimeout(sweepTimer);
  sweepTimer = null;
  sweepIdle();
  const { maxRunning } = backendLimits();
  const stops = [];
  if (maxRunning) {
    const running = [...pages.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    while (running.length > maxRunning) {
      const lru = running.shift();
      console.log(`[quire] backend: stopping ${lru.path} (least recently used; ${maxRunning} max running)`);
      stops.push(stopBackend(lru.id, "cap"));
    }
  }
  scheduleSweep();
  scheduleWatch(0, true);
  await Promise.all([...stops, ...stopping.values()]);
}

/**
 * Settings → Activity & limits: save {idleMinutes (0–1440), maxRunning (0–100)} to config.json
 * "backends" (either may be left out; 0 turns it off) and apply it right away.
 */
export async function setBackendPolicy(policy = {}) {
  const int = (v, lo, hi, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be a whole number from ${lo} to ${hi}`);
    return n;
  };
  const patch = {};
  if (policy && policy.idleMinutes !== undefined) patch.idleMinutes = int(policy.idleMinutes, 0, 1440, "Idle minutes");
  if (policy && policy.maxRunning !== undefined) patch.maxRunning = int(policy.maxRunning, 0, 100, "Max running");
  setLimits(patch);
  await applyBackendLimits();
  return backendLimits();
}

/** Stop every backend (vault switch, quit). */
export async function stopAllBackends() {
  clearTimeout(sweepTimer);
  sweepTimer = null;
  clearTimeout(watchTimer);
  watchTimer = null;
  await Promise.all([...pages.keys()].map((id) => stopBackend(id)));
  await Promise.all([...stopping.values()]);
  stoppedBy.clear();
}

/** Synchronous best effort, for process exit. */
export function killAllBackendsNow() {
  for (const entry of pages.values()) {
    for (const p of entry.procs.values()) {
      if (!p.child) continue;
      signal(-p.child.pid, "SIGTERM");
      for (const x of p.outside || []) signal(x, "SIGTERM");
    }
  }
}
