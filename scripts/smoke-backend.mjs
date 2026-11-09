// Smoke test for page backends: config parsing, .env, a real process with its own port, stop,
// idle stop + transparent restart through proxyPort, the max-running cap (LRU), and Settings →
// Activity: listBackends' pids, the memory of a backend's whole process tree, and the policy
// setter applying at once. Then the watchdog's limits, on real (bounded, self-ending) runaway
// backends: a process tree over maxProcesses, memory over maxMemoryMB, a CPU spinner, and a
// crash loop. Every process those start writes its pid to a file, and the finally block kills
// each of them, so a failed assertion never leaves anything behind.
// Run: node scripts/smoke-backend.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-backend-"));
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
const { parseBackend, createVault, createPage, writeManifest, readManifest } = await import("../core/index.mjs");
const { parseDotenv, ensureBackend, stopAllBackends, backendStatus, onBackendStatus, proxyPort, backendLimits, listBackends, setBackendPolicy, applyBackendLimits, restartBackend, backendLog, PORT_MIN, PORT_MAX } = await import("../app/main/backend.mjs");
const { approveCommands } = await import("../app/main/trust.mjs");
const { activitySnapshot, parsePs, treeUsage, backendUsage, summarizeAppMetrics } = await import("../app/main/activity.mjs");
const { limits, limitsSchema, setLimits: saveLimits, resetLimits } = await import("../app/main/limits.mjs");
// Every pid a limit test's processes wrote down; the finally block kills whatever is left.
const pidFiles = [];
const pidsIn = (file) => {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const reap = () => {
  for (const file of pidFiles) for (const pid of pidsIn(file)) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch {}
};
const procOf = (pagePath) => listBackends().find((b) => b.path === pagePath)?.procs[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setLimits = (backends) => fs.writeFileSync(path.join(tmp, "config", "config.json"), JSON.stringify({ backends }));
const until = async (what, fn, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return;
  throw new Error(`timed out waiting for ${what}`);
};

try {
  assert.equal(parseBackend(null), null);
  assert.deepEqual(parseBackend({ run: "node s.js" }), { dir: "backend", run: { main: "node s.js" }, proxy: "main" });
  assert.deepEqual(parseBackend({ dir: "srv", run: { db: "x", api: "y", "bad name": "z" } }), { dir: "srv", run: { db: "x", api: "y" }, proxy: "api" });
  assert.equal(parseBackend({ dir: "../up", run: "x" }).dir, "backend");
  assert.deepEqual(parseDotenv('A=1\n# no\nexport B="two words"\nC=\'x#y\' \nD=plain # comment'), { A: "1", B: "two words", C: "x#y", D: "plain" });

  const vault = createVault(path.join(tmp, "V"), { name: "V", seed: false });
  const page = createPage(vault, "Echo");
  writeManifest(page.dir, { ...readManifest(page.dir), backend: { run: { api: "node server.js", side: "sleep 30" } } });
  fs.mkdirSync(path.join(page.dir, "backend"));
  fs.writeFileSync(path.join(page.dir, "backend", ".env"), "SECRET=shh\n");
  fs.writeFileSync(
    path.join(page.dir, "backend", "server.js"),
    `require("node:http").createServer((q, r) => r.end(JSON.stringify({ url: q.url, secret: process.env.SECRET, side: process.env.PORT_SIDE }))).listen(process.env.PORT, "127.0.0.1");`,
  );

  const snap = await ensureBackend(vault, "Echo");
  const api = snap.procs.find((p) => p.name === "api");
  const side = snap.procs.find((p) => p.name === "side");
  assert.ok(api.port >= PORT_MIN && api.port <= PORT_MAX && side.port !== api.port);
  let body = null;
  for (let i = 0; i < 50 && !body; i++) {
    try {
      body = await fetch(`http://127.0.0.1:${api.port}/api/hi?x=1`).then((r) => r.json());
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.deepEqual(body, { url: "/api/hi?x=1", secret: "shh", side: String(side.port) });
  // Same port next time.
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "config", "ports.json"), "utf8"))[`${page.id}:api`], api.port);

  await stopAllBackends();
  assert.ok(backendStatus(vault, "Echo").procs.every((p) => p.state === "stopped" && !p.reason));

  // Defaults, then config.
  assert.deepEqual(backendLimits(), { idleMs: 15 * 60000, maxRunning: 12 });
  setLimits({ idleMinutes: 1 / 60, maxRunning: 0 });
  assert.deepEqual(backendLimits(), { idleMs: 1000, maxRunning: 0 });

  // Idle 1 s: stops on its own, reports why, and the next proxied request brings it back.
  await ensureBackend(vault, "Echo");
  // (Polled through the status events: asking backendStatus counts as a use, like the renderer's.)
  let last = null;
  onBackendStatus((snap) => snap.path === "Echo" && (last = snap));
  await until("idle stop", () => last?.procs.every((p) => p.state === "stopped" && p.reason === "idle"));
  assert.ok(backendStatus(vault, "Echo").procs.every((p) => p.state === "stopped" && p.reason === "idle"));
  await sleep(300); // the processes are gone, not just marked
  const port = await proxyPort(vault, "Echo"); // waits for it to listen
  assert.equal(port, api.port, "same port after an idle restart");
  body = await fetch(`http://127.0.0.1:${port}/api/again`).then((r) => r.json());
  assert.equal(body.url, "/api/again");
  assert.ok(backendStatus(vault, "Echo").procs.every((p) => p.state !== "stopped"));
  await stopAllBackends();

  // Cap 1 (idle off): starting a second page's backend stops the least recently used one.
  setLimits({ idleMinutes: 0, maxRunning: 1 });
  const two = createPage(vault, "Two");
  writeManifest(two.dir, { ...readManifest(two.dir), backend: { run: "sleep 30" } });
  approveCommands(vault, two.path); // written by the person, as the app approves its own edits
  await ensureBackend(vault, "Echo");
  await ensureBackend(vault, "Two");
  await until("cap stop", () => backendStatus(vault, "Echo").procs.every((p) => p.state === "stopped" && p.reason === "cap"));
  assert.ok(backendStatus(vault, "Two").procs.every((p) => p.state !== "stopped"));
  await proxyPort(vault, "Echo");
  await until("cap stop of Two", () => backendStatus(vault, "Two").procs[0].reason === "cap");
  assert.ok(backendStatus(vault, "Echo").procs.every((p) => p.state !== "stopped"));
  await stopAllBackends();

  // Activity: the tree walk, on a made-up ps table (a cycle and an unrelated process too).
  const table = parsePs("  10     1  1000   1.5\n  11    10  2000   0.5\n  12    11   500   0.0\n  13     1  9999  50.0\n  14    14    10   0.0\n");
  assert.deepEqual(treeUsage(table, 10), { memory: 3500 * 1024, cpu: 2, processes: 3 });
  assert.equal(treeUsage(table, 99), null);
  assert.deepEqual(
    summarizeAppMetrics([
      { type: "Browser", memory: { workingSetSize: 100 }, cpu: { percentCPUUsage: 1 } },
      { type: "Tab", memory: { workingSetSize: 50 }, cpu: { percentCPUUsage: 0.5 } },
      { type: "Tab", memory: { workingSetSize: 50 }, cpu: { percentCPUUsage: 0.5 } },
    ]).map((g) => [g.label, g.processes, g.memory, g.cpu]),
    [["Main", 1, 102400, 1], ["Renderer and pages", 2, 102400, 1]],
  );

  // A real backend whose shell runs two node children: all three are counted.
  setLimits({ idleMinutes: 0, maxRunning: 0 });
  const tree = createPage(vault, "Tree");
  const idler = `node -e "setInterval(() => {}, 1000)"`;
  writeManifest(tree.dir, { ...readManifest(tree.dir), backend: { run: `${idler} & ${idler} & wait` } });
  approveCommands(vault, tree.path); // written by the person, as the app approves its own edits
  await ensureBackend(vault, "Tree");
  const [listed] = listBackends();
  assert.equal(listed.path, "Tree");
  assert.ok(listed.procs[0].pid > 0 && listed.lastUsed > 0);
  let act = null;
  await until("tree of 3 processes", async () => {
    act = await activitySnapshot(vault, { appMetrics: () => [] });
    const r = act.backends.find((b) => b.page === "Tree");
    return r?.processes === 3 && r.memory > 2 * 10 * 1024 * 1024; // (once both nodes have loaded)
  });
  const row = act.backends.find((b) => b.page === "Tree");
  assert.equal(row.state === "running" || row.state === "starting", true);
  assert.equal(row.pid, listed.procs[0].pid);
  assert.ok(row.memory > 2 * 10 * 1024 * 1024, `two node children hold > 20 MB (got ${row.memory})`);
  assert.equal(act.running, 1);
  assert.equal(act.totals.backends.memory, row.memory);
  // Pages with a backend that isn't running are listed too, stopped.
  assert.ok(act.backends.filter((b) => b.page === "Echo").every((b) => b.state === "stopped" && b.memory === null));
  assert.deepEqual(act.limits, { idleMinutes: 0, maxRunning: 0 });

  // Policy: lowering the cap stops the extra one now, not on the next start.
  await ensureBackend(vault, "Two");
  assert.equal(listBackends().length, 2);
  await assert.rejects(setBackendPolicy({ maxRunning: 101 }), /0 to 100/);
  await assert.rejects(setBackendPolicy({ idleMinutes: -1 }), /0 to 1440/);
  assert.deepEqual(await setBackendPolicy({ maxRunning: 1 }), { idleMs: 0, maxRunning: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, "config", "config.json"), "utf8")).backends, { idleMinutes: 0, maxRunning: 1 });
  assert.deepEqual(listBackends().map((b) => b.path), ["Two"]);
  assert.equal(backendStatus(vault, "Tree").procs[0].reason, "cap");
  // And turning the idle stop on applies at once too (the old sweep was 30 s away).
  await sleep(1100);
  setLimits({ idleMinutes: 1 / 60, maxRunning: 1 });
  await applyBackendLimits();
  assert.equal(listBackends().length, 0);
  assert.equal((await activitySnapshot(vault, { appMetrics: () => [] })).backends.find((b) => b.page === "Two").reason, "idle");
  await stopAllBackends();

  // ---------------------------------------------------------------- limits

  // limits.mjs: defaults, the schema, validation, reset, and backendLimits() reading it.
  assert.equal(limits().maxProcesses, 64);
  assert.equal(limitsSchema().find((l) => l.name === "errorBadge").kind, "boolean");
  assert.throws(() => saveLimits({ maxProcesses: -1 }), /0 to 4096/);
  assert.throws(() => saveLimits({ nope: 1 }), /Unknown limit/);
  saveLimits({ maxRunning: 7 });
  assert.equal(backendLimits().maxRunning, 7);
  resetLimits();
  assert.equal(backendLimits().maxRunning, 12);

  // The group + tree walk: 20 leads a group; 22 is in it with another parent; 23 setsid'd
  // (own group) but is 21's child; 30 is unrelated.
  const ptab = parsePs("  20     1    20  1000   1.0\n  21    20    20  1000   1.0\n  22     1    20  1000   1.0\n  23    21    23  1000   1.0\n  30     1    30  9999  99.0\n");
  assert.equal(ptab.get(23).pgid, 23);
  assert.deepEqual({ ...backendUsage(ptab, 20), pids: backendUsage(ptab, 20).pids.sort() }, { memory: 4000 * 1024, cpu: 4, processes: 4, pids: [20, 21, 22, 23] });
  assert.equal(backendUsage(ptab, 99), null);

  const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const limitPage = (name, run, files = {}) => {
    const pg = createPage(vault, name);
    writeManifest(pg.dir, { ...readManifest(pg.dir), backend: { run } });
    approveCommands(vault, pg.path); // written by the person, as the app approves its own edits
    fs.mkdirSync(path.join(pg.dir, "backend"), { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(pg.dir, "backend", f), text);
    return pg;
  };
  const pidFile = (name) => {
    const f = path.join(tmp, `${name}.pids`);
    pidFiles.push(f);
    return f;
  };
  const base = { idleMinutes: 0, maxRunning: 0, maxProcesses: 0, maxMemoryMB: 0, cpuPercent: 0, crashLimit: 0, checkSeconds: 1, stopGraceSeconds: 1 };

  // Too many processes: a tree of 200 shells (each sleeps 30 s then exits) plus one perl that
  // setsid()s into its own session but stays a child. maxProcesses 20 → all killed within 2 s.
  {
    const pids = pidFile("bomb");
    const perlPid = pidFile("perl");
    setLimits({ ...base, maxProcesses: 20 });
    limitPage("Bomb", `perl -MPOSIX -e 'POSIX::setsid() or die; open(F, ">>", $ARGV[0]); print F "$$\\n"; close F; sleep 30' ${sh(perlPid)} & sleep 0.1; exec sh bomb.sh 200 ${sh(pids)}`, {
      "bomb.sh": [
        "#!/bin/sh",
        "# $1 = processes in this subtree (this one included), $2 = pid file",
        'echo $$ >> "$2"',
        'n=$1',
        'if [ "$n" -gt 1 ]; then',
        '  a=$(( (n - 1) / 2 )); b=$(( n - 1 - a ))',
        '  if [ "$a" -gt 0 ]; then sh "$0" "$a" "$2" & fi',
        '  if [ "$b" -gt 0 ]; then sh "$0" "$b" "$2" & fi',
        "fi",
        "exec sleep 30",
        "",
      ].join("\n"),
    });
    // A well-behaved backend running alongside: it may be frozen while Quire looks, never left so.
    const calmPids = pidFile("calm");
    limitPage("Calm", `echo $$ >> ${sh(calmPids)}; exec node -e "setInterval(() => {}, 1000)"`);
    await ensureBackend(vault, "Calm");
    await until("calm running", () => pidsIn(calmPids).length === 1);
    const t0 = Date.now();
    await ensureBackend(vault, "Bomb");
    await until("too-many-processes stop", () => procOf("Bomb")?.limitHit === "processes" && procOf("Bomb").state === "stopped", 2000);
    const took = Date.now() - t0;
    const p = procOf("Bomb");
    assert.equal(p.state, "stopped");
    assert.match(p.reason, /^too many processes \(\d+\)$/);
    assert.match(backendLog(vault, "Bomb", "main"), /\[quire\] stopped: too many processes \(\d+ > 20\)/);
    const seen = pidsIn(pids);
    assert.ok(seen.length > 20, `the tree grew past the limit (${seen.length} pids)`);
    assert.equal(pidsIn(perlPid).length, 1, "the setsid'd perl ran");
    await until("every bomb process gone", () => [...pidsIn(pids), ...pidsIn(perlPid)].every((pid) => !alive(pid)), 2000);
    const calmStat = execFileSync("ps", ["-o", "stat=", "-p", String(pidsIn(calmPids)[0])], { encoding: "utf8" }).trim();
    assert.ok(!calmStat.includes("T"), `the other backend isn't left stopped (stat ${calmStat})`);
    assert.equal(procOf("Calm").reason, null);
    console.log(`  maxProcesses: stopped in ${took} ms; ${pidsIn(pids).length} processes started, all gone (setsid'd perl included)`);
    await stopAllBackends();
  }

  // Too much memory: node allocating 10 MB every 50 ms up to 600 MB (exits by itself after 20 s).
  {
    const pids = pidFile("mem");
    setLimits({ ...base, maxMemoryMB: 200 });
    limitPage("Hog", `echo $$ >> ${sh(pids)}; exec node mem.js`, {
      "mem.js": "const b = []; setInterval(() => b.length < 60 && b.push(Buffer.alloc(10 * 1024 * 1024, 1)), 50); setTimeout(() => process.exit(0), 20000);\n",
    });
    const t0 = Date.now();
    await ensureBackend(vault, "Hog");
    await until("memory stop", () => procOf("Hog")?.limitHit === "memory" && procOf("Hog").state === "stopped", 10000);
    assert.match(procOf("Hog").reason, /^used too much memory \(\d+ MB\)$/);
    await until("hog gone", () => pidsIn(pids).every((pid) => !alive(pid)), 3000);
    console.log(`  maxMemoryMB: ${procOf("Hog").reason} after ${Date.now() - t0} ms`);
    await stopAllBackends();
  }

  // CPU: a spinner (stops by itself after 20 s), cpuPercent 50 for 3 s.
  {
    const pids = pidFile("cpu");
    setLimits({ ...base, cpuPercent: 50, cpuSeconds: 3 });
    limitPage("Spin", `echo $$ >> ${sh(pids)}; exec node -e "const end = Date.now() + 20000; while (Date.now() < end) {}"`);
    const t0 = Date.now();
    await ensureBackend(vault, "Spin");
    await until("cpu stop", () => procOf("Spin")?.limitHit === "cpu" && procOf("Spin").state === "stopped", 15000);
    const took = Date.now() - t0;
    assert.ok(took >= 3000, `not before cpuSeconds (${took} ms)`);
    assert.match(procOf("Spin").reason, /^used \d+% CPU for \d+s$/);
    await until("spinner gone", () => pidsIn(pids).every((pid) => !alive(pid)), 3000);
    console.log(`  cpuPercent: ${procOf("Spin").reason} after ${took} ms`);
    await stopAllBackends();
  }

  // Crash loop: exit 1 at once, crashLimit 3 → gives up after the third, until a Restart.
  {
    setLimits({ ...base, crashLimit: 3, crashWindowMinutes: 2 });
    limitPage("Crashy", "exit 1");
    const t0 = Date.now();
    await ensureBackend(vault, "Crashy");
    await until("crash give-up", () => procOf("Crashy")?.limitHit === "crashes", 10000);
    const p = procOf("Crashy");
    assert.equal(p.state, "crashed");
    assert.equal(p.reason, "kept crashing (3 times in 2 min) — restart to try again");
    const runs = (backendLog(vault, "Crashy", "main").match(/\$ exit 1/g) || []).length;
    assert.equal(runs, 3);
    await sleep(2500);
    assert.equal((backendLog(vault, "Crashy", "main").match(/\$ exit 1/g) || []).length, 3, "no restart after giving up");
    console.log(`  crashLimit: gave up after 3 crashes in ${Date.now() - t0 - 2500} ms`);
    await restartBackend(vault, "Crashy");
    assert.equal(procOf("Crashy").reason, null, "a manual Restart clears it");
    await stopAllBackends();
  }

  console.log("smoke-backend: ok");
} finally {
  await stopAllBackends().catch(() => {});
  reap();
  fs.rmSync(tmp, { recursive: true, force: true });
}
