#!/usr/bin/env node
// make-bad-stuff.mjs — generate a "Bad stuff" folder of deliberately misbehaving Quire pages.
//
//   node scripts/make-bad-stuff.mjs "<vault>/Bad stuff"
//
// Rhett uses these to watch how Quire handles bad pages: frontend freezes/crashes/loops and
// backend fork bombs, memory hogs, crash loops, port grabs and SIGTERM-ignorers. Other agents
// are building the protections (page freeze/crash recovery + error badge; backend caps on
// processes/memory/CPU, crash-loop give-up — see app/main/limits.mjs). Each page here exercises
// one of them.
//
// HARD SAFETY RULE baked into every page: it is harmless to the Mac even if ALL of Quire's
// protections fail. Everything is bounded and ends by itself — fork bomb stops at 255 processes
// and every process exits after 60s; memory hogs cap near 3 GB, hold 30s, then stop; CPU
// spinners stop after 90s; log floods stop at 50 MB; no network, no file writes outside the
// page's own folder, no deletes, no setsid escapes outliving 60s, nothing needing sudo. Each
// page's text states its own bound.
//
// Idempotent: reruns rewrite the folder from scratch; ids are derived from the page name (sha1)
// so they are stable across reruns.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/make-bad-stuff.mjs "<vault>/Bad stuff"');
  process.exit(2);
}

/** Stable 10-char [a-z0-9] id from a page name (sha1 hex is already [0-9a-f]). */
const pageId = (name) => createHash("sha1").update("bad-stuff:" + name).digest("hex").slice(0, 10);

/** Full HTML document for a page: h1, blurb, bound note, an optional open-marker and body. */
function html({ title, onOpen, bound, blurb, body = "" }) {
  const marker = onOpen
    ? `<p class="mark">⚠ Misbehaves as soon as you open it.</p>`
    : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { max-width: 640px; margin: 40px auto; padding: 0 24px; font: 15px/1.55 system-ui, sans-serif; color: #15171c; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  .mark { color: #b23; font-weight: 600; }
  .bound { color: #2a7; font-weight: 600; }
  button { font: inherit; padding: 7px 16px; border-radius: 8px; border: 0; background: #15171c; color: #fff; cursor: pointer; }
  code { background: #f1f2f4; padding: 1px 5px; border-radius: 5px; }
</style>
</head>
<body>
<h1>${title}</h1>
${marker}
<p>${blurb}</p>
<p class="bound">Safety bound: ${bound}</p>
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------- frontend pages

const frontend = [];
const fe = (p) => frontend.push(p);

fe({
  name: "Infinite loop (on click)",
  blurb:
    "Click Start and the page runs a busy loop that blocks its own thread. Quire should detect the unresponsive page (<code>unresponsiveSeconds</code>) and offer to reload it, showing the page error badge.",
  bound: "the loop stops by itself after 90s, then the page recovers.",
  body: `<button id="go">Start (freezes ~90s, then recovers)</button>
<script>
document.getElementById("go").addEventListener("click", function () {
  var end = Date.now() + 90000;        // hard cap: 90 seconds
  while (Date.now() < end) { /* busy-wait, thread blocked, ends by itself */ }
  document.body.insertAdjacentHTML("beforeend", "<p>Recovered on its own.</p>");
});
</script>`,
});

fe({
  name: "Freezes for 10 seconds",
  blurb:
    "Click Start to busy-wait for 10 seconds, then the page comes back on its own. Quire may show the page as 'not responding' briefly; it should clear without a reload.",
  bound: "freezes for exactly 10s, then recovers by itself.",
  body: `<button id="go">Start (freezes 10s)</button>
<script>
document.getElementById("go").addEventListener("click", function () {
  var end = Date.now() + 10000;
  while (Date.now() < end) {}
  document.body.insertAdjacentHTML("beforeend", "<p>Recovered after 10s.</p>");
});
</script>`,
});

fe({
  name: "Freezes on open",
  onOpen: true,
  blurb:
    "Busy-waits for 10 seconds the moment it loads. Quire's unresponsive-page detection should fire on open, then clear when the loop ends.",
  bound: "freezes for exactly 10s on load, then recovers by itself.",
  body: `<p id="status">Freezing for 10s…</p>
<script>
var end = Date.now() + 10000;
while (Date.now() < end) {}
document.getElementById("status").textContent = "Recovered after 10s.";
</script>`,
});

fe({
  name: "Memory bomb",
  blurb:
    "Click Start to allocate 1 MB typed arrays in a loop until the tab crashes or the self-imposed ~3 GB cap is hit. Quire's page crash recovery / error badge should catch a crashed page; the backend memory cap does not apply (this is frontend memory).",
  bound: "stops at ~3 GB, holds 30s, then releases and stops.",
  body: `<button id="go">Start (grows to ~3 GB, then releases)</button>
<script>
document.getElementById("go").addEventListener("click", function () {
  var chunks = [], held = 0, CAP = 3 * 1024 * 1024 * 1024; // ~3 GB
  try {
    while (held < CAP) { var a = new Uint8Array(1024 * 1024); a[0] = 1; chunks.push(a); held += a.length; }
  } catch (e) { /* allocation failed before the cap: that is the crash we are testing */ }
  setTimeout(function () { chunks = []; }, 30000); // hold 30s, then release
});
</script>`,
});

fe({
  name: "DOM bomb",
  blurb:
    "Click Start to append DOM nodes as fast as possible. Quire should keep the rest of the app responsive and let the page be reloaded if it bogs down.",
  bound: "stops after 300,000 nodes.",
  body: `<button id="go">Start (appends up to 300k nodes)</button>
<div id="sink"></div>
<script>
var n = 0, MAX = 300000, sink = document.getElementById("sink");
document.getElementById("go").addEventListener("click", function step() {
  var frag = document.createDocumentFragment();
  for (var i = 0; i < 2000 && n < MAX; i++, n++) { var d = document.createElement("div"); d.textContent = "node " + n; frag.appendChild(d); }
  sink.appendChild(frag);
  if (n < MAX) setTimeout(step, 0);
});
</script>`,
});

fe({
  name: "Throws on load",
  onOpen: true,
  blurb:
    "Throws an uncaught error while loading. Quire should surface it in the page error badge without taking down the app.",
  bound: "throws once on load; nothing keeps running.",
  body: `<script>
throw new Error("Bad stuff: this page throws on load");
</script>`,
});

fe({
  name: "Unhandled promise rejection",
  onOpen: true,
  blurb:
    "Rejects a promise with no <code>.catch</code> on load. Quire should report the unhandled rejection in the page error badge.",
  bound: "rejects once on load; nothing keeps running.",
  body: `<script>
Promise.reject(new Error("Bad stuff: unhandled promise rejection"));
</script>`,
});

fe({
  name: "Error every second",
  blurb:
    "Click Start to throw an uncaught error once a second. This exercises the error badge's rate limiting — it should not flood or lock up the UI.",
  bound: "stops after 2 minutes.",
  body: `<button id="go">Start (one error/second for 2 min)</button>
<script>
document.getElementById("go").addEventListener("click", function () {
  var start = Date.now();
  var t = setInterval(function () {
    if (Date.now() - start > 120000) { clearInterval(t); return; }
    throw new Error("Bad stuff: error at " + new Date().toISOString());
  }, 1000);
});
</script>`,
});

fe({
  name: "Huge console spam",
  blurb:
    "Click Start to write a flood of console lines. Quire / devtools should stay usable; the page should remain reloadable.",
  bound: "stops after 100,000 lines.",
  body: `<button id="go">Start (100k console lines)</button>
<script>
var n = 0, MAX = 100000;
document.getElementById("go").addEventListener("click", function step() {
  for (var i = 0; i < 1000 && n < MAX; i++, n++) console.log("Bad stuff console spam line " + n);
  if (n < MAX) setTimeout(step, 0);
});
</script>`,
});

fe({
  name: "Infinite embed recursion",
  onOpen: true,
  blurb:
    "Embeds itself with <code>&lt;quire-embed&gt;</code>, which would nest iframes forever. A depth guard removes the embed past 5 levels so you can see where the runtime caps embed nesting on its own.",
  bound: "self-limits to 5 levels of nesting.",
  body: `<script>
(function () {
  var depth = 0, w = window;
  try { while (w !== w.top) { depth++; w = w.parent; if (depth > 20) break; } } catch (e) { depth = 99; }
  if (depth >= 5) {
    var e = document.querySelector("quire-embed"); if (e) e.remove();
    document.body.insertAdjacentHTML("beforeend", "<p>Recursion stopped at depth 5 (self-imposed cap).</p>");
  } else {
    document.body.insertAdjacentHTML("beforeend", "<p>Depth " + depth + " — embedding myself again below.</p>");
    document.body.insertAdjacentHTML("beforeend", '<quire-embed src="Infinite embed recursion"></quire-embed>');
  }
})();
</script>`,
});

fe({
  name: "Infinite reload loop",
  onOpen: true,
  blurb:
    "Calls <code>location.reload()</code> every 200ms. Quire should notice a page reloading in a tight loop and stop babysitting it. A sessionStorage counter caps the reloads.",
  bound: "stops after 30 reloads (clear the tab's sessionStorage to run it again).",
  body: `<p id="status"></p>
<script>
var key = "badstuff_reloads";
var n = 0;
try { n = Number(sessionStorage.getItem(key) || "0"); } catch (e) {}
if (n < 30) {
  try { sessionStorage.setItem(key, String(n + 1)); } catch (e) {}
  document.getElementById("status").textContent = "Reload " + (n + 1) + " of 30…";
  setTimeout(function () { location.reload(); }, 200);
} else {
  document.getElementById("status").textContent = "Stopped after 30 reloads.";
}
</script>`,
});

fe({
  name: "Never-ending fetch to its own backend",
  backend: "api",
  backendRun: { api: "node server.js" },
  files: {
    "backend/server.js": `// Backend for "Never-ending fetch". /api/slow accepts the request and never answers,
// holding the connection until it closes it after 60s. The whole backend exits after 180s.
const http = require("node:http");
http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/slow")) {
      // Hold the connection open, then close it after 60s so nothing leaks forever.
      const t = setTimeout(() => { try { res.writeHead(204); res.end(); } catch (e) {} }, 60000);
      res.on("close", () => clearTimeout(t));
      return;
    }
    res.writeHead(404); res.end();
  })
  .listen(process.env.PORT, "127.0.0.1", () => console.log("bad-stuff slow backend on :" + process.env.PORT));
setTimeout(() => process.exit(0), 180000); // hard self-limit
`,
  },
  blurb:
    "Click Start to fire requests at <code>/api/slow</code>, which the backend accepts and never answers. Quire's <code>/api</code> proxy should not hang the UI, and the backend should be reaped when idle. Opening this page starts its Node backend.",
  bound: "the frontend stops firing after 90s; the backend closes each request after 60s and exits after 180s.",
  body: `<button id="go">Start (hammers /api/slow for 90s)</button>
<p id="status"></p>
<script>
document.getElementById("go").addEventListener("click", function () {
  var stop = Date.now() + 90000, inFlight = 0;
  var status = document.getElementById("status");
  (function loop() {
    if (Date.now() > stop) { status.textContent = "Stopped after 90s."; return; }
    inFlight++;
    status.textContent = inFlight + " requests started…";
    fetch("/api/slow").catch(function () {});
    setTimeout(loop, 500);
  })();
});
</script>`,
});

fe({
  name: "Steals shortcuts",
  blurb:
    "Listens for ⌘P ⌘W ⌘T ⌘N ⌘E ⌘, ⌘[ ⌘] and Esc, calls <code>preventDefault</code> and logs each one below. Click in the page, then press them. With Settings → Keyboard shortcuts on <b>Quire first</b> (the default) Quire's own shortcuts never show up here: ⌘P opens the palette. On <b>Page first</b> this log gets them and Quire only acts on the ones the page ignores (⌘[ ⌘] and Esc aren't Quire shortcuts, so they always land here).",
  bound: "only reads keys; nothing runs on its own.",
  body: `<p><input id="field" placeholder="or type in this field" style="font:inherit;padding:6px 10px;width:260px"></p>
<pre id="log" style="background:#f1f2f4;border-radius:8px;padding:10px 12px;min-height:120px;white-space:pre-wrap">(nothing yet)</pre>
<script>
var log = document.getElementById("log"), n = 0;
var WANT = { p: "⌘P", w: "⌘W", t: "⌘T", n: "⌘N", e: "⌘E", ",": "⌘,", "[": "⌘[", "]": "⌘]" };
window.addEventListener("keydown", function (e) {
  var name = null;
  if (e.key === "Escape") name = "Esc";
  else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) name = WANT[e.key.toLowerCase()] || null;
  if (!name) return;
  e.preventDefault();
  n++;
  log.textContent = (n === 1 ? "" : log.textContent + "\\n") + n + ". Page got " + name;
  window.__shortcutLog = (window.__shortcutLog || []).concat(name);
}, true);
</script>`,
});

// ---------------------------------------------------------------- backend pages

const backend = [];
const be = (p) => backend.push(p);

const backendBody = (extra = "") => `<p>Opening this page starts the backend (Quire runs it when the page is served). Watch the Backend pill, the Activity tab, and <code>quire logs</code>.</p>${extra}`;

be({
  name: "Backend crashes on start",
  backendRun: { main: "node server.js" },
  files: { "backend/server.js": `// Exits 1 immediately, before ever listening.\nprocess.exit(1);\n` },
  blurb:
    "The backend exits with code 1 the instant it starts, before listening. Quire should retry with backoff and then give up after the crash-loop limit (<code>crashLimit</code> within <code>crashWindowMinutes</code>).",
  bound: "each process exits instantly; Quire's own crash-loop give-up stops the retries.",
  body: backendBody(),
});

be({
  name: "Backend crashes after 5 seconds",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Listens, serves for 5s, then exits 1.
const http = require("node:http");
http.createServer((q, s) => s.end("ok")).listen(process.env.PORT, "127.0.0.1", () => console.log("up on :" + process.env.PORT));
setTimeout(() => process.exit(1), 5000);
`,
  },
  blurb:
    "The backend listens, works for 5 seconds, then exits 1. Quire should restart it with backoff; if it keeps dying it hits the crash-loop give-up.",
  bound: "each process lives 5s then exits; Quire's crash-loop give-up stops the retries.",
  body: backendBody(),
});

be({
  name: "Backend crash loop",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Binds, then exits 1 after 300ms — a fast, endless crash loop (until Quire gives up).
const http = require("node:http");
http.createServer((q, s) => s.end()).listen(process.env.PORT, "127.0.0.1");
setTimeout(() => process.exit(1), 300);
`,
  },
  blurb:
    "The backend binds and then exits 1 after 300ms, over and over. This is the case the crash-loop give-up (<code>crashLimit</code>/<code>crashWindowMinutes</code>) exists for.",
  bound: "each process exits after 300ms; Quire's backoff and give-up bound the retries.",
  body: backendBody(),
});

be({
  name: "Backend fork bomb",
  backendRun: { forkbomb: "node fork.js" },
  files: {
    "backend/fork.js": `// Bounded fork bomb. Branching factor 2, max depth 7 => at most 255 processes total
// (2^0 + 2^1 + ... + 2^7 = 255). Every process exits by itself after 60s. Children stay in
// the backend's process group (NOT detached), so Quire's kill-tree reaches them.
const { spawn } = require("node:child_process");
const depth = Number(process.argv[2] || "0");
const MAX_DEPTH = 7;
setTimeout(() => process.exit(0), 60000); // hard self-limit, no matter what
if (depth < MAX_DEPTH) {
  for (let i = 0; i < 2; i++) {
    try { spawn(process.execPath, [__filename, String(depth + 1)], { stdio: "ignore" }); } catch (e) {}
  }
}
console.log("fork depth " + depth + " pid " + process.pid);
`,
  },
  blurb:
    "Recursively spawns child processes. Quire should cap processes per backend (<code>maxProcesses</code>) and kill the whole tree on stop.",
  bound: "stops at 255 processes total; every process exits by itself after 60s.",
  body: backendBody(),
});

be({
  name: "Backend memory hog",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Grows ~50 MB/s to a ~3 GB cap, holds 30s, then exits. Listens so it shows as running.
const http = require("node:http");
http.createServer((q, s) => s.end("hogging")).listen(process.env.PORT, "127.0.0.1");
const held = []; let bytes = 0; const CAP = 3 * 1024 * 1024 * 1024; // ~3 GB
const t = setInterval(() => {
  for (let i = 0; i < 5 && bytes < CAP; i++) { const b = Buffer.alloc(10 * 1024 * 1024, 1); held.push(b); bytes += b.length; } // ~50 MB/tick
  if (bytes >= CAP) { clearInterval(t); setTimeout(() => process.exit(0), 30000); }
}, 1000);
`,
  },
  blurb:
    "The backend allocates memory at ~50 MB/s. Quire should stop it when it crosses the per-backend memory cap (<code>maxMemoryMB</code>).",
  bound: "stops growing at ~3 GB, holds 30s, then exits.",
  body: backendBody(),
});

be({
  name: "Backend CPU spinner",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Burns CPU in 100ms chunks for 90s, then exits. Chunked so Quire can still kill it.
const http = require("node:http");
http.createServer((q, s) => s.end("spinning")).listen(process.env.PORT, "127.0.0.1");
const end = Date.now() + 90000;
(function spin() {
  const t = Date.now() + 100;
  while (Date.now() < t) {}            // burn ~100ms
  if (Date.now() < end) setImmediate(spin); else process.exit(0);
})();
`,
  },
  blurb:
    "The backend pins a CPU core. Quire should stop it when it stays over the CPU limit (<code>cpuPercent</code>) for <code>cpuSeconds</code>.",
  bound: "stops after 90s.",
  body: backendBody(),
});

be({
  name: "Backend ignores SIGTERM",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Traps SIGTERM and ignores it; exits by itself after 60s. Quire should force-kill it
// (SIGKILL) after stopGraceSeconds when you Stop it.
process.on("SIGTERM", () => console.log("got SIGTERM — ignoring it"));
const http = require("node:http");
http.createServer((q, s) => s.end("stubborn")).listen(process.env.PORT, "127.0.0.1", () => console.log("up on :" + process.env.PORT));
setTimeout(() => process.exit(0), 60000); // hard self-limit
`,
  },
  blurb:
    "The backend traps SIGTERM and refuses to stop. Quire should force-kill it with SIGKILL after <code>stopGraceSeconds</code>.",
  bound: "exits by itself after 60s even if never killed.",
  body: backendBody(),
});

be({
  name: "Backend escapes its process group",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Spawns a DETACHED child in its own process group (Quire's kill -(pid) can't reach it),
// to show the limit of process-group tracking. The child sleeps 60s then exits on its own.
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000)"], { detached: true, stdio: "ignore" });
child.unref();
console.log("spawned detached pid " + child.pid + " in its own process group; it exits after 60s");
const http = require("node:http");
http.createServer((q, s) => s.end("escaped")).listen(process.env.PORT, "127.0.0.1");
setTimeout(() => process.exit(0), 60000);
`,
  },
  blurb:
    "The backend launches a detached child in a new process group, which Quire's process-group kill will not reach. Shows where process tracking ends. (No <code>setsid</code>; the escaped child still exits itself.)",
  bound: "the escaped child sleeps 60s then exits; the parent exits after 60s.",
  body: backendBody(),
});

be({
  name: "Backend floods its log",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Writes to stdout as fast as it can, bounded to 50 MB, then goes quiet and exits.
const http = require("node:http");
http.createServer((q, s) => s.end("flooding")).listen(process.env.PORT, "127.0.0.1");
let bytes = 0; const CAP = 50 * 1024 * 1024; const line = "Bad stuff log flood ".repeat(4) + "\\n";
const t = setInterval(() => {
  for (let i = 0; i < 2000 && bytes < CAP; i++) { process.stdout.write(line); bytes += line.length; }
  if (bytes >= CAP) clearInterval(t);
}, 50);
setTimeout(() => process.exit(0), 120000);
`,
  },
  blurb:
    "The backend spews log output. Quire keeps only the last 256 KB per process, so this should stay bounded on disk.",
  bound: "stops after writing 50 MB; exits after 120s.",
  body: backendBody(),
});

be({
  name: "Backend never listens",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Starts and stays alive but never binds $PORT, so the /api proxy times out (503 after 15s).
console.log("started, but will never listen on $PORT=" + process.env.PORT);
const keepalive = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keepalive); process.exit(0); }, 90000);
`,
  },
  blurb:
    "The backend runs but never binds its port. Quire's <code>/api</code> proxy should wait up to 15s and then answer 503 naming the process and port, without hanging.",
  bound: "exits after 90s.",
  body: backendBody(),
});

be({
  name: "Backend holds a port someone else uses",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Binds a FIXED port (not $PORT) in Quire's backend range, so it can collide with another
// backend, and tries to bind it twice to show the EADDRINUSE. Does not listen on $PORT.
const http = require("node:http");
const PORT = 47234; // fixed, inside Quire's 47000-48999 backend range
http.createServer((q, s) => s.end()).listen(PORT, "127.0.0.1", () => console.log("bound fixed port " + PORT));
const two = http.createServer((q, s) => s.end());
two.on("error", (e) => console.log("second bind failed: " + e.code));
two.listen(PORT, "127.0.0.1");
setTimeout(() => process.exit(0), 60000); // frees the port
`,
  },
  blurb:
    "The backend grabs a hard-coded port in Quire's range (and tries to bind it twice). Shows what happens when a backend fights over a port it does not own.",
  bound: "exits after 60s and frees the port.",
  body: backendBody(),
});

be({
  name: "Backend slow to start",
  backendRun: { main: "node server.js" },
  files: {
    "backend/server.js": `// Does not listen for 20s. The /api proxy waits up to 15s, so the first request 503s, then
// later requests work once it comes up. Exits after 120s.
const http = require("node:http");
setTimeout(() => {
  http.createServer((q, s) => s.end("ready")).listen(process.env.PORT, "127.0.0.1", () => console.log("listening after 20s on :" + process.env.PORT));
}, 20000);
setTimeout(() => process.exit(0), 120000);
`,
  },
  blurb:
    "The backend takes 20s to start listening — longer than the proxy's 15s wait. The first <code>/api</code> request should 503; later ones should work.",
  bound: "listens after 20s; exits after 120s.",
  body: backendBody(),
});

// ---------------------------------------------------------------- write it out

/** Write one page folder: .noteblock + index.html + any extra files. */
function writePage(p, extraManifest = {}) {
  const dir = join(root, p.name);
  mkdirSync(dir, { recursive: true });
  const manifest = { id: pageId(p.name), entry: "index.html", renderer: "view", ...extraManifest };
  if (p.backendRun) {
    manifest.backend = { run: p.backendRun };
    const first = Object.keys(p.backendRun)[0];
    manifest.backend.proxy = p.backend || first; // route /api and show a clear state
  }
  writeFileSync(join(dir, ".noteblock"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(
    join(dir, "index.html"),
    html({ title: p.name, onOpen: p.onOpen, bound: p.bound, blurb: p.blurb, body: p.body })
  );
  for (const [rel, content] of Object.entries(p.files || {})) {
    const fp = join(dir, rel);
    mkdirSync(join(fp, ".."), { recursive: true });
    writeFileSync(fp, content);
  }
}

/** The index / README page listing everything in groups. */
function writeIndex() {
  const groupLinks = (list) =>
    list
      .map(
        (p) =>
          `<li><a href="#" data-nav="Bad stuff/${p.name}">${p.name}</a> — ${p.blurb.replace(/<[^>]+>/g, "")} <em>(${p.bound})</em></li>`
      )
      .join("\n");
  const body = `<p>Deliberately misbehaving pages for testing how Quire copes. Every page is bounded and ends by itself — see each page's safety line. A few misbehave the instant you open them (marked on the page); the rest wait for a Start button. Opening a backend page starts its Node backend.</p>
<h2>Frontend (the page's own web content)</h2>
<p>Quire should keep the app responsive, recover a frozen or crashed page, and surface errors in the page error badge.</p>
<ul>
${groupLinks(frontend)}
</ul>
<h2>Backend (the Node processes a page starts)</h2>
<p>Quire should cap processes / memory / CPU per backend, reap idle backends, and give up on a crash loop.</p>
<ul>
${groupLinks(backend)}
</ul>
<h2>On purpose not here</h2>
<p><strong>alert() / confirm() loop</strong> — skipped. Native modal dialogs from a page block the whole Quire renderer (and can't be dismissed programmatically), so a loop of them would wedge the app rather than make a clean, bounded test. See <code>docs/bad-stuff.md</code>.</p>
<script>
// Make the list links navigate within Quire when available.
document.querySelectorAll("a[data-nav]").forEach(function (a) {
  a.addEventListener("click", function (e) {
    e.preventDefault();
    try { window.quire && window.quire.navigate("/" + a.getAttribute("data-nav")); } catch (err) {}
  });
});
</script>`;
  const dir = join(root, "Bad stuff index");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".noteblock"),
    JSON.stringify({ id: pageId("Bad stuff index"), entry: "index.html", renderer: "view", title: "Bad stuff — index" }, null, 2) + "\n"
  );
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Bad stuff — index</title>
<style>
  body { max-width: 760px; margin: 40px auto; padding: 0 24px; font: 15px/1.55 system-ui, sans-serif; color: #15171c; }
  h1 { font-size: 24px; } h2 { font-size: 18px; margin-top: 28px; }
  li { margin: 0 0 10px; } em { color: #2a7; } code { background: #f1f2f4; padding: 1px 5px; border-radius: 5px; }
  a { color: #15171c; }
</style>
</head>
<body>
<h1>Bad stuff</h1>
${body}
</body>
</html>
`
  );
}

// Rewrite from scratch (idempotent).
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
for (const p of frontend) writePage(p);
for (const p of backend) writePage(p);
writeIndex();

console.log(`Wrote ${frontend.length + backend.length + 1} pages to ${root}`);
