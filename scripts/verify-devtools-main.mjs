// The Electron half of scripts/verify-devtools.mjs: runs in the app's main process (capture
// mode, hidden windows) and prints one `[verify] {…}` line per check.
//
// For each inspector it first lets the real DevTools frontend connect (screenshots), then
// takes the frontend off the relay and connects a test client to the same ws:// URL to prove
// what the inspector can see: only its page's document, console, network.
import fs from "node:fs";
import http from "node:http";
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

const ej = (frame, js, ms = 3000) => Promise.race([frame.executeJavaScript(js).catch((e) => ({ __error: String(e && e.message) })), sleep(ms).then(() => ({ __timeout: true }))]);

function frameFor(wc, p) {
  const want = "/" + p + "/";
  try {
    return (
      wc.mainFrame.framesInSubtree.find((f) => {
        try {
          return /^quire:\/\/p-/.test(f.url) && decodeURIComponent(new URL(f.url).pathname).startsWith(want);
        } catch {
          return false;
        }
      }) || null
    );
  } catch {
    return null;
  }
}

/** A CDP client over the inspector's relay, the way the frontend talks to it. */
function client(wsParam) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://" + wsParam);
    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result);
      } else if (m.method) events.push(m);
    };
    ws.onerror = () => reject(new Error("ws error"));
    ws.onopen = () =>
      resolve({
        events,
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

/** Raw upgrade with a given Origin: the status line the relay answers. */
function rawUpgrade(wsParam, origin) {
  const [hostport, token] = wsParam.split("/");
  const [, port] = hostport.split(":");
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/" + token, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...(origin ? { Origin: origin } : {}) } }); // gitleaks:allow (RFC 6455 sample key)
    req.on("upgrade", (res, sock) => {
      sock.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("error", (e) => resolve("error " + e.message));
    req.end();
  });
}

async function shot(ins, name) {
  const file = path.join(OUT, `devtools-${name}.png`);
  const img = await ins.win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
  return file;
}

/** Wait for the frontend to connect and draw, then screenshot Elements and Console. */
async function frontendShots(ins, name, consoleLine) {
  const connected = await until(() => ins.relay.connected && ins.session, 15000);
  await sleep(3000);
  const fwc = ins.win.webContents;
  const elementsText = await ej(fwc.mainFrame, `document.body.innerText.length`, 3000);
  await shot(ins, name + "-elements");
  await ej(fwc.mainFrame, `(async()=>{const UI=await import('./ui/legacy/legacy.js');await UI.ViewManager.ViewManager.instance().showView('console');return 1})()`, 5000);
  if (consoleLine) await consoleLine();
  await sleep(1500);
  await shot(ins, name + "-console");
  return { connected: !!connected, drew: typeof elementsText === "number" && elementsText > 0 };
}

/** Take the frontend off the relay so a test client can connect. */
async function freeRelay(ins) {
  await ins.win.loadURL("about:blank");
  await until(() => !ins.relay.connected, 5000);
}

export default async function verify({ win, devtools }) {
  const wc = win.webContents;
  async function open(p) {
    await win.loadFile(RENDERER_INDEX, { query: { page: p } });
    const f = await until(() => frameFor(wc, p), 10000);
    if (!f) return null;
    await until(async () => (await ej(frameFor(wc, p), "!!(window.quire && document.readyState === 'complete')")) === true, 8000);
    await sleep(1000);
    return frameFor(wc, p);
  }

  // 1. Habits: the frontend connects and draws; then a test client checks the scoping.
  const habits = await open("Habits");
  report("Habits is open", !!habits);
  const ins = await devtools.inspect(wc, { path: "Habits" });
  report("inspector window titled after the page", ins.win.getTitle() === "Habits — DevTools", ins.win.getTitle());
  const fe = await frontendShots(ins, "habits", () => ej(frameFor(wc, "Habits"), `console.log("hello from Habits in the inspector"); 1`));
  report("DevTools frontend connects to the page and draws", fe.connected && fe.drew, fe);
  const again = await devtools.inspect(wc, { path: "Habits" });
  report("Inspect again re-focuses the same window", again === ins && devtools.list().length === 1, devtools.list().length);

  // Coexistence: the window-wide Electron DevTools opened and closed while the inspector is open.
  wc.openDevTools({ mode: "right" });
  await until(() => wc.isDevToolsOpened(), 5000);
  const coexist = { opened: wc.isDevToolsOpened(), debuggerAttached: wc.debugger.isAttached(), relay: ins.relay.connected };
  wc.closeDevTools();
  await sleep(500);
  coexist.afterClose = wc.debugger.isAttached() && ins.relay.connected;
  report("Electron DevTools and the page inspector coexist", coexist.opened && coexist.debuggerAttached && coexist.relay && coexist.afterClose, coexist);

  const wsParam = ins.relay.wsParam;
  // The relay: only its token path, only devtools:// (or no) Origin, one connection at a time.
  const second = await rawUpgrade(wsParam, "devtools://devtools");
  const pageOrigin = await rawUpgrade(wsParam, "quire://p-aaaaaaaaaa");
  const badToken = await rawUpgrade(wsParam.replace(/\/.*/, "/nope"), "");
  report("relay: one connection, refuses page origins and wrong tokens", second === 409 && pageOrigin === 403 && badToken === 404, { second, pageOrigin, badToken, listen: wsParam.split("/")[0] });

  await freeRelay(ins);
  const c = await client(wsParam);
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  const title = await c.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
  report("Runtime.evaluate runs in the page: document.title = Habits", title.result.value === "Habits", title.result.value);
  const doc = await c.send("DOM.getDocument", { depth: 1 });
  report("DOM.getDocument is the page's own document", /\/Habits\/$/.test(doc.root.documentURL) && /^quire:\/\/p-/.test(doc.root.documentURL), doc.root.documentURL);
  const contexts = c.events.filter((e) => e.method === "Runtime.executionContextCreated").map((e) => e.params.context.origin);
  report("execution contexts are the page's only", contexts.length > 0 && contexts.every((o) => /^quire:\/\/p-/.test(o) && o === contexts[0]), contexts);
  c.events.length = 0;
  await ej(frameFor(wc, "Habits"), `console.log("mark-habits"); fetch("index.html?probe=habits"); fetch("/api/probe-habits").catch(()=>{}); 1`);
  await ej(wc.mainFrame, `console.log("mark-app-window"); 1`);
  await sleep(1200);
  const logs = c.events.filter((e) => e.method === "Runtime.consoleAPICalled").map((e) => e.params.args.map((a) => a.value).join(" "));
  report("console: the page's log arrives, the app window's doesn't", logs.includes("mark-habits") && !logs.includes("mark-app-window"), logs);
  const reqs = c.events.filter((e) => e.method === "Network.requestWillBeSent").map((e) => e.params.request.url);
  report("network: the page's requests, /api included", reqs.some((u) => u.includes("probe=habits")) && reqs.some((u) => u.includes("/api/probe-habits")) && reqs.every((u) => /^quire:\/\/p-/.test(u)), reqs);
  const refused = await c.send("Target.attachToTarget", { targetId: "x", flatten: true }).then(
    () => "allowed",
    (e) => e.message,
  );
  const listed = await c.send("Target.getTargets");
  report("Target discovery stays inside the page", /Not allowed/.test(refused) && listed.targetInfos.length === 0, { refused, listed: listed.targetInfos.length });
  c.close();
  await until(() => !ins.relay.connected, 3000);

  // 2. Reload the page (a new iframe, a new target): the inspector reconnects on its own.
  await ins.loadFrontend();
  await until(() => ins.session, 10000);
  await sleep(2000);
  const oldTarget = ins.targetId;
  win.webContents.send("page-files-changed", "Habits");
  const back = await until(() => ins.session && ins.targetId && ins.targetId !== oldTarget && ins.relay.connected, 15000);
  let backTitle = null;
  if (back) {
    await sleep(1500);
    backTitle = await ins.hub.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, ins.session).then((r) => r.result.value, (e) => e.message);
  }
  report("page reload → inspector reconnects to the new iframe", !!back && backTitle === "Habits", { oldTarget, newTarget: ins.targetId, backTitle });
  await shot(ins, "habits-after-reload");

  // 3. Overview embeds Trip budget: an inspector for the embed sees only Trip budget.
  const ov = await open("Kyoto trip/Overview");
  await until(() => frameFor(wc, "Kyoto trip/Trip budget"), 8000);
  await sleep(1000);
  const habitsWaiting = await until(() => ins.waiting || ins.closed, 5000);
  report("Habits' inspector waits (or closes) when no tab shows Habits", !!habitsWaiting, { waiting: ins.waiting, closed: ins.closed });
  const emb = await devtools.inspect(wc, { path: "Kyoto trip/Trip budget", embedOf: "Kyoto trip/Overview" });
  const efe = await frontendShots(emb, "embed", () => ej(frameFor(wc, "Kyoto trip/Trip budget"), `console.log("hello from the Trip budget embed"); 1`));
  report("embed inspector: frontend connects", efe.connected && efe.drew, efe);
  await freeRelay(emb);
  const e = await client(emb.relay.wsParam);
  await e.send("Runtime.enable");
  await e.send("Network.enable");
  const et = await e.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
  const ed = await e.send("DOM.getDocument", { depth: 1 });
  report("embed inspector: document is Trip budget", et.result.value === "Trip budget" && /\/Trip%20budget\/|\/Trip budget\//.test(ed.root.documentURL), { title: et.result.value, url: ed.root.documentURL });
  e.events.length = 0;
  await ej(frameFor(wc, "Kyoto trip/Trip budget"), `console.log("mark-budget"); fetch("index.html?probe=budget"); 1`);
  await ej(ov, `console.log("mark-overview"); fetch("index.html?probe=overview"); 1`);
  await sleep(1200);
  const elogs = e.events.filter((x) => x.method === "Runtime.consoleAPICalled").map((x) => x.params.args.map((a) => a.value).join(" "));
  const ereqs = e.events.filter((x) => x.method === "Network.requestWillBeSent").map((x) => x.params.request.url);
  report("embed inspector: console and network are the embed's only", elogs.includes("mark-budget") && !elogs.includes("mark-overview") && ereqs.some((u) => u.includes("probe=budget")) && !ereqs.some((u) => u.includes("probe=overview")), { elogs, ereqs });
  e.close();

  // 4. The Overview page's own inspector doesn't show the embed's document.
  const ovi = await devtools.inspect(wc, { path: "Kyoto trip/Overview" });
  await until(() => ovi.relay.connected && ovi.session, 10000);
  await sleep(2000);
  await shot(ovi, "overview-elements");
  const kids = [...ovi.kids];
  const tree = await ovi.hub.send("DOM.getDocument", { depth: -1, pierce: true }, ovi.session);
  const docs = [];
  (function walk(n) {
    if (n.documentURL) docs.push(n.documentURL);
    for (const k of n.children || []) walk(k);
    if (n.contentDocument) walk(n.contentDocument);
  })(tree.root);
  report("page inspector: no embed documents or sessions", docs.length === 1 && /Overview/.test(docs[0]) && kids.length === 0, { docs, kids: kids.length });

  // ⌘⌥J with focus in the embed picks the embed; with focus on the page, the page.
  await ej(ov, `document.querySelector("iframe.q-embed-frame").focus(); 1`);
  const viaKey = await devtools.inspectFocused(wc);
  await ej(ov, `document.activeElement && document.activeElement.blur(); document.body.focus(); 1`);
  const viaKeyPage = await devtools.inspectFocused(wc);
  report("Inspect page (⌘⌥J) picks the focused embed, else the page", viaKey === emb && viaKeyPage === ovi, { embed: viaKey && viaKey.path, page: viaKeyPage && viaKeyPage.path });

  // The embed menu's Inspect: an rpc from the holder page (its origin says which page asks).
  emb.close();
  const viaRpc = await ej(
    ov,
    `new Promise(function(res){var id="insp"+Date.now();addEventListener("message",function m(e){if(e.data&&e.data.id===id){removeEventListener("message",m);res(e.data.error||"ok")}});window.top.postMessage({quire:1,type:"rpc",id:id,method:"devtools.inspectEmbed",params:{page:"Kyoto trip/Trip budget"}},"*");})`,
    8000,
  );
  const rpcIns = devtools.list().find((i) => i.path === "Kyoto trip/Trip budget");
  report("embed menu Inspect (rpc from the holder) opens the embed's inspector", viaRpc === "ok" && rpcIns && rpcIns.embedOf, { viaRpc, embedOf: rpcIns && rpcIns.embedOf });

  // 5. Closing: a tab list without the page closes its inspectors; the debugger detaches with the last.
  devtools.openPages(wc, ["Habits"]);
  await sleep(300);
  const left = devtools.list().map((i) => i.path);
  report("closing Overview's tab closes its inspectors", !left.includes("Kyoto trip/Overview") && !left.includes("Kyoto trip/Trip budget"), left);
  devtools.closeAll();
  await sleep(300);
  report("debugger detaches with the last inspector", !wc.debugger.isAttached() && devtools.list().length === 0, { attached: wc.debugger.isAttached() });
}
