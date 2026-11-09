// The Electron half of scripts/verify-origins.mjs: runs inside the app's main process
// (QUIRE_TEST_SCRIPT, capture mode, hidden windows only) and prints one `[verify] {…}` line
// per check. QUIRE_VERIFY_MODE=seed writes a key into the OLD shared quire://vault
// localStorage (the way an older Quire left it) and exits; QUIRE_VERIFY_MODE=test runs the rest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_INDEX = path.resolve(HERE, "..", "app", "renderer", "dist", "index.html");
const OUT = process.env.QUIRE_VERIFY_OUT || "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = (name, ok, detail = "") => console.log("[verify] " + JSON.stringify({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }));

async function until(fn, ms = 10000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await sleep(step);
  }
  return last || null;
}

/** Run js in a frame, giving up after ms (a frozen frame never answers). */
function ej(frame, js, ms = 3000) {
  return Promise.race([
    frame.executeJavaScript(js).catch((e) => ({ __error: String(e && e.message) })),
    sleep(ms).then(() => ({ __timeout: true })),
  ]);
}

function framesOf(wc) {
  try {
    return wc.mainFrame.framesInSubtree.filter((f) => {
      try {
        return /^quire:/.test(f.url) && !f.detached;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** The frame (in wc) showing page `p`: its URL path is /<page path>/… */
function frameFor(wc, p) {
  const want = "/" + p + "/";
  return (
    framesOf(wc).find((f) => {
      try {
        const u = new URL(f.url);
        return decodeURIComponent(u.pathname).startsWith(want);
      } catch {
        return false;
      }
    }) || null
  );
}

async function shot(wc, name) {
  const img = await wc.capturePage();
  const file = path.join(OUT, `orig-${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  return file;
}

export default async function verify({ win, floating, getVault, BrowserWindow }) {
  const mode = process.env.QUIRE_VERIFY_MODE || "test";
  const vault = getVault();
  const wc = win.webContents;

  if (mode === "seed") {
    // The old layout: a quire://vault frame in a file:// window (localStorage is partitioned by
    // the top-level site, so this is where the old pages' keys live).
    const html = path.join(OUT, "seed-legacy.html");
    fs.writeFileSync(html, `<!doctype html><iframe src="quire://vault/__quire/legacy-storage"></iframe>`);
    const w = new BrowserWindow({ show: false });
    await w.loadFile(html);
    const f = await until(() => w.webContents.mainFrame.frames.find((x) => x.url.startsWith("quire://vault/")));
    const out = await ej(f, `localStorage.setItem("legacyKey", "old value"); localStorage.setItem("quire:Habits:t:x", "[1]"); localStorage.length`);
    w.destroy();
    report("seed legacy localStorage", out === 2 || (typeof out === "number" && out >= 2), out);
    return;
  }

  const ids = {};
  const { listTree, walkTree, readManifest, pathDir } = await import("../core/index.mjs");
  for (const n of walkTree(listTree(vault))) if (n.kind === "page") ids[n.path] = n.id;

  async function open(p) {
    await win.loadFile(RENDERER_INDEX, { query: { page: p } });
    const f = await until(() => {
      const fr = frameFor(wc, p);
      return fr && fr.url.startsWith(`quire://p-${ids[p]}/`) ? fr : null;
    });
    if (!f) return null;
    await until(async () => (await ej(f, "!!(window.quire && document.readyState === 'complete')")) === true, 8000);
    await sleep(800);
    return frameFor(wc, p);
  }

  // 1. Origins and processes: a page and its embeds of two other pages.
  const ov = await open("Kyoto trip/Overview");
  await sleep(1500);
  const bud = frameFor(wc, "Kyoto trip/Trip budget");
  const pack = frameFor(wc, "Kyoto trip/Packing list");
  report("page origin is quire://p-<id>", ov && ov.origin === `quire://p-${ids["Kyoto trip/Overview"]}`, ov && ov.url);
  report("embed origin is its own page's", bud && bud.origin === `quire://p-${ids["Kyoto trip/Trip budget"]}`, bud && bud.url);
  const pids = { app: wc.getOSProcessId(), overview: ov && ov.osProcessId, budget: bud && bud.osProcessId, packing: pack && pack.osProcessId };
  report("two different pages → different processes", pids.budget && pids.packing && pids.budget !== pids.packing, pids);
  report("page and its embed of another page → different processes", pids.overview && pids.budget && pids.overview !== pids.budget && pids.overview !== pids.app, pids);

  // Embeds still size themselves.
  const h = await ej(ov, `Array.from(document.querySelectorAll("iframe.q-embed-frame")).map(f => f.getBoundingClientRect().height)`);
  report("embeds auto-size (height messages across origins)", Array.isArray(h) && h.length === 2 && h.every((x) => x > 60), h);
  await shot(wc, "overview-embeds");

  // 2. Isolation.
  await ej(ov, `localStorage.setItem("secretA", "from overview"); 1`);
  const lsB = await ej(bud, `localStorage.getItem("secretA")`);
  report("page B can't read page A's localStorage", lsB === null, lsB);
  const domB = await ej(ov, `(function(){try{return String(document.querySelector("iframe.q-embed-frame").contentDocument)}catch(e){return "threw "+e.name}})()`);
  report("page A can't reach into its embed's DOM", domB === "null" || /threw/.test(domB), domB);
  const relFetch = await ej(ov, `fetch("../Trip%20budget/index.html").then(r => "status " + r.status, e => "failed: " + e.message)`, 5000);
  const absFetch = await ej(ov, `fetch(${JSON.stringify(`quire://p-${ids["Kyoto trip/Trip budget"]}/Kyoto%20trip/Trip%20budget/`)}).then(r => "status " + r.status, e => "failed: " + e.message)`, 5000);
  const vaultFetch = await ej(ov, `fetch("quire://vault/Kyoto%20trip/Trip%20budget/").then(r => "status " + r.status, e => "failed: " + e.message)`, 5000);
  report("page A can't fetch page B's files", /404|failed/.test(relFetch) && /failed/.test(absFetch) && /failed/.test(vaultFetch), { relFetch, absFetch, vaultFetch });
  const own = await ej(ov, `fetch("index.html").then(r => r.status)`);
  report("page fetches its own files", own === 200, own);
  const fr = await ej(ov, `quire.files.read("Kyoto trip/Trip budget", "index.html").then(t => t.length, e => "error: " + e.message)`);
  const frBad = await ej(ov, `quire.files.read("Kyoto trip/Trip budget", ".noteblock").then(t => "read!", e => e.message)`);
  report("quire.files.read reads another page, refuses .noteblock", typeof fr === "number" && fr > 100 && /not allowed/.test(frBad), { fr, frBad });
  // A forged params.from: Overview posts an rpc claiming to be Trip budget.
  const forged = await ej(
    ov,
    `new Promise(function(res){var id="forge"+Date.now();addEventListener("message",function m(e){if(e.data&&e.data.id===id){removeEventListener("message",m);res(e.data.error||"ok")}});window.top.postMessage({quire:1,type:"rpc",id:id,method:"kv.set",params:{key:"forged",value:"x",from:"Kyoto trip/Trip budget",page:"Kyoto trip/Trip budget"}},"*");})`,
  );
  const inB = await ej(bud, `quire.kv.get("forged")`);
  const inA = await ej(ov, `quire.kv.get("forged")`);
  report("a forged params.from can't write page B's store", forged === "ok" && inB == null && inA === "x", { forged, inB, inA });

  // 3. Editor save on the top page.
  const saved = await ej(
    ov,
    `(function(){var p=document.querySelector("[data-q-region] p");if(!p)return "no region";p.textContent="Saved through the editor ${Date.now()}.";p.dispatchEvent(new InputEvent("input",{bubbles:true}));return p.textContent;})()`,
  );
  const file = path.join(pathDir(vault, "Kyoto trip/Overview"), "index.html");
  const landed = await until(() => typeof saved === "string" && fs.readFileSync(file, "utf8").includes(saved), 6000);
  report("editor save writes the page file", !!landed, saved);

  // 4. A frozen embed: the card in the embed's box only; the page keeps working; Reload recovers.
  const holder = await open("Holder");
  const spinFrame0 = await until(() => frameFor(wc, "Spinner"), 6000);
  const spinPid = spinFrame0 && spinFrame0.osProcessId;
  report("embed of a spinner page runs in its own process", holder && spinPid && spinPid !== holder.osProcessId, { holder: holder && holder.osProcessId, spinner: spinPid });
  const stuck = await until(async () => (await ej(holder, `!!document.querySelector(".q-embed-stuck")`)) === true, 15000, 300);
  const appCard = await ej(wc.mainFrame, `!!document.querySelector(".recovery-backdrop")`);
  const t0 = Date.now();
  const scroll = await ej(holder, `window.scrollTo(0, 400); window.scrollY`, 2000);
  const answeredIn = Date.now() - t0;
  const editOk = await ej(
    holder,
    `(function(){var p=document.querySelector("[data-q-region] p");if(!p)return "no region";p.textContent="Still editable while the embed spins.";p.dispatchEvent(new InputEvent("input",{bubbles:true}));return "typed";})()`,
  );
  const holderFile = path.join(pathDir(vault, "Holder"), "index.html");
  const holderSaved = await until(() => fs.readFileSync(holderFile, "utf8").includes("Still editable while the embed spins."), 6000);
  await ej(holder, `window.scrollTo(0, 0); 1`);
  await sleep(300);
  await shot(wc, "embed-frozen");
  report("frozen embed: card in the embed only", stuck === true && appCard === false, { stuck, appCard });
  report("frozen embed: parent page still scrolls and saves", typeof scroll === "number" && scroll > 0 && answeredIn < 1500 && editOk === "typed" && !!holderSaved, { scroll, answeredIn, editOk, holderSaved: !!holderSaved });
  await ej(holder, `document.querySelector(".q-embed-stuck button").click(); 1`);
  const recovered = await until(async () => {
    const f = frameFor(wc, "Spinner");
    if (!f || f.osProcessId === spinPid) return null;
    const ok = await ej(f, "document.readyState", 1500);
    const card = await ej(holder, `!!document.querySelector(".q-embed-stuck")`);
    return ok === "complete" && card === false ? { pid: f.osProcessId } : null;
  }, 15000, 300);
  report("frozen embed: Reload recovers it in a new process", !!recovered, { before: spinPid, after: recovered && recovered.pid });
  await shot(wc, "embed-recovered");

  // 5. Habits (React + store), a markdown page that embeds it, Guestbook (backend /api).
  const habits = await open("Habits");
  const hab = await until(async () => {
    const n = await ej(habits, `document.querySelectorAll("#root *").length`);
    return typeof n === "number" && n > 10 ? n : null;
  }, 10000);
  const habStore = await ej(habits, `quire.store.table("verify").insert({v: 1}).then(() => quire.store.table("verify").all()).then(r => r.length)`);
  report("Habits renders (React) and its store works", !!hab && habStore >= 1, { nodes: hab, rows: habStore });
  await shot(wc, "habits");
  const md = await open("Journal/Oct 16");
  const mdOk = await until(async () => (await ej(md, `document.body.dataset.qFormat + "|" + document.querySelectorAll("iframe.q-embed-frame").length`)) === "md|1", 8000);
  const mdEmbed = await until(() => frameFor(wc, "Habits"), 6000);
  report("markdown page renders, embeds Habits on its own origin", !!mdOk && mdEmbed && mdEmbed.origin === `quire://p-${ids["Habits"]}` && mdEmbed.osProcessId !== md.osProcessId, { mdOk, embedOrigin: mdEmbed && mdEmbed.origin });
  await shot(wc, "markdown");
  const gb = await open("Apps/Guestbook");
  const gbOk = await until(async () => {
    const r = await ej(gb, `fetch("api/entries").then(r => r.ok ? r.json() : r.status).then(j => typeof j === "object" ? "ok" : j, e => "failed " + e.message)`, 5000);
    return r === "ok" ? r : null;
  }, 20000, 500);
  const gbAbs = await ej(gb, `fetch("/api/entries").then(r => r.status, e => "failed")`, 5000);
  await sleep(1000);
  report("Guestbook backend /api (relative and absolute)", gbOk === "ok" && gbAbs === 200, { gbOk, gbAbs });
  await shot(wc, "guestbook");

  // 6. A built page (dist/ entry with <base>).
  const built = await open("Apps/Reading list");
  const builtOk = await until(async () => {
    const r = await ej(built, `(document.querySelector("base")||{}).href + "|" + document.body.innerText.length`);
    return typeof r === "string" && r.startsWith(`quire://p-${ids["Apps/Reading list"]}/Apps/Reading%20list/dist/`) && Number(r.split("|")[1]) > 20 ? r : null;
  }, 10000);
  report("built page renders with <base> on its origin", !!builtOk, builtOk);
  await shot(wc, "built");

  // Source view: the live preview is the page on its own origin.
  await open("Kyoto trip/Trip budget");
  wc.send("menu", "toggle-source");
  const prev = await until(async () => {
    const f = frameFor(wc, "Kyoto trip/Trip budget");
    const isSource = await ej(wc.mainFrame, `!!document.querySelector(".source-preview iframe")`);
    return f && isSource === true && f.origin === `quire://p-${ids["Kyoto trip/Trip budget"]}` && (await ej(f, "document.readyState")) === "complete" ? f.origin : null;
  }, 8000);
  await sleep(500);
  await shot(wc, "source-view");
  report("Source view preview on the page's origin", !!prev, prev);
  wc.send("menu", "toggle-source");
  await sleep(500);

  // 7. New from template.
  const tpls = await ej(wc.mainFrame, `quireApp.listTemplates().then(s => s.templates.map(x => x.path))`);
  const tpl = Array.isArray(tpls) ? tpls[0] : null;
  const made = tpl ? await ej(wc.mainFrame, `quireApp.createFromTemplate(${JSON.stringify(tpl)}, "", "From template").then(n => n.path, e => "error " + e.message)`, 8000) : null;
  if (typeof made === "string" && !made.startsWith("error")) {
    const m = readManifest(pathDir(vault, made)) || {};
    ids[made] = m.id;
    const tf = await open(made);
    report("New from template opens on its own origin", tf && tf.origin === `quire://p-${m.id}`, { template: tpl, made, origin: tf && tf.origin });
    await shot(wc, "template");
  } else report("New from template opens on its own origin", false, { tpls, made });

  // 8. Activity lists page processes.
  await open("Kyoto trip/Overview");
  await sleep(1000);
  const act = await ej(wc.mainFrame, `quireApp.activity().then(a => a.pages)`, 8000);
  report("Activity counts page processes with titles", act && act.processes >= 3 && act.top.some((t) => t.pages.some((p) => p.title)), act);

  // 9. Migration: the old shared localStorage arrived once.
  const lsNow = await ej(ov ? frameFor(wc, "Kyoto trip/Overview") : null, `[localStorage.getItem("legacyKey"), localStorage.getItem("quire:origin-migrated") != null]`);
  const hb = await open("Habits");
  const lsHabits = await ej(hb, `[localStorage.getItem("legacyKey"), localStorage.getItem("quire:Habits:t:x")]`);
  await ej(hb, `localStorage.setItem("legacyKey", "changed by the page"); 1`);
  // Another page can't call Guestbook's backend either.
  const crossApi = await ej(hb, `fetch(${JSON.stringify(`quire://p-${ids["Apps/Guestbook"]}/Apps/Guestbook/api/entries`)}).then(r => "status " + r.status, e => "failed")`, 5000);
  report("page A can't call page B's backend /api", crossApi === "failed", crossApi);
  const hb2 = await open("Habits");
  const lsAfter = await ej(hb2, `localStorage.getItem("legacyKey")`);
  const state = JSON.parse(fs.readFileSync(path.join(process.env.QUIRE_USER_DATA, "page-origins.json"), "utf8"));
  report("old localStorage copied into each page's origin", Array.isArray(lsNow) && lsNow[0] === "old value" && lsNow[1] === true && Array.isArray(lsHabits) && lsHabits[0] === "old value" && lsHabits[1] === "[1]", { lsNow, lsHabits });
  report("…only once (a later change isn't overwritten)", lsAfter === "changed by the page" && state.migrated.includes(ids["Habits"]), { lsAfter, state });

  // 10. Floating note: own origin, rpc works, and the heartbeat card when its page freezes.
  floating.setConfig({ page: "Freezer" });
  await floating.capture(path.join(OUT, "orig-floating-start.png"), { delay: 1500 });
  const fwc = floating.webContents();
  const ff = await until(() => frameFor(fwc, "Freezer"), 6000);
  report("floating note page on its own origin, separate from the main window's page", ff && ff.origin === `quire://p-${ids["Freezer"]}` && framesOf(wc).every((f) => f.osProcessId !== ff.osProcessId), ff && { origin: ff.origin, pid: ff.osProcessId });
  const fcard = await until(async () => (await ej(fwc.mainFrame, `!!document.querySelector(".recovery-backdrop")`)) === true, 15000, 300);
  const mainFrame = framesOf(wc).find((f) => f.parent === wc.mainFrame);
  const mainStill = mainFrame ? await ej(mainFrame, `document.readyState`, 1500) : "no main page frame";
  await shot(fwc, "floating-frozen");
  report("floating note: frozen page shows the card in the note", fcard === true && mainStill === "complete", { fcard, mainStill });
  await ej(fwc.mainFrame, `(Array.from(document.querySelectorAll(".recovery-card button")).find(b => /Reload/.test(b.textContent))||{click(){}}).click(); 1`);
  const fback = await until(async () => {
    const f = frameFor(fwc, "Freezer");
    if (!f) return null;
    const ok = await ej(f, `quire.kv.set("note", "back").then(() => quire.kv.get("note"))`, 1500);
    const card = await ej(fwc.mainFrame, `!!document.querySelector(".recovery-backdrop")`);
    return ok === "back" && card === false ? ok : null;
  }, 15000, 400);
  await shot(fwc, "floating-recovered");
  report("floating note: Reload recovers it, rpc works", fback === "back", fback);
}
