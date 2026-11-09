// Settings → Activity & limits: memory and CPU of Quire itself and of every page backend in the vault.
// One `ps` call per snapshot gives every process's parent, RSS and CPU; a backend's usage is its
// /bin/sh plus everything in its process group or under it (the run command's node, bun,
// python…). backend.mjs's watchdog uses the same table and backendUsage() for its limits.
import { execFile } from "node:child_process";
import { listTree, walkTree } from "../../core/index.mjs";
import { listBackends, stoppedInfo, backendLimits, backendLogPath } from "./backend.mjs";
import { listBuilds } from "./builds.mjs";

/** pid → {ppid, pgid, rss (bytes), cpu (%)} for every process, from one `ps -A`. */
export function processTable() {
  // Windows has no ps: memory/CPU per backend and the watchdog's limits are Mac-only for now.
  if (process.platform === "win32") return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,rss=,pcpu="], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? new Map() : parsePs(stdout));
    });
  });
}

/** `pid ppid pgid rss pcpu` lines (or `pid ppid rss pcpu`, pgid then unknown = null). */
export function parsePs(text) {
  const table = new Map();
  for (const line of String(text || "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || !/^\d+$/.test(f[0])) continue;
    const [pid, ppid, pgid, rss, cpu] = f.length >= 5 ? f : [f[0], f[1], null, f[2], f[3]];
    table.set(Number(pid), { ppid: Number(ppid), pgid: pgid == null ? null : Number(pgid), rss: Number(rss) * 1024, cpu: Number(cpu) || 0 });
  }
  return table;
}

/**
 * The processes of one backend process: everything in its process group (the /bin/sh is
 * spawned detached, so it leads a group of its own) plus every descendant of any of those by
 * parent pid, so a child that moved to a new group or session with setsid but stayed a
 * descendant is still counted. One that fully escapes (its parent exits and it is reparented
 * to launchd in a new session) can't be told apart from any other process and isn't counted.
 * `known` adds pids found earlier (still counted while alive, and their descendants too).
 * Returns {memory (bytes), cpu (%), processes, pids} or null when nothing of it is running.
 */
export function backendUsage(table, pid, known = []) {
  if (!pid) return null;
  const kids = new Map();
  const roots = [];
  for (const [p, row] of table) {
    if (!kids.has(row.ppid)) kids.set(row.ppid, []);
    kids.get(row.ppid).push(p);
    if (row.pgid === pid) roots.push(p);
  }
  if (table.has(pid)) roots.push(pid);
  for (const k of known) if (table.has(k)) roots.push(k);
  if (!roots.length) return null;
  let memory = 0;
  let cpu = 0;
  const seen = new Set();
  const stack = roots;
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    const row = table.get(p);
    if (!row) continue;
    seen.add(p);
    memory += row.rss;
    cpu += row.cpu;
    for (const k of kids.get(p) || []) if (k !== p && k > 1) stack.push(k);
  }
  return { memory, cpu: Math.round(cpu * 10) / 10, processes: seen.size, pids: [...seen] };
}

/** Memory (bytes) and CPU (%) of `pid` and all its descendants; null when it isn't running. */
export function treeUsage(table, pid) {
  if (!pid || !table.has(pid)) return null;
  const kids = new Map();
  for (const [p, row] of table) {
    if (!kids.has(row.ppid)) kids.set(row.ppid, []);
    kids.get(row.ppid).push(p);
  }
  let memory = 0;
  let cpu = 0;
  let count = 0;
  const seen = new Set();
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    const row = table.get(p);
    if (!row) continue;
    memory += row.rss;
    cpu += row.cpu;
    count++;
    for (const k of kids.get(p) || []) if (k !== p) stack.push(k);
  }
  return { memory, cpu: Math.round(cpu * 10) / 10, processes: count };
}

const APP_GROUPS = { Browser: "Main", Tab: "Renderer and pages", GPU: "GPU", Utility: "Utility" };

/** app.getAppMetrics() summed by type. KB → bytes. */
export function summarizeAppMetrics(metrics) {
  const groups = new Map();
  for (const m of metrics || []) {
    const label = APP_GROUPS[m.type] || "Other";
    const g = groups.get(label) || { label, processes: 0, memory: 0, cpu: 0 };
    g.processes++;
    g.memory += (m.memory?.workingSetSize || 0) * 1024;
    g.cpu += m.cpu?.percentCPUUsage || 0;
    groups.set(label, g);
  }
  const order = ["Main", "Renderer and pages", "GPU", "Utility", "Other"];
  return [...groups.values()].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)).map((g) => ({ ...g, cpu: Math.round(g.cpu * 10) / 10 }));
}

async function defaultAppMetrics() {
  try {
    const electron = await import("electron");
    return electron.app?.getAppMetrics?.() || [];
  } catch {
    return [];
  }
}

/**
 * Everything Settings → Activity & limits shows.
 * @param {string} vault
 * @param {{appMetrics?: () => any[] | Promise<any[]>, pageProcesses?: () => {pid: number, memoryMB: number|null, pages: string[]}[]}} [opts]
 *   pageProcesses: the renderer processes showing pages (page-health.mjs), one per page origin
 */
export async function activitySnapshot(vault, { appMetrics = defaultAppMetrics, pageProcesses = () => [] } = {}) {
  const [table, metrics] = await Promise.all([processTable(), appMetrics()]);
  const now = Date.now();
  const running = new Map(listBackends().filter((b) => b.vault === vault).map((b) => [b.id, b]));

  const backends = [];
  const seen = new Set();
  const pushRunning = (b, title) => {
    seen.add(b.id);
    for (const p of b.procs) {
      const use = backendUsage(table, p.pid);
      backends.push({
        page: b.path,
        title: title || b.path.split("/").pop(),
        name: p.name,
        cmd: p.cmd,
        pid: p.pid,
        port: p.port,
        state: p.state,
        reason: p.reason || null,
        limitHit: p.limitHit || null,
        startedAt: p.startedAt || null,
        uptimeMs: p.pid && p.startedAt ? now - p.startedAt : null,
        lastUsed: b.lastUsed,
        restarts: p.restarts,
        memory: use ? use.memory : null,
        cpu: use ? use.cpu : null,
        processes: use ? use.processes : 0,
        logPath: p.logPath,
      });
    }
  };

  let tree = [];
  try {
    tree = listTree(vault);
  } catch {}
  for (const n of walkTree(tree)) {
    if (n.kind !== "page" || !n.backend || !n.id || !Object.keys(n.backend.run).length) continue;
    const b = running.get(n.id);
    if (b) {
      pushRunning(b, n.title);
      continue;
    }
    const { reason, lastUsed } = stoppedInfo(n.id);
    for (const [name, cmd] of Object.entries(n.backend.run)) {
      backends.push({
        page: n.path,
        title: n.title,
        name,
        cmd,
        pid: null,
        port: null,
        state: "stopped",
        reason,
        limitHit: reason,
        startedAt: null,
        uptimeMs: null,
        lastUsed,
        restarts: 0,
        memory: null,
        cpu: null,
        processes: 0,
        logPath: backendLogPath(n.id, name),
      });
    }
  }
  // Running ones whose page moved out of the tree since they started.
  for (const b of running.values()) if (!seen.has(b.id)) pushRunning(b, null);

  const builds = listBuilds()
    .filter((b) => b.vault === vault)
    .map((b) => {
      const use = treeUsage(table, b.pid);
      return { page: b.path, pid: b.pid, startedAt: b.startedAt, memory: use ? use.memory : null, cpu: use ? use.cpu : null };
    });

  // Page renderers: one process per page (and per embedded page), each page its own origin.
  const titles = new Map();
  for (const n of walkTree(tree)) if (n.kind === "page") titles.set(n.path, n.title);
  let procs = [];
  try {
    procs = pageProcesses() || [];
  } catch {}
  const pageRows = procs.map((p) => ({
    pid: p.pid,
    memory: p.memoryMB != null ? p.memoryMB * 1024 * 1024 : null,
    pages: p.pages.map((path) => ({ path, title: titles.get(path) || path.split("/").pop() })),
  }));
  const pagesInfo = { processes: pageRows.length, memory: pageRows.reduce((t, r) => t + (r.memory || 0), 0), top: pageRows.slice(0, 5) };

  const app = summarizeAppMetrics(metrics);
  const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  const appMemory = sum(app, "memory");
  const backendMemory = sum(backends, "memory");
  const buildMemory = sum(builds, "memory");
  const { idleMs, maxRunning } = backendLimits();
  return {
    at: now,
    app,
    backends,
    builds,
    pages: pagesInfo,
    limits: { idleMinutes: idleMs / 60000, maxRunning },
    running: running.size, // pages whose backend is up (what maxRunning counts)
    totals: {
      app: { memory: appMemory, cpu: Math.round(sum(app, "cpu") * 10) / 10 },
      backends: { memory: backendMemory, cpu: Math.round(sum(backends, "cpu") * 10) / 10 },
      builds: { memory: buildMemory },
      overall: { memory: appMemory + backendMemory + buildMemory },
    },
  };
}
