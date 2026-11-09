// Publishing a page: build it, stage it as a static site (the transformed entry, the page's
// own files and Quire's runtime under /_quire/), and put it on one of two hosts:
// - "quire": managed hosting, pageHost(slug) from core/brand.mjs (hosting.mjs);
// - "cloudflare": the person's own Cloudflare account, as a Worker with static assets deployed
//   with wrangler (below).
// What's live is recorded in the page's .noteblock as `public` ({host, url, …}; no host = an older
// cloudflare record), with a fingerprint of the page's files so the app can tell when there are
// edits that aren't live. A page is live on one host at a time.
// A plain folder publishes to managed hosting as one site (publishFolder, at the bottom), recorded
// in <vault>/.noteblock/published-folders.json because a folder has no manifest.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseHtml } from "node-html-parser";
import { buildInfo, findPage, isBuildOutput, isPageDir, listTree, metaPath, newMetaPath, normPath, parseBackend, pathDir, readManifest, runBuild, walkTree, writeManifest } from "../../core/index.mjs";
import { transformEntry } from "./protocol.mjs";
import { escAttr } from "./transform.mjs";
import { cloudflareAccountId, dashboardUrl, runWrangler } from "./cloudflare.mjs";
import { assertSiteFits, deleteSite, publishToQuire, requireAccount, unpublishFromQuire, uploadSite } from "./hosting.mjs";
import { BRAND, pageHost, siteUrl } from "../../core/brand.mjs";

export const HOSTS = ["quire", "cloudflare"];
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");
const COMPAT_DATE = "2026-10-01";

/**
 * Files a published page is made from: everything but data/, node_modules, dotfiles, build
 * output and the backend folder (server code and secrets stay on the Mac).
 */
function publishedFiles(dir) {
  const info = buildInfo(dir);
  const backend = parseBackend((readManifest(dir) || {}).backend);
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.name.startsWith(".") || e.name === "node_modules" || r === "data") continue;
      if (backend && (r === backend.dir || r.startsWith(backend.dir + "/"))) continue;
      if (info && isBuildOutput(info, r)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out;
}

const fingerprints = new Map(); // page dir → {sig, hash}: the last hash and what it was made from
const fingerprintRuns = new Map(); // dir + sig → the hash in progress, so repeat asks share one

/** What a fingerprint covers, and a signature (name, size, mtime of each file) that changes when it does. */
function fingerprintInput(dir) {
  const m = readManifest(dir) || {};
  const head = JSON.stringify({ entry: m.entry, source: m.source, build: m.build, title: m.title });
  const files = publishedFiles(dir);
  const stats = files.map((r) => {
    const s = fs.statSync(path.join(dir, r));
    return `${r}\0${s.size}\0${s.mtimeMs}`;
  });
  return { head, files, sig: head + "\0" + stats.join("\0") };
}

/**
 * Hash of what a publish would be made from (sources, not build output), plus the parts of
 * manifest that change what's served. Equal to `public.fingerprint` = nothing new to publish.
 */
export function publishFingerprint(dir) {
  const { head, files, sig } = fingerprintInput(dir);
  const hit = fingerprints.get(dir);
  if (hit?.sig === sig) return hit.hash;
  const h = crypto.createHash("sha1");
  h.update(head);
  for (const r of files) {
    h.update(r + "\0");
    h.update(fs.readFileSync(path.join(dir, r)));
  }
  const hash = h.digest("hex");
  fingerprints.set(dir, { sig, hash });
  return hash;
}

/**
 * The same hash without holding up the main process: it starts on a later tick and reads in
 * chunks, so a click or another page's IPC gets through. Unchanged files cost a walk and a stat.
 */
export async function publishFingerprintAsync(dir) {
  await new Promise((r) => setImmediate(r));
  const { head, files, sig } = fingerprintInput(dir);
  const hit = fingerprints.get(dir);
  if (hit?.sig === sig) return hit.hash;
  const key = dir + "\0" + sig;
  let run = fingerprintRuns.get(key);
  if (!run) {
    run = (async () => {
      const h = crypto.createHash("sha1");
      h.update(head);
      for (const r of files) {
        h.update(r + "\0");
        for await (const chunk of fs.createReadStream(path.join(dir, r))) h.update(chunk);
      }
      const hash = h.digest("hex");
      fingerprints.set(dir, { sig, hash });
      return hash;
    })().finally(() => fingerprintRuns.delete(key));
    fingerprintRuns.set(key, run);
  }
  return run;
}

/** A Worker name for a page: quire-<folder name>, lowercased, [a-z0-9-], at most 63 chars. */
export function workerName(node) {
  const slug = node.path
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return "quire-" + (slug || node.id || "page");
}

/** A `public` record with its host filled in (records from before hosts are cloudflare). */
export function normalizePublic(pub) {
  if (!pub || !pub.url) return null;
  const host = pub.host === "quire" ? "quire" : "cloudflare";
  const out = { ...pub, host };
  // Published from 0.2.x at <slug>-quire.harborapps.org: that address redirects, show the new one.
  if (host === "quire" && pub.slug && String(pub.url).includes(BRAND.legacyPageSuffix)) out.url = `https://${pageHost(pub.slug)}/`;
  if (host === "cloudflare" && pub.worker && !out.dashboardUrl) out.dashboardUrl = dashboardUrl(pub.accountId || null, pub.worker);
  return out;
}

export function publishStatus(vault, pagePath) {
  const node = findPage(vault, pagePath);
  const pub = normalizePublic((readManifest(node.dir) || {}).public);
  if (!pub) return { public: null, upToDate: false };
  return { public: pub, upToDate: pub.fingerprint === publishFingerprint(node.dir) };
}

/** Where the page is live, or null. Reads the manifest only, so it's safe on a click. */
export function publicRecord(vault, pagePath) {
  return normalizePublic((readManifest(findPage(vault, pagePath).dir) || {}).public);
}

/** publishStatus off the click path. The record is read after hashing, so a publish that finished meanwhile counts. */
export async function publishStatusAsync(vault, pagePath) {
  const node = findPage(vault, pagePath);
  if (!publicRecord(vault, pagePath)) return { public: null, upToDate: false };
  const fingerprint = await publishFingerprintAsync(node.dir);
  const pub = publicRecord(vault, pagePath);
  if (!pub) return { public: null, upToDate: false };
  return { public: pub, upToDate: pub.fingerprint === fingerprint };
}

function copyTree(from, to) {
  return fsp.cp(from, to, { recursive: true, filter: (src) => !path.basename(src).startsWith(".") || src === from });
}

// Managed hosting's credit, added to the staged copy only: the app and the "Open in browser" server
// never stage, the hosting server stays byte-identical, and self-hosted pages don't get it. The
// page theme has no dark mode, so neither does this.
const BADGE =
  `<style>@media print{.nb-made-with{display:none!important}}</style>` +
  `<a class="nb-made-with" href="${siteUrl()}" style="position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:3px 8px;font:12px/1.4 system-ui,-apple-system,sans-serif;color:#6b7280;background:#fff;border:1px solid #e5e7eb;border-radius:6px;text-decoration:none">Made with ${BRAND.name}</a>`;

/** `html` with the badge as the last thing in its body. */
export function withBadge(html) {
  const at = html.toLowerCase().lastIndexOf("</body");
  return at < 0 ? html + BADGE : html.slice(0, at) + BADGE + html.slice(at);
}

/**
 * Stage the page as a static site in a temp folder. Returns {work, site} (site = work/site).
 * `badge`: the site goes to managed hosting.
 */
export async function stageSite(node, { badge = false } = {}) {
  const work = path.join(os.tmpdir(), "quire-publish", node.id || workerName(node));
  const site = path.join(work, "site");
  await stage(node, site, { badge });
  return { work, site };
}

/** Noteblock's runtime at site/_quire/. Its own files point at quire://runtime/ (fonts in theme.css); on the web that's /_quire/. */
async function stageRuntime(site) {
  await copyTree(RUNTIME_DIR, path.join(site, "_quire"));
  for (const f of ["theme.css", "runtime.js"]) {
    const file = path.join(site, "_quire", f);
    if (fs.existsSync(file)) await fsp.writeFile(file, (await fsp.readFile(file, "utf8")).replaceAll("quire://runtime/", "/_quire/"));
  }
}

/**
 * Stage one page into `site`. `prefix` is the URL path `site` is served at; a page in a folder site
 * has its own, shares the site's runtime (`runtime: false`) and has its links fixed by `rewrite`.
 */
async function stage(node, site, { badge = false, prefix = "/", runtime = true, rewrite = null } = {}) {
  await fsp.rm(site, { recursive: true, force: true });
  await fsp.mkdir(site, { recursive: true });
  const info = buildInfo(node.dir);
  // A built page ships its build output only; any other page ships its own files.
  if (info?.outDir) await copyTree(path.join(node.dir, info.outDir), path.join(site, info.outDir));
  else {
    for (const r of publishedFiles(node.dir)) {
      await fsp.mkdir(path.dirname(path.join(site, r)), { recursive: true });
      await fsp.copyFile(path.join(node.dir, r), path.join(site, r));
    }
  }
  if (runtime) await stageRuntime(site);

  // The entry, transformed as the app serves it, becomes the site's index.html. Its runtime
  // links point at /_quire/; an entry in a subfolder keeps resolving assets from there.
  const entry = node.entry;
  const src = await fsp.readFile(path.join(node.dir, entry), "utf8");
  const entryDir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
  let html = transformEntry(src, /\.md$/i.test(entry) ? "md" : "html", {
    pagePath: node.path,
    title: node.title,
    baseHref: entryDir ? prefix + entryDir : null,
  }).replaceAll("quire://runtime/", "/_quire/");
  if (rewrite) html = rewrite(html);
  if (badge) html = withBadge(html);
  await fsp.writeFile(path.join(site, "index.html"), html);
}

/**
 * Publish to `host` (default: where the page is live now, else "quire"). If the page is live on the other host, it comes down
 * from there first (the app asks before that). Returns {public, output}.
 * @param {{env: NodeJS.ProcessEnv, host?: "quire"|"cloudflare"}} opts
 */
export async function publishPage(vault, pagePath, { env, host }) {
  const node = findPage(vault, pagePath);
  const prev = normalizePublic((readManifest(node.dir) || {}).public);
  host ||= prev?.host || "quire";
  if (!HOSTS.includes(host)) throw new Error(`Unknown host: ${host}`);
  if (prev && prev.host !== host) await unpublishPage(vault, pagePath, { env });
  return host === "quire" ? publishToQuire(vault, pagePath, { env }) : publishToCloudflare(vault, pagePath, { env });
}

/** Build (if the page has a build), stage and deploy to the person's Cloudflare with wrangler. */
async function publishToCloudflare(vault, pagePath, { env }) {
  const node = findPage(vault, pagePath);
  if (node.build) {
    const b = await runBuild(node.dir, { env });
    if (!b.ok) throw Object.assign(new Error("The build failed, so nothing was published."), { output: b.output });
  }
  const fingerprint = await publishFingerprintAsync(node.dir);
  const prev = (readManifest(node.dir) || {}).public || {};
  const worker = prev.worker || workerName(node);

  const { work } = await stageSite(node); // no badge: this is the person's own hosting
  fs.writeFileSync(
    path.join(work, "wrangler.json"),
    JSON.stringify(
      {
        name: worker,
        compatibility_date: COMPAT_DATE,
        workers_dev: true,
        assets: { directory: "./site", not_found_handling: "single-page-application" },
      },
      null,
      2,
    ),
  );
  const r = await runWrangler(["deploy", "--config", "wrangler.json"], { cwd: work, env });
  if (!r.ok) {
    const msg = /not authenticated|wrangler login|not logged in/i.test(r.output)
      ? "Log in to Cloudflare in Settings → Publishing to publish there."
      : "Deploying to Cloudflare failed.";
    throw Object.assign(new Error(msg), { output: r.output });
  }
  const url = (/https:\/\/[^\s]+\.workers\.dev/.exec(r.output) || [])[0] || prev.url;
  if (!url) throw Object.assign(new Error("Deployed, but wrangler didn't print the page's URL."), { output: r.output });

  const accountId = (prev.host !== "quire" && prev.accountId) || (await cloudflareAccountId({ env }));
  const record = {
    host: "cloudflare",
    url,
    worker,
    accountId,
    dashboardUrl: dashboardUrl(accountId, worker),
    publishedAt: new Date().toISOString(),
    fingerprint,
  };
  const m = readManifest(node.dir) || {};
  writeManifest(node.dir, { ...m, public: record });
  return { public: record, output: r.output };
}

/** Take the page down from whichever host it's on and forget it was published. */
export async function unpublishPage(vault, pagePath, { env }) {
  const node = findPage(vault, pagePath);
  const m = readManifest(node.dir) || {};
  if (normalizePublic(m.public)?.host === "quire") return unpublishFromQuire(vault, pagePath);
  const worker = m.public?.worker;
  if (worker) {
    const work = path.join(os.tmpdir(), "quire-publish", node.id || worker);
    fs.mkdirSync(work, { recursive: true });
    const r = await runWrangler(["delete", "--name", worker, "--force"], { cwd: work, env });
    if (!r.ok && !/not found|does not exist/i.test(r.output)) {
      throw Object.assign(new Error("Removing the page from Cloudflare failed."), { output: r.output });
    }
  }
  delete m.public;
  writeManifest(node.dir, m);
  return null;
}

/* ------------------------------------------------------------------ a folder as one site */

const RECORDS_FILE = "published-folders.json";

/** {"<folder path>": {host, slug, url, fingerprint, updatedAt}}: committed, like a page's `public`. */
function readFolderRecords(vault) {
  try {
    const r = JSON.parse(fs.readFileSync(metaPath(vault, RECORDS_FILE), "utf8"));
    return r && typeof r === "object" && !Array.isArray(r) ? r : {};
  } catch {
    return {};
  }
}

function writeFolderRecords(vault, records) {
  const file = newMetaPath(vault, RECORDS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(records, null, 2) + "\n");
}

/** A folder (or what's under it) moved: its records follow, so its site can still be updated or removed. */
export function moveFolderRecords(vault, from, to) {
  const records = readFolderRecords(vault);
  const next = {};
  let moved = false;
  for (const [k, v] of Object.entries(records)) {
    const inside = k === from || k.startsWith(from + "/");
    moved ||= inside;
    next[inside ? to + k.slice(from.length) : k] = v;
  }
  if (moved) writeFolderRecords(vault, next);
  return moved;
}

function slugPart(name, fallback) {
  const s = String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || fallback;
}

/** `slug`, or `slug-2`… (before any extension) when this directory already has it. */
function uniqueSlug(slug, taken, ext = "") {
  let s = slug + ext;
  for (let i = 2; taken.has(s); i++) s = `${slug}-${i}${ext}`;
  taken.add(s);
  return s;
}

/**
 * What a folder publishes: the tree in sidebar order with each row's site path (`staged`), plus
 * `targets`, vault path → {kind, staged}, which is what a link can point at. A page with no entry
 * file or build output yet is left out and named in `skipped`; a subfolder with nothing in it is left out.
 */
function folderPlan(vault, folderPath) {
  const norm = normPath(folderPath);
  if (!norm) throw new Error("Choose a folder to publish.");
  if (isPageDir(pathDir(vault, norm))) throw new Error(`${norm} is a page, not a folder.`);
  let root = null;
  for (const n of walkTree(listTree(vault))) {
    if (n.kind === "folder" && n.path === norm) {
      root = n;
      break;
    }
  }
  if (!root) throw new Error(`No folder: ${norm}`);

  const pages = [];
  const files = [];
  const skipped = [];
  const targets = new Map([[norm, { kind: "folder", staged: "" }]]);
  const walk = (nodes, prefix, taken) => {
    const rows = [];
    for (const n of nodes) {
      const name = n.path.split("/").pop();
      if (n.kind === "folder") {
        const staged = prefix + uniqueSlug(slugPart(name, "folder"), taken);
        const children = walk(n.children, staged + "/", new Set());
        if (!children.length) continue;
        targets.set(n.path, { kind: "folder", staged });
        rows.push({ kind: "folder", title: name, staged, children });
      } else if (n.kind === "page") {
        const outDir = buildInfo(n.dir)?.outDir;
        if (!fs.existsSync(path.join(n.dir, n.entry)) || (outDir && !fs.existsSync(path.join(n.dir, outDir)))) {
          skipped.push(n.path);
          continue;
        }
        const staged = prefix + uniqueSlug(slugPart(name, "page"), taken);
        targets.set(n.path, { kind: "page", staged });
        pages.push({ node: n, staged });
        rows.push({ kind: "page", title: n.title, staged });
      } else if (n.kind === "file") {
        const m = /^(.+)(\.[A-Za-z0-9]{1,12})$/.exec(name);
        const staged = prefix + uniqueSlug(slugPart(m ? m[1] : name, "file"), taken, m ? m[2].toLowerCase() : "");
        targets.set(n.path, { kind: "file", staged });
        files.push({ path: n.path, abs: pathDir(vault, n.path), staged });
        rows.push({ kind: "file", title: name, staged });
      }
    }
    return rows;
  };
  // Staged at the site's root, these names are the generated list and the shared runtime.
  const rows = walk(root.children, "", new Set(["index.html", "_quire"]));
  const builds = [...walkTree(root.children)].filter((n) => n.kind === "page" && n.build);
  return { path: norm, name: norm.split("/").pop(), rows, pages, files, skipped, targets, builds };
}

const siteHref = (staged) => "/" + staged.split("/").map(encodeURIComponent).join("/");

/**
 * Where a link in `node` goes in the folder's site: {keep: true} (not ours to change), {href}, or
 * {gone: true} for somewhere the site doesn't have (outside the folder, or missing). It resolves
 * the way the app does, against the page's quire:// address, so ../Other/, /Folder/Other/ and
 * quire://vault/Folder/Other/ are all the same link.
 */
function resolveFolderLink(plan, node, href) {
  const raw = String(href || "").trim();
  if (!raw || raw.startsWith("#")) return { keep: true };
  const entryDir = node.entry.includes("/") ? node.entry.slice(0, node.entry.lastIndexOf("/") + 1) : "";
  const base = "quire://vault/" + [...node.path.split("/"), ...entryDir.split("/").filter(Boolean)].map(encodeURIComponent).join("/") + "/";
  let url;
  let segs;
  try {
    url = new URL(raw, base);
    if (url.protocol !== "quire:" || url.host === "runtime") return { keep: true };
    segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { keep: true };
  }
  const relative = !raw.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(raw);
  const tail = url.search + url.hash;
  for (let i = segs.length; i > 0; i--) {
    const hit = plan.targets.get(segs.slice(0, i).join("/"));
    if (!hit) continue;
    const rest = segs.slice(i);
    if (hit.kind === "page") {
      // Inside this page, a relative link already works where the page is staged.
      if (relative && segs.slice(0, i).join("/") === node.path) return { keep: true };
      return { href: siteHref(hit.staged) + "/" + rest.map(encodeURIComponent).join("/") + tail };
    }
    if (rest.length) return { gone: true };
    if (hit.kind === "file") return { href: siteHref(hit.staged) + tail };
    // A folder has no page of its own: its place in the site's list.
    return { href: hit.staged ? "/#" + hit.staged : "/" };
  }
  return { gone: true };
}

const START_TAG = /^<[^\s/>]+(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?|\s*\/)*\s*>/;
const LINK_ATTR = { a: "href", img: "src", video: "src", audio: "src", source: "src", iframe: "src", embed: "src" };

/** Every <a> and media element's start tag repointed, by splicing, so nothing else in the page changes. */
function rewriteFolderLinks(plan, node, html) {
  const root = parseHtml(html, { comment: false, lowerCaseTagName: false, blockTextElements: { script: true, noscript: true, style: true } });
  const edits = []; // [start, end, replacement]
  const visit = (el) => {
    for (const child of el.childNodes || []) {
      if (child.nodeType !== 1) continue;
      const tagName = String(child.rawTagName || "").toLowerCase();
      const attr = LINK_ATTR[tagName];
      const [start, end] = child.range;
      const tag = attr && html[start] === "<" ? START_TAG.exec(html.slice(start, end))?.[0] : null;
      const value = tag && new RegExp(`(\\s${attr}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(tag);
      if (value) {
        const href = value[2].replace(/^["']|["']$/g, "").replaceAll("&amp;", "&");
        const to = resolveFolderLink(plan, node, href);
        if (to.href) {
          const at = start + value.index + value[1].length;
          edits.push([at, at + value[2].length, `"${escAttr(to.href)}"`]);
        } else if (to.gone && tagName === "a") {
          // Outside the folder: the words stay, the link doesn't.
          edits.push([start, start + tag.length, ""]);
          const close = /<\/a\s*>$/i.exec(html.slice(start + tag.length, end));
          if (close) edits.push([end - close[0].length, end, ""]);
        }
      }
      visit(child);
    }
  };
  visit(root);
  let out = html;
  for (const [s, e, text] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, s) + text + out.slice(e);
  return out;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const INDEX_CSS =
  "body{margin:0;background:#fff;color:#15171c;font:15px/1.5 system-ui,-apple-system,sans-serif}" +
  "main{max-width:640px;margin:0 auto;padding:48px 16px 64px}" +
  "h1{margin:0 0 20px;font-size:24px;font-weight:600;line-height:1.25;overflow-wrap:anywhere}" +
  "ul{margin:0;padding:0;list-style:none}ul ul{margin:4px 0 8px;padding-left:16px;border-left:1px solid #e5e7eb}" +
  "li{margin:4px 0;overflow-wrap:anywhere}a{color:#15171c;text-decoration:none}a:hover{text-decoration:underline}" +
  ".folder{color:#6b7280;font-weight:500}.file{color:#6b7280}";

/** The site's generated front page: the folder's name and a nested list of what's in it. */
function folderIndexHtml(plan) {
  const list = (rows) =>
    "<ul>" +
    rows
      .map((r) => {
        if (r.kind === "folder") return `<li id="${esc(r.staged)}"><span class="folder">${esc(r.title)}</span>${list(r.children)}</li>`;
        const href = r.staged.split("/").map(encodeURIComponent).join("/") + (r.kind === "page" ? "/" : "");
        return `<li><a${r.kind === "file" ? ' class="file"' : ""} href="${esc(href)}">${esc(r.title)}</a></li>`;
      })
      .join("") +
    "</ul>";
  return withBadge(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(plan.name)}</title><style>${INDEX_CSS}</style></head>` +
      `<body><main><h1>${esc(plan.name)}</h1>${list(plan.rows)}</main></body></html>\n`,
  );
}

function assertNotEmpty(plan) {
  if (!plan.pages.length && !plan.files.length) throw new Error(`${plan.name} is empty, so there's nothing to publish.`);
}

/**
 * Stage a folder as one site in a temp folder: index.html, /_quire/ once, each page at
 * /<slugified relative path>/ and each plain file beside them. Returns {work, site, plan}.
 */
export async function stageFolder(vault, folderPath, plan = folderPlan(vault, folderPath)) {
  assertNotEmpty(plan);
  const id = crypto.createHash("sha1").update(vault + "\0" + plan.path).digest("hex").slice(0, 16);
  const work = path.join(os.tmpdir(), "quire-publish", "folder-" + id);
  const site = path.join(work, "site");
  await fsp.rm(site, { recursive: true, force: true });
  await fsp.mkdir(site, { recursive: true });
  if (plan.pages.length) await stageRuntime(site);
  for (const { node, staged } of plan.pages) {
    await stage(node, path.join(site, ...staged.split("/")), {
      badge: true,
      prefix: siteHref(staged) + "/",
      runtime: false,
      rewrite: (html) => rewriteFolderLinks(plan, node, html),
    });
  }
  for (const f of plan.files) {
    const to = path.join(site, ...f.staged.split("/"));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(f.abs, to);
  }
  await fsp.writeFile(path.join(site, "index.html"), folderIndexHtml(plan));
  return { work, site, plan };
}

/** Hash of what a folder publish is made from: its name, each page's fingerprint, each plain file. */
async function folderFingerprint(plan) {
  const h = crypto.createHash("sha1");
  h.update(plan.name + "\0");
  for (const { node, staged } of plan.pages) {
    h.update(staged + "\0" + (await publishFingerprintAsync(node.dir)) + "\0");
  }
  for (const f of plan.files) {
    h.update(f.staged + "\0");
    for await (const chunk of fs.createReadStream(f.abs)) h.update(chunk);
  }
  return h.digest("hex");
}

/** {public: record | null, upToDate}. Async: it hashes everything in the folder. */
export async function folderPublishStatus(vault, folderPath) {
  const norm = normPath(folderPath);
  const pub = readFolderRecords(vault)[norm] || null;
  if (!pub) return { public: null, upToDate: false };
  try {
    return { public: pub, upToDate: pub.fingerprint === (await folderFingerprint(folderPlan(vault, norm))) };
  } catch {
    return { public: pub, upToDate: false }; // the folder is gone or unreadable: the site is still up
  }
}

/**
 * Build every page that has a build, stage the folder and upload it to managed hosting as one site.
 * The first publish creates the site; later ones reuse the slug in the record. Returns {public, output}.
 * @param {{env: NodeJS.ProcessEnv}} opts
 */
export async function publishFolder(vault, folderPath, { env }) {
  const acct = await requireAccount();
  let plan = folderPlan(vault, folderPath);

  const failed = [];
  const buildLog = [];
  for (const node of plan.builds) {
    const b = await runBuild(node.dir, { env });
    if (!b.ok) {
      failed.push(node.path);
      buildLog.push(`--- ${node.path}\n${b.output}`);
    }
  }
  if (failed.length) {
    throw Object.assign(new Error(`The build failed for ${failed.join(", ")}, so nothing was published.`), { output: buildLog.join("\n"), failed });
  }
  plan = folderPlan(vault, plan.path); // a build can write the entry a page was missing
  assertNotEmpty(plan);

  // Don't copy a folder with a 2 GB video in it just to say it's too big.
  let plainBytes = 0;
  for (const f of plan.files) plainBytes += (await fsp.stat(f.abs)).size;
  await assertSiteFits({ noun: "folder", files: plan.files.length, bytes: plainBytes });

  const fingerprint = await folderFingerprint(plan);
  const prev = readFolderRecords(vault)[plan.path];
  const { work, site } = await stageFolder(vault, plan.path, plan);
  try {
    const r = await uploadSite(site, { acct, title: plan.name, slug: prev?.slug || null, noun: "folder" });
    const record = { host: "quire", slug: r.slug, url: r.url, fingerprint, updatedAt: new Date().toISOString() };
    writeFolderRecords(vault, { ...readFolderRecords(vault), [plan.path]: record });
    const log = plan.skipped.length ? [`Left out (no entry file yet): ${plan.skipped.join(", ")}`, r.output] : [r.output];
    return { public: record, output: log.join("\n") };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Take the folder's site down (gone already counts) and forget it. */
export async function unpublishFolder(vault, folderPath, _opts = {}) {
  const norm = normPath(folderPath);
  const records = readFolderRecords(vault);
  if (!records[norm]) return null;
  if (records[norm].slug) await deleteSite(records[norm].slug);
  delete records[norm];
  writeFolderRecords(vault, records);
  return null;
}
