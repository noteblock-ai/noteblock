// Folder publish smoke: stage a temp folder (no network) and check the tree, the generated index,
// rewritten links, the shared runtime, and the badge (managed yes, Cloudflare no, app no). Then the
// whole publish against the fake hosting server and fake wrangler: signed-out, the record, the
// reused slug, a failed build, the size limit, an empty folder, unpublish.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startFakeHosting } from "./fakes/hosting-server.mjs";
import { BRAND, siteUrl } from "../core/brand.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-folder-"));
const fake = await startFakeHosting({ sitesLimit: 10 });
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
process.env.QUIRE_HOSTING_URL = fake.url;
process.env.QUIRE_WRANGLER = path.join(here, "fakes", "wrangler.mjs");
process.env.FAKE_WRANGLER_LOGGED_IN = "1";

const { createVault, createPage, createFolder, findPage, readManifest, writeManifest } = await import("../core/index.mjs");
const { transformEntry } = await import("../app/main/transform.mjs");
const hosting = await import("../app/main/hosting.mjs");
const { folderPublishStatus, moveFolderRecords, publishFolder, publishPage, stageFolder, stageSite, unpublishFolder } = await import("../app/main/publish.mjs");

hosting.setTokenCipher({
  encrypt: (s) => Buffer.from(s, "utf8").map((b) => b ^ 0x5a),
  decrypt: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString("utf8"),
});

const BADGE = `>Made with ${BRAND.name}</a>`;
const env = { ...process.env };
const vault = createVault(path.join(tmp, "Vault"), { name: "Vault", seed: false });
const html = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>\n`;

createPage(vault, "Outside", { content: html("<p>outside</p>") });
createFolder(vault, "Kyoto trip");
createFolder(vault, "Kyoto trip/Days");
createFolder(vault, "Kyoto trip/Nothing here");
createPage(vault, "Kyoto trip/Budget", {
  content: html(
    [
      `<a id="rel" href="../Packing list/">rel</a>`,
      `<a id="enc" href="../Days/Day%202/?x=1#top">enc</a>`,
      `<a id="abs" href="quire://vault/Kyoto%20trip/Packing%20list/">abs</a>`,
      `<a id="root" href="/Kyoto trip/Days/Day 10/">root</a>`,
      `<a id="out" class="x" href="../../Outside/"><b>outside words</b></a>`,
      `<a id="vault" href="../../">vault words</a>`,
      `<a id="missing" href="../Gone/">missing words</a>`,
      `<a id="web" href="https://example.com/a">web</a>`,
      `<a id="anchor" href="#here">anchor</a>`,
      `<a id="own" href="notes.txt">own</a>`,
      `<a id="pdf" href="../Q3%20Report.PDF">pdf</a>`,
      `<a id="folder" href="../Days/">folder</a>`,
      `<a id="up" href="../">up</a>`,
      `<img id="pic" src="../photo.png">`,
      `<img id="pic-out" src="../../elsewhere.png">`,
      `<script>var s = '<a href="../../Outside/">in a script</a>';</script>`,
    ].join("\n"),
  ),
});
fs.writeFileSync(path.join(findPage(vault, "Kyoto trip/Budget").dir, "notes.txt"), "notes");
createPage(vault, "Kyoto trip/Packing list", { format: "md", content: "# Packing\n\n[Budget](../Budget/) and [away](../../Outside/)\n" });
createPage(vault, "Kyoto trip/Days/Day 2", { content: html("<p>two</p>") });
createPage(vault, "Kyoto trip/Days/Day 10", { content: html(`<a id="back" href="../../Budget/">back</a>`) });
fs.writeFileSync(path.join(vault, "Kyoto trip", "Q3 Report.PDF"), "%PDF");
fs.writeFileSync(path.join(vault, "Kyoto trip", "photo.png"), "png");
fs.writeFileSync(path.join(vault, "Kyoto trip", "index.html"), "a plain file with the generated page's name");
fs.writeFileSync(path.join(vault, "Kyoto trip", ".hidden"), "never");

// A page with a backend (its folder stays home) and one with a build (ships its output).
createPage(vault, "Kyoto trip/With backend", { content: html("<p>api</p>") });
{
  const dir = findPage(vault, "Kyoto trip/With backend").dir;
  writeManifest(dir, { ...readManifest(dir), backend: { dir: "backend", run: "node server.js" } });
  fs.mkdirSync(path.join(dir, "backend"));
  fs.writeFileSync(path.join(dir, "backend", "server.js"), "// secret");
}
createPage(vault, "Kyoto trip/Built", { content: html(`<a id="built-rel" href="../Budget/">x</a>`) });
{
  const dir = findPage(vault, "Kyoto trip/Built").dir;
  writeManifest(dir, { ...readManifest(dir), build: `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html',require('fs').readFileSync('index.html'));require('fs').writeFileSync('dist/app.js','1')"`, entry: "dist/index.html", source: "index.html" });
}

const tree = (dir, rel = "") =>
  fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? rel + "/" + e.name : e.name;
    return e.isDirectory() ? tree(dir, r) : [r];
  });
const hrefOf = (doc, id) => {
  const m = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*\\b(?:href|src)="([^"]*)"`).exec(doc);
  return m ? m[1].replaceAll("&amp;", "&") : null;
};
/** Where an href on the staged page at `/<at>/` lands, as a site path. */
const landing = (href, at) => {
  const u = new URL(href, `https://site.test/${at}`);
  return u.pathname + u.search + u.hash;
};

try {
  /* ---- staging, no network */
  await assert.rejects(stageFolder(vault, "Outside"), /Outside is a page/);
  await assert.rejects(stageFolder(vault, "Nope"), /No folder: Nope/);
  await assert.rejects(stageFolder(vault, "Kyoto trip/Nothing here"), /Nothing here is empty/);

  // The build's output exists only after building; a page without it is left out of the stage.
  const notBuilt = await stageFolder(vault, "Kyoto trip");
  assert.deepEqual(notBuilt.plan.skipped, ["Kyoto trip/Built"]);
  execFileSync(process.execPath, ["-e", "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html',require('fs').readFileSync('index.html'));require('fs').writeFileSync('dist/app.js','1')"], { cwd: findPage(vault, "Kyoto trip/Built").dir });

  const { site, plan } = await stageFolder(vault, "Kyoto trip");
  const files = tree(site);
  for (const f of [
    "index.html",
    "_quire/runtime.js",
    "_quire/theme.css",
    "budget/index.html",
    "budget/notes.txt",
    "packing-list/index.html",
    "days/day-2/index.html",
    "days/day-10/index.html",
    "with-backend/index.html",
    "built/index.html",
    "built/dist/app.js",
    "q3-report.pdf",
    "photo.png",
    "index-2.html",
  ]) {
    assert.ok(files.includes(f), `${f} not staged: ${files.join(", ")}`);
  }
  assert.ok(!files.some((f) => f.includes("/.") || f.startsWith(".")), "dotfile staged");
  assert.ok(!files.some((f) => f.startsWith("with-backend/backend")), "backend folder staged");
  assert.ok(!files.some((f) => f.includes("nothing-here")), "empty folder staged");
  assert.equal(fs.readFileSync(path.join(site, "index-2.html"), "utf8"), "a plain file with the generated page's name");

  // One runtime, at the root, and every page reaches it there.
  assert.deepEqual(files.filter((f) => f.endsWith("runtime.js")), ["_quire/runtime.js"]);
  const read = (rel) => fs.readFileSync(path.join(site, rel), "utf8");
  for (const p of plan.pages) {
    const doc = read(p.staged + "/index.html");
    assert.ok(doc.includes('src="/_quire/runtime.js"'), p.staged);
    assert.ok(!doc.includes("quire://runtime"), p.staged);
    assert.ok(doc.includes(BADGE), `no badge on ${p.staged}`);
  }
  assert.ok(read("built/index.html").includes('<base href="/built/dist/">'));

  // The index: name, nested list, sidebar order (folders first, numbers as numbers), the badge.
  const index = read("index.html");
  assert.ok(index.includes("<h1>Kyoto trip</h1>"));
  assert.ok(index.includes(BADGE));
  assert.ok(index.includes(`href="${siteUrl()}"`));
  assert.ok(!index.includes("<script"), "the index has no JS");
  const order = [...index.matchAll(/<a(?: class="file")? href="([^"]+)">/g)].map((m) => m[1]).filter((h) => !h.startsWith("http"));
  assert.deepEqual(order, ["days/day-2/", "days/day-10/", "budget/", "built/", "index-2.html", "packing-list/", "photo.png", "q3-report.pdf", "with-backend/"]);
  for (const h of order) assert.ok(files.includes(h.endsWith("/") ? h + "index.html" : h), `index links to a missing ${h}`);
  assert.ok(/<span class="folder">Days<\/span><ul>/.test(index), "nested list");
  assert.ok(!index.includes("Nothing here"));

  // Links.
  const budget = read("budget/index.html");
  const at = "budget/";
  assert.equal(landing(hrefOf(budget, "rel"), at), "/packing-list/");
  assert.equal(landing(hrefOf(budget, "enc"), at), "/days/day-2/?x=1#top");
  assert.equal(landing(hrefOf(budget, "abs"), at), "/packing-list/");
  assert.equal(landing(hrefOf(budget, "root"), at), "/days/day-10/");
  assert.equal(landing(hrefOf(budget, "pdf"), at), "/q3-report.pdf");
  assert.equal(landing(hrefOf(budget, "folder"), at), "/#days");
  assert.equal(landing(hrefOf(budget, "up"), at), "/");
  assert.equal(landing(hrefOf(budget, "pic"), at), "/photo.png");
  assert.equal(hrefOf(budget, "web"), "https://example.com/a");
  assert.equal(hrefOf(budget, "anchor"), "#here");
  assert.equal(hrefOf(budget, "own"), "notes.txt");
  assert.equal(hrefOf(budget, "pic-out"), "../../elsewhere.png"); // not a link: left alone
  // Outside the folder, or nowhere: the words stay, the link goes.
  assert.ok(budget.includes("<b>outside words</b>"));
  assert.ok(!budget.includes('id="out"'));
  assert.ok(budget.includes("vault words") && !budget.includes('id="vault"'));
  assert.ok(budget.includes("missing words") && !budget.includes('id="missing"'));
  assert.ok(budget.includes(`'<a href="../../Outside/">in a script</a>'`), "a script's text changed");
  // Markdown, a page deeper down, and a built page behind its <base>.
  assert.ok(read("packing-list/index.html").includes('href="/budget/"'));
  assert.ok(!read("packing-list/index.html").includes("../../Outside"));
  assert.ok(read("packing-list/index.html").includes("away"));
  assert.equal(landing(hrefOf(read("days/day-10/index.html"), "back"), "days/day-10/"), "/budget/");
  assert.equal(hrefOf(read("built/index.html"), "built-rel"), "../Budget/", "from dist/, that link stays inside the page, as it does in the app");
  fs.rmSync(path.dirname(site), { recursive: true, force: true });

  // A 200-page folder shares its runtime, so it fits.
  createFolder(vault, "Big");
  for (let i = 0; i < 200; i++) createPage(vault, `Big/Note ${i}`);
  const big = await stageFolder(vault, "Big");
  const bigFiles = tree(big.site);
  const bigBytes = bigFiles.reduce((n, f) => n + fs.statSync(path.join(big.site, f)).size, 0);
  assert.ok(bigFiles.length < 1000, `${bigFiles.length} files`);
  assert.ok(bigBytes < 25 * 1024 * 1024, `${bigBytes} bytes`);
  fs.rmSync(path.dirname(big.site), { recursive: true, force: true });
  fs.rmSync(path.join(vault, "Big"), { recursive: true, force: true });

  /* ---- the badge on single pages */
  const outside = findPage(vault, "Outside");
  const staged = async (opts) => fs.readFileSync(path.join((await stageSite(outside, opts)).site, "index.html"), "utf8");
  assert.ok(!(await staged()).includes(BADGE), "stageSite defaults to no badge");
  const withB = await staged({ badge: true });
  assert.ok(withB.includes(BADGE));
  assert.ok(withB.indexOf(BADGE) < withB.lastIndexOf("</body>"), "badge is in the body");
  assert.ok(/@media print\{[^}]*display:none/.test(withB));
  assert.ok(!transformEntry(html("<p>x</p>"), "html", { pagePath: "Outside", title: "t" }).includes(BADGE), "the app's transform adds no badge");

  // Through the real paths: Cloudflare gets none, managed gets one, the fingerprint doesn't care.
  const siteOf = () => path.join(os.tmpdir(), "quire-publish", outside.id, "site", "index.html");
  await publishPage(vault, "Outside", { env, host: "cloudflare" });
  assert.ok(!fs.readFileSync(siteOf(), "utf8").includes(BADGE), "Cloudflare publish has a badge");
  const printCf = readManifest(outside.dir).public.fingerprint;

  /* ---- publishing, against the fake */
  await assert.rejects(publishFolder(vault, "Kyoto trip", { env }), (e) => e.code === "signin");
  const acct = await hosting.signIn({ openExternal: async (url) => assert.equal((await fetch(url)).status, 200) });
  assert.equal(acct.signedIn, true);

  await publishPage(vault, "Outside", { env, host: "quire" });
  assert.ok(fs.readFileSync(siteOf(), "utf8").includes(BADGE), "managed publish has no badge");
  assert.equal(readManifest(outside.dir).public.fingerprint, printCf);
  fs.rmSync(path.dirname(siteOf()), { recursive: true, force: true });
  await hosting.deleteSite("outside");

  assert.deepEqual(await folderPublishStatus(vault, "Kyoto trip"), { public: null, upToDate: false });
  const first = await publishFolder(vault, "Kyoto trip", { env });
  const recordsFile = path.join(vault, ".noteblock", "published-folders.json");
  const record = JSON.parse(fs.readFileSync(recordsFile, "utf8"))["Kyoto trip"];
  assert.deepEqual(Object.keys(record).sort(), ["fingerprint", "host", "slug", "updatedAt", "url"]);
  assert.equal(record.host, "quire");
  assert.equal(record.slug, "kyoto-trip");
  assert.deepEqual(first.public, record);
  const uploaded = fake.sites.get("kyoto-trip").files.map((f) => f.name);
  assert.ok(uploaded.includes("index.html") && uploaded.includes("days/day-10/index.html") && uploaded.includes("_quire/runtime.js"));
  assert.deepEqual((await folderPublishStatus(vault, "Kyoto trip")).upToDate, true);
  // Committed with the vault, like a page's `public`.
  assert.throws(() => execFileSync("git", ["-C", vault, "check-ignore", recordsFile], { stdio: "ignore" }));

  // Republish reuses the slug; an edit, a new plain file or a renamed folder shows as not live.
  const creates = () => fake.log.filter((r) => r.method === "POST" && r.path === "/api/sites").length;
  const before = creates();
  fs.appendFileSync(path.join(findPage(vault, "Kyoto trip/Days/Day 2").dir, "index.html"), "<p>More</p>\n");
  assert.equal((await folderPublishStatus(vault, "Kyoto trip")).upToDate, false);
  await publishFolder(vault, "Kyoto trip", { env });
  assert.equal(creates(), before);
  assert.equal(fake.sites.get("kyoto-trip").version, 2);
  assert.equal((await folderPublishStatus(vault, "Kyoto trip")).upToDate, true);
  fs.writeFileSync(path.join(vault, "Kyoto trip", "more.txt"), "more");
  assert.equal((await folderPublishStatus(vault, "Kyoto trip")).upToDate, false);
  fs.rmSync(path.join(vault, "Kyoto trip", "more.txt"));

  // A site removed on the server: the next publish makes a new one.
  fake.sites.delete("kyoto-trip");
  await publishFolder(vault, "Kyoto trip", { env });
  assert.equal(fake.sites.get("kyoto-trip").version, 1);

  // Moving the folder takes the record with it.
  assert.equal(moveFolderRecords(vault, "Kyoto trip", "Trips/Kyoto trip"), true);
  assert.equal((await folderPublishStatus(vault, "Trips/Kyoto trip")).public.slug, "kyoto-trip");
  assert.equal(moveFolderRecords(vault, "Trips/Kyoto trip", "Kyoto trip"), true);
  assert.equal(moveFolderRecords(vault, "Elsewhere", "Other"), false);

  // A failed build names the page and uploads nothing.
  createFolder(vault, "Broken");
  createPage(vault, "Broken/Fine", { content: html("<p>ok</p>") });
  createPage(vault, "Broken/Bad", { content: html("<p>bad</p>") });
  const badDir = findPage(vault, "Broken/Bad").dir;
  writeManifest(badDir, { ...readManifest(badDir), build: `node -e "process.exit(3)"` });
  const puts = () => fake.log.filter((r) => r.method === "PUT").length;
  let putsBefore = puts();
  await assert.rejects(publishFolder(vault, "Broken", { env }), (e) => {
    assert.match(e.message, /build failed for Broken\/Bad/);
    assert.deepEqual(e.failed, ["Broken/Bad"]);
    return true;
  });
  assert.equal(puts(), putsBefore);

  // Over the limit: a sentence with the size, and nothing created or uploaded.
  createFolder(vault, "Huge");
  fs.writeFileSync(path.join(vault, "Huge", "film.mov"), "");
  fs.truncateSync(path.join(vault, "Huge", "film.mov"), 26 * 1024 * 1024);
  const createsBefore = creates();
  putsBefore = puts();
  await assert.rejects(publishFolder(vault, "Huge", { env }), new RegExp(`This folder is 26\\.0 MB; a ${BRAND.name} site can be 25 MB`));
  assert.equal(creates(), createsBefore);
  assert.equal(puts(), putsBefore);

  // Fits only until the pages are counted too: the same sentence, from the staged size.
  fs.truncateSync(path.join(vault, "Huge", "film.mov"), 25 * 1024 * 1024 - 1000);
  createPage(vault, "Huge/Note", { content: html("<p>x</p>") });
  await assert.rejects(publishFolder(vault, "Huge", { env }), /This folder is 25\.\d MB/);
  assert.equal(creates(), createsBefore);
  assert.equal(puts(), putsBefore);

  // Empty folder.
  await assert.rejects(publishFolder(vault, "Kyoto trip/Nothing here", { env }), /Nothing here is empty/);
  assert.equal(puts(), putsBefore);

  // Unpublish removes the site and the record, and is fine with nothing to do.
  await unpublishFolder(vault, "Kyoto trip", { env });
  assert.equal(fake.sites.has("kyoto-trip"), false);
  assert.deepEqual(await folderPublishStatus(vault, "Kyoto trip"), { public: null, upToDate: false });
  assert.equal(await unpublishFolder(vault, "Kyoto trip", { env }), null);
  console.log("publish-folder smoke ok");
} finally {
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
