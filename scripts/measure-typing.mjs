// Typing-lag measurement: reproduces the app's save cycle against a temp vault and reports
// how long the main process is blocked, per save and per commit, and how often while typing.
//
//   node scripts/measure-typing.mjs                 synthetic vault (5k files, like a real one)
//   node scripts/measure-typing.mjs --clone <vault> a local clone of a real vault (read-only)
//   --files N --paras N --seconds N --sync-every N  vault size, page size, typing run, sync tick
//
// "Blocked" means the Node event loop could not run: in Electron's main process that is the
// browser process's UI thread, which also delivers keystrokes to the page, so a block there is
// a typing freeze. The typing run compares the old autosave path (sync git, inline below) with
// the shipped one (app/main/autosave.mjs) and counts event-loop stalls of 16 ms or more.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const FILES = Number(arg("files", 5000));
const PARAS = Number(arg("paras", 150));
const SECONDS = Number(arg("seconds", 35));
const SYNC_EVERY = Number(arg("sync-every", 15));
const CLONE = arg("clone", null);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-typing-"));
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
const { commitAll, commitAllAsync, gitStats, applyRegions, indexBody } = await import("../core/index.mjs");
const autosave = await import("../app/main/autosave.mjs");

const sh = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ms = (n) => `${n.toFixed(1)} ms`;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { med: s[Math.floor(s.length / 2)], max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
};

/* ---- vault */

const vault = path.join(tmp, "vault");
if (CLONE) {
  execFileSync("git", ["clone", "-q", "--local", path.resolve(CLONE), vault]);
} else {
  fs.mkdirSync(vault);
  sh(vault, "init", "-q", "-b", "main");
  const perPage = 50;
  for (let p = 0; p < Math.ceil(FILES / perPage); p++) {
    const dir = path.join(vault, `Page ${p}`);
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".noteblock"), JSON.stringify({ id: `p${p}`, entry: "index.html" }) + "\n");
    fs.writeFileSync(path.join(dir, "index.html"), `<h1>Page ${p}</h1>\n<p>hello</p>\n`);
    for (let f = 0; f < perPage - 2; f++) fs.writeFileSync(path.join(dir, "assets", `f${f}.js`), `export const v${f} = ${f};\n`);
  }
}
const pageDir = path.join(vault, "Typing");
fs.mkdirSync(pageDir, { recursive: true });
fs.writeFileSync(path.join(pageDir, ".noteblock"), JSON.stringify({ id: "typing", entry: "index.html" }) + "\n");
const sentence = "The quick brown fox jumps over the lazy dog while the editor saves every pause.";
const paras = Array.from({ length: PARAS }, (_, i) => `<p>${i}. ${sentence} ${sentence}</p>`);
const file = path.join(pageDir, "index.html");
fs.writeFileSync(file, `<h1>Typing</h1>\n${paras.join("\n")}\n`);
sh(vault, "add", "-A");
sh(vault, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "start");
sh(vault, "config", "user.name", "Measure");
sh(vault, "config", "user.email", "measure@quire.local");
const tracked = Number(execFileSync("sh", ["-c", `git -C "${vault}" ls-files | wc -l`], { encoding: "utf8" }).trim());
console.log(`vault: ${tracked} tracked files${CLONE ? ` (clone of ${CLONE})` : ""}; page: ${PARAS} paragraphs, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);

/* ---- the save the editor's rpc runs (ipc.mjs save()): read, applyRegions, write */

// The editor sends every region on every save; a prose page is one region holding all of it.
let text = "";
function regionsNow() {
  const html = `<h1>Typing</h1>\n` + paras.slice(0, -1).join("\n") + `\n<p>${text}</p>`;
  return [{ replace: Array.from({ length: PARAS + 1 }, (_, i) => i), before: null, html }];
}
function mainSave() {
  const t0 = performance.now();
  const raw = fs.readFileSync(file, "utf8");
  const next = applyRegions(raw, regionsNow());
  if (next !== raw) fs.writeFileSync(file, next);
  return performance.now() - t0;
}
const saveTimes = [];
for (let i = 0; i < 40; i++) {
  text += "word ";
  saveTimes.push(mainSave());
}
// What the protocol handler does when the page is (re)loaded: index the body.
const t0 = performance.now();
indexBody(fs.readFileSync(file, "utf8"));
const indexMs = performance.now() - t0;
sh(vault, "add", "-A");
sh(vault, "commit", "-qm", "saves");

/* ---- one commit, sync vs async */

function stallMonitor() {
  const stalls = [];
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    const gap = now - last - 2;
    if (gap >= 16) stalls.push({ at: now, ms: gap });
    last = now;
  }, 2);
  return { stalls, stop: () => clearInterval(tick) };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

const syncCommit = [];
let before = gitStats.syncCalls;
for (let i = 0; i < 8; i++) {
  text += "sync ";
  mainSave();
  const a = performance.now();
  assert.ok(commitAll(vault, "Edit Typing"));
  syncCommit.push(performance.now() - a);
}
const syncSpawns = (gitStats.syncCalls - before) / 8;

const asyncTotal = [];
const asyncStall = [];
before = gitStats.asyncCalls;
for (let i = 0; i < 8; i++) {
  text += "async ";
  mainSave();
  await settle();
  const mon = stallMonitor();
  const a = performance.now();
  assert.ok(await commitAllAsync(vault, "Edit Typing"));
  asyncTotal.push(performance.now() - a);
  await settle();
  mon.stop();
  asyncStall.push(mon.stalls.reduce((m, s) => Math.max(m, s.ms), 0));
}
const asyncSpawns = (gitStats.asyncCalls - before) / 8;

// A sync flush (quit) racing an async commit in flight: both finish, nothing is left over.
text += "race ";
mainSave();
const racing = commitAllAsync(vault, "Edit Typing");
commitAll(vault, "Quit flush");
await racing;
assert.equal(sh(vault, "status", "--porcelain"), "");

/* ---- typing at ~5 chars/s, old path vs new */

// Deterministic typist: 200 ms per key; 30% of word gaps hesitate +300 ms (a save fires after
// 400 ms of quiet, like the editor's SAVE_DEBOUNCE); every sentence ends with an 800 ms pause;
// one 6 s pause in the middle (an idle autosave commit).
function* keystrokes(seconds) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let t = 0;
  let pausedLong = false;
  while (t < seconds * 1000) {
    for (let w = 0; w < 12 && t < seconds * 1000; w++) {
      for (let c = 0; c < 5; c++) yield (t += 200);
      t += 200 + (rnd() < 0.3 ? 300 : 0);
      yield t;
    }
    t += 800;
    if (!pausedLong && t > (seconds * 1000) / 2) {
      t += 6000;
      pausedLong = true;
    }
  }
}

async function typingRun(label, { schedule, syncTick }) {
  const keys = [...keystrokes(SECONDS)];
  const mon = stallMonitor();
  const start = performance.now();
  let saves = 0;
  let saveMs = 0;
  let saveTimer = null;
  const syncTimer = setInterval(syncTick, SYNC_EVERY * 1000);
  const syncBefore = { calls: gitStats.syncCalls, ms: gitStats.syncMs };
  for (const at of keys) {
    const wait = start + at - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    text += "x";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saves++;
      saveMs += mainSave();
      schedule();
    }, 400);
  }
  await new Promise((r) => setTimeout(r, 6000)); // let the last save and commit land
  clearInterval(syncTimer);
  mon.stop();
  const typedS = keys[keys.length - 1] / 1000;
  const big = mon.stalls.filter((s) => s.ms >= 16);
  console.log(
    `\n${label}: ${keys.length} keys over ${typedS.toFixed(0)} s (${(keys.length / typedS).toFixed(1)} keys/s), ${saves} saves (${ms(saveMs / saves)} each)`,
  );
  console.log(`  sync git in the main process: ${gitStats.syncCalls - syncBefore.calls} calls, ${ms(gitStats.syncMs - syncBefore.ms)} blocked in total`);
  console.log(
    `  event-loop stalls >= 16 ms: ${big.length}${big.length ? ` — ${big.map((s) => `${((s.at - start) / 1000).toFixed(1)}s:${s.ms.toFixed(0)}ms`).join(", ")}` : ""}`,
  );
  return big;
}

// Old autosave.mjs, inline: commitAll (sync) 5 s after the last save, and sync.mjs's
// interval check ran flushAutosaves() (sync commit) whenever one was pending.
let legacyTimer = null;
const legacy = await typingRun("OLD (sync commit, sync flush on every sync check)", {
  schedule: () => {
    clearTimeout(legacyTimer);
    legacyTimer = setTimeout(() => {
      legacyTimer = null;
      commitAll(vault, "Edit Typing");
    }, autosave.AUTOSAVE_DELAY);
  },
  syncTick: () => {
    if (!legacyTimer) return;
    clearTimeout(legacyTimer);
    legacyTimer = null;
    commitAll(vault, "Edit Typing");
  },
});

const current = await typingRun("NEW (app/main/autosave.mjs: async commit, async flush)", {
  schedule: () => autosave.scheduleAutosave(vault, "Typing"),
  syncTick: () => autosave.flushAutosavesAsync(vault),
});
await autosave.flushAutosavesAsync(vault);
assert.equal(sh(vault, "status", "--porcelain"), "", "every change ends up committed");

/* ---- report */

const s = stats(saveTimes);
const sc = stats(syncCommit);
const ac = stats(asyncTotal);
const as = stats(asyncStall);
console.log(`
per save (main: read + applyRegions + write, whole file): median ${ms(s.med)}, max ${ms(s.max)}
page reload (indexBody, what a foreign-change reload costs main): ${ms(indexMs)}
one autosave commit, OLD sync commitAll: ${syncSpawns} git spawns, main blocked median ${ms(sc.med)}, max ${ms(sc.max)}
one autosave commit, NEW commitAllAsync: ${asyncSpawns} git spawns, ${ms(ac.med)} wall, longest event-loop stall median ${ms(as.med)}, max ${ms(as.max)}
typing run stalls >= 16 ms: OLD ${legacy.length}, NEW ${current.length} (sync check every ${SYNC_EVERY} s here; the app's default is 30 s)`);

fs.rmSync(tmp, { recursive: true, force: true });
