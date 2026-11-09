// Smoke test for per-page origins (app/main/origins.mjs, protocol.mjs, ipc.mjs runRpc), without
// Electron: quire://p-<id>/<path>/ URLs and the id index, what a page's own origin serves and
// refuses, the quire://vault redirect, the webRequest guard's rules, rpc `from` ignoring
// params.from, files.read and embed.setHeight's checks, and the legacy localStorage head script.
// The Electron half (separate processes, recovery cards, migration) is scripts/verify-origins.mjs.
// Run: node scripts/smoke-origins.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-origins-"));
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
const { createVault, createPage, createFolder, readManifest, writeManifest, openStore, currentUser, beginEdit, abortEdit } = await import("../core/index.mjs");
const { startBrowserServer } = await import("../app/main/browser-server.mjs");
const O = await import("../app/main/origins.mjs");
const P = await import("../app/main/protocol.mjs");
const { runRpc } = await import("../app/main/ipc.mjs");
const { flushAutosaves } = await import("../app/main/autosave.mjs");

try {
  const vault = createVault(path.join(tmp, "v"), { name: "v", seed: false });
  createFolder(vault, "Kyoto trip");
  const a = createPage(vault, "Kyoto trip/Overview", { content: '<!doctype html><html><head><title>O</title></head><body><h1>Overview</h1><quire-embed src="Trip budget"></quire-embed></body></html>' });
  const b = createPage(vault, "Kyoto trip/Trip budget");
  const c = createPage(vault, "Notes", { format: "md", content: "# Notes\n\n![[Kyoto trip/Trip budget]]\n" });
  fs.writeFileSync(path.join(b.dir, "x.json"), '{"b":1}');
  fs.mkdirSync(path.join(b.dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(b.dir, "data", "secret.txt"), "no");
  fs.writeFileSync(path.join(b.dir, ".env"), "SECRET=1");
  writeManifest(b.dir, { ...readManifest(b.dir), backend: { run: "node server.js" } });
  fs.mkdirSync(path.join(b.dir, "backend"));
  fs.writeFileSync(path.join(b.dir, "backend", "server.js"), "// server");
  // A page whose manifest has no id gets one when it's first asked for (and an old-style
  // .quire manifest still makes it a page).
  fs.mkdirSync(path.join(vault, "Bare"));
  fs.writeFileSync(path.join(vault, "Bare", ".quire"), "{}\n");
  fs.writeFileSync(path.join(vault, "Bare", "index.html"), "<p>bare</p>");
  fs.writeFileSync(path.join(vault, "loose.txt"), "loose");

  // URLs and the id index.
  assert.equal(O.pageUrl(a.id, a.path), `quire://p-${a.id}/Kyoto%20trip/Overview/`);
  assert.equal(O.pageUrl(a.id, a.path, "img/x 1.png"), `quire://p-${a.id}/Kyoto%20trip/Overview/img/x%201.png`);
  assert.equal(O.idOfHost("p-" + a.id), a.id);
  assert.equal(O.idOfHost("vault"), null);
  assert.equal(O.idOfOrigin(`quire://p-${a.id}`), a.id);
  assert.equal(O.idOfOrigin("file://"), null);
  assert.equal(O.pageForOrigin(vault, `quire://p-${b.id}`), b.path);
  assert.equal(O.pageForOrigin(vault, "quire://vault"), null);
  assert.equal(O.pageForOrigin(vault, "quire://p-zzzzzzzzzz"), null);
  const bareId = O.idForPath(vault, "Bare");
  assert.match(bareId, /^[a-z0-9]{10}$/);
  assert.equal(readManifest(path.join(vault, "Bare")).id, bareId);
  assert.ok(fs.existsSync(path.join(vault, "Bare", ".noteblock")) && !fs.existsSync(path.join(vault, "Bare", ".quire")));
  // A rename keeps the id, so the origin (and its storage) stays.
  fs.renameSync(c.dir, path.join(vault, "Notes renamed"));
  assert.equal(O.pageForOrigin(vault, `quire://p-${c.id}`), "Notes renamed");
  fs.renameSync(path.join(vault, "Notes renamed"), c.dir);
  assert.equal(O.pageForOrigin(vault, `quire://p-${c.id}`), "Notes");

  // A page's own origin.
  const host = (n) => "p-" + n.id;
  let r = P.resolvePageRequest(vault, host(a), "/Kyoto%20trip/Overview/", { navigation: true, extraHead: () => '<meta name="x-extra">' });
  assert.equal(r.status, 200);
  assert.match(r.body, /<meta name="quire-page" content="Kyoto trip\/Overview"><meta name="x-extra">/);
  assert.equal(r.entryOf, "Kyoto trip/Overview");
  assert.equal(P.resolvePageRequest(vault, host(a), "/Kyoto%20trip/Overview", { navigation: true }).status, 302);
  assert.equal(P.resolvePageRequest(vault, host(b), "/Kyoto%20trip/Trip%20budget/x.json").status, 200);
  // Another page's file through my own origin: refused for a fetch, a navigation is sent to its origin.
  assert.equal(P.resolvePageRequest(vault, host(a), "/Kyoto%20trip/Trip%20budget/x.json").status, 404);
  r = P.resolvePageRequest(vault, host(a), "/Kyoto%20trip/Trip%20budget/", { navigation: true });
  assert.deepEqual(r, { status: 302, location: `quire://p-${b.id}/Kyoto%20trip/Trip%20budget/` });
  r = P.resolvePageRequest(vault, host(a), "/loose.txt", { navigation: true });
  assert.deepEqual(r, { status: 302, location: "quire://vault/loose.txt" });
  // Never served: data/, the manifest (.noteblock or .quire), dotfiles, the backend folder; /api goes to the page's backend.
  for (const f of ["data/secret.txt", ".noteblock", ".quire", ".env", "backend/server.js"]) assert.equal(P.resolvePageRequest(vault, host(b), "/Kyoto%20trip/Trip%20budget/" + f).status, 404, f);
  r = P.resolvePageRequest(vault, host(b), "/Kyoto%20trip/Trip%20budget/api/rows");
  assert.equal(r.status, "proxy");
  assert.equal(r.page, b.path);
  r = P.resolvePageRequest(vault, host(b), "/api/rows");
  assert.deepEqual([r.status, r.page, r.path], ["proxy", b.path, "/api/rows"]);
  assert.equal(P.resolvePageRequest(vault, "p-zzzzzzzzzz", "/x/").status, 404);
  assert.equal(P.resolvePageRequest(vault, host(a), "/Kyoto%20trip/Overview/../Trip%20budget/x.json").status, 404);

  // The legacy shared host redirects pages (and their files) to their own origins.
  assert.equal(P.vaultRedirect(vault, "/Kyoto%20trip/Trip%20budget/"), `quire://p-${b.id}/Kyoto%20trip/Trip%20budget/`);
  assert.equal(P.vaultRedirect(vault, "/Kyoto%20trip/Trip%20budget/x.json"), `quire://p-${b.id}/Kyoto%20trip/Trip%20budget/x.json`);
  assert.equal(P.vaultRedirect(vault, "/loose.txt"), null);
  assert.equal(P.resolveVaultRequest(vault, "/loose.txt").status, 200);

  // A built page's <base> is on its own origin.
  const built = createPage(vault, "Built");
  fs.mkdirSync(path.join(built.dir, "dist"));
  fs.writeFileSync(path.join(built.dir, "dist", "index.html"), "<html><head></head><body>b</body></html>");
  writeManifest(built.dir, { ...readManifest(built.dir), entry: "dist/index.html" });
  r = P.resolvePageRequest(vault, host(built), "/Built/", { navigation: true });
  assert.match(r.body, new RegExp(`<base href="quire://p-${built.id}/Built/dist/">`));

  // The webRequest guard: navigations and the app UI anywhere; a page only its own origin.
  const g = (url, resourceType, initiator) => P.originGuard({ url, resourceType, initiator });
  const A = `quire://p-${a.id}`;
  const B = `quire://p-${b.id}`;
  assert.equal(g(B + "/Kyoto%20trip/Trip%20budget/", "subFrame", A), true);
  assert.equal(g(B + "/Kyoto%20trip/Trip%20budget/x.json", "xhr", A), false);
  assert.equal(g(B + "/Kyoto%20trip/Trip%20budget/api/x", "xhr", A), false);
  assert.equal(g("quire://vault/Kyoto%20trip/Trip%20budget/x.json", "xhr", A), false);
  assert.equal(g(B + "/Kyoto%20trip/Trip%20budget/x.json", "xhr", B), true);
  assert.equal(g(B + "/Kyoto%20trip/Trip%20budget/x.png", "image", "file://"), true);
  assert.equal(g("quire://runtime/runtime.js", "script", A), true);
  assert.equal(g(B + "/Kyoto%20trip/Trip%20budget/x.json", "xhr", null), false);
  assert.equal(g("https://example.com/", "xhr", A), true);

  // Web navigations: links in the app or a page open in the browser; a page's own nested web
  // iframe (a hosted game) loads in place.
  const app = { url: "file:///app/index.html", parent: null };
  const pageFrame = { url: A + "/Apps/Blastside/", parent: app };
  assert.equal(P.opensInBrowser("https://example.com/", app), true);
  assert.equal(P.opensInBrowser("https://example.com/", pageFrame), true);
  assert.equal(P.opensInBrowser("https://example.com/", { url: B + "/x/", parent: pageFrame }), true);
  assert.equal(P.opensInBrowser("https://example.com/", { url: "about:blank", parent: pageFrame }), false);
  assert.equal(P.opensInBrowser("https://example.com/next", { url: "https://example.com/", parent: pageFrame }), false);
  assert.equal(P.opensInBrowser("https://example.com/", null), true);
  assert.equal(P.opensInBrowser(B + "/x/", pageFrame), false);

  // rpc: the caller is who main says it is; params.from is ignored.
  const user = currentUser();
  runRpc(vault, a.path, "store.insert", { table: "t", obj: { v: "mine" }, from: b.path });
  assert.equal(openStore(a.dir, user).all("t").length, 1);
  assert.equal(openStore(b.dir, user).all("t").length, 0, "a forged from must not write B's store");
  runRpc(vault, a.path, "kv.set", { key: "k", value: 1, from: b.path });
  assert.equal(openStore(b.dir, user).kvGet("k"), null);
  const bHtml = fs.readFileSync(path.join(b.dir, "index.html"), "utf8");
  runRpc(vault, a.path, "save", { regions: [{ replace: [0], before: null, html: "<p>planted</p>" }], from: b.path });
  assert.equal(fs.readFileSync(path.join(b.dir, "index.html"), "utf8"), bHtml);
  // query and pages still read across pages.
  openStore(b.dir, user).insert("rows", { n: 1 });
  assert.equal(runRpc(vault, a.path, "query", { page: b.path, table: "rows" }).length, 1);
  assert.ok(Array.isArray(runRpc(vault, a.path, "pages", {})));

  // files.read: another page's files, read-only, never its private parts.
  assert.equal(runRpc(vault, a.path, "files.read", { page: b.path, path: "x.json" }), '{"b":1}');
  assert.equal(runRpc(vault, b.path, "files.read", { page: "", path: "x.json" }), '{"b":1}');
  for (const bad of ["data/secret.txt", ".noteblock", ".quire", ".env", "backend/server.js", "../Overview/index.html", "node_modules/x"]) {
    assert.throws(() => runRpc(vault, a.path, "files.read", { page: b.path, path: bad }), /not allowed/, bad);
  }
  assert.throws(() => runRpc(vault, a.path, "files.read", { page: b.path, path: "nope.json" }), /no file/);

  // embed.setHeight: only from a page that embeds the target (html and markdown).
  assert.deepEqual(O.embedsIn('<quire-embed src="Trip budget"></quire-embed><quire-embed src=\'/Notes\'>', "Kyoto trip/Overview"), ["Kyoto trip/Trip budget", "Notes"]);
  runRpc(vault, a.path, "embed.setHeight", { page: b.path, height: 321 });
  assert.equal(readManifest(b.dir).embed.height, 321);
  runRpc(vault, c.path, "embed.setHeight", { page: b.path, height: 300 });
  assert.equal(readManifest(b.dir).embed.height, 300);
  assert.throws(() => runRpc(vault, b.path, "embed.setHeight", { page: a.path, height: 200 }), /doesn't embed/);

  // The legacy localStorage copy can't end its <script> early.
  const s = P.legacyStorageScript(JSON.stringify({ k: "</script><script>alert(1)</script>" }));
  assert.equal((s.match(/<\/script>/g) || []).length, 1);
  assert.deepEqual(JSON.parse(s.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "")), { k: "</script><script>alert(1)</script>" });
  assert.equal(P.legacyStorageScript(null), "");

  // A locked page is served from its snapshot on its own origin too.
  beginEdit(vault, b.path, { by: "smoke" });
  fs.writeFileSync(path.join(b.dir, "x.json"), '{"b":"edited"}');
  assert.equal(fs.readFileSync(P.resolvePageRequest(vault, host(b), "/Kyoto%20trip/Trip%20budget/x.json").file, "utf8"), '{"b":1}');
  abortEdit(vault, b.path);

  // Open in browser: the http paths are unchanged (no per-page origins there).
  const server = await startBrowserServer({ getVault: () => vault, runRpc });
  try {
    const base = server.urlFor(a.path);
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/[^/]+\/Kyoto%20trip\/Overview\/$/);
    const html = await (await fetch(base)).text();
    assert.match(html, /<meta name="quire-rpc"/);
    assert.doesNotMatch(html, /quire:\/\//);
    // The page is in the rpc URL its entry is given, never taken from the body.
    const bHtml = await (await fetch(server.urlFor(b.path))).text();
    const rpcUrl = new URL(bHtml.match(/<meta name="quire-rpc" content="([^"]+)"/)[1], base).href;
    assert.match(rpcUrl, /\/_quire\/rpc\/Kyoto%20trip\/Trip%20budget$/);
    const rpc = await (await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: a.path, method: "files.read", params: { page: b.path, path: "x.json" } }) })).json();
    assert.ok(rpc.ok.includes('"b"'));
    const bare = await fetch(base.replace(/Kyoto%20trip\/Overview\/$/, "_quire/rpc"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: b.path, method: "files.read", params: { path: "x.json" } }) });
    assert.equal(bare.status, 404, "an rpc without a page in its URL is refused");
  } finally {
    await server.close();
  }

  console.log("smoke-origins ok");
} finally {
  flushAutosaves();
  fs.rmSync(tmp, { recursive: true, force: true });
}
